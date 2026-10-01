import os from "node:os";
import { FrameAssembler, RELAY_FRAME_BYTES, encodeFrames, type HostInfo, type HostMessage } from "@termlink/protocol";
import { WebSocket } from "ws";
import { errorMessage } from "../errors.js";
import { DeltaCoalescer } from "../server/coalesce.js";
import { ClientConnection } from "../server/connection.js";
import { toBytes } from "../server/local-server.js";
import type { SessionManager } from "../session/manager.js";
import { newId } from "../util/id.js";
import { TRACE, traceNow, traceSent } from "../util/trace.js";
import { RelayHttpError, pickRelay, registerHost, unregisterHost, type Fetch } from "./api.js";
import { DeviceError, defaultCredentialPath, loadDevice, renewIfDue } from "./device.js";

export const DEFAULT_SERVER = "wss://connect.getterm.link:9000";

export interface RelayHostOptions {
  manager: SessionManager;
  hostInfo: () => Promise<HostInfo>;
  /** Master relay. */
  server: string;
  /** Relay session name. One per host process; every agent session travels inside it. */
  session: string;
  name?: string;
  /** Shown in the host list; the first allowed root is a good value. */
  cwd?: string;
  credentialPath?: string;
  fetch?: Fetch;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingIntervalMs?: number;
  /** Connection details as they happen, for --verbose. They name relay addresses. */
  log?: (line: string) => void;
  /**
   * The connection as a person needs it: "connected" once a socket is open, "disconnected"
   * when one drops and a reconnect is under way, "stopped" when it has ended for good.
   * Carries no addresses.
   */
  onStatus?: (status: "connected" | "disconnected" | "stopped") => void;
  /** The relay connection ended for good: the session was ended from the account, or sign-in is needed. */
  onStopped?: (reason: string) => void;
}

const PONG_TIMEOUT_MS = 60_000;
/**
 * Well under PONG_TIMEOUT_MS, and not just barely: a real user's host saw connections die at
 * almost exactly the 60s mark, repeatedly, over more than a week — the signature of a NAT or
 * proxy evicting an idle-looking connection around then. Three ping/pong round-trips inside the
 * deadline (instead of two at the old 25s) means a single dropped packet no longer costs the
 * whole connection. The relay pings hosts on a shorter period for the same reason.
 */
const DEFAULT_PING_INTERVAL_MS = 15_000;

interface Live {
  ws: WebSocket;
  connection: ClientConnection;
  coalescer: DeltaCoalescer;
  heartbeat: NodeJS.Timeout;
}

/**
 * Connects the host to the TermLink relay as `role=host&caps=agent`. The relay
 * merges every client into this one socket and broadcasts what the host sends,
 * so the whole relay link is served by a single ClientConnection.
 */
export class RelayHost {
  readonly relayUrl: string;
  /** Resolves on the first successful connection. */
  readonly ready: Promise<void>;
  readonly #options: RelayHostOptions;
  readonly #fetch: Fetch;
  readonly #deviceToken: string;
  #hostToken: string | null = null;
  #live: Live | null = null;
  #socket: WebSocket | null = null;
  #backoffMs: number;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #lastLogged = "";
  #markReady: () => void = () => {};

  private constructor(options: RelayHostOptions, relayUrl: string, deviceToken: string, fetchFn: Fetch) {
    this.#options = options;
    this.relayUrl = relayUrl;
    this.#deviceToken = deviceToken;
    this.#fetch = fetchFn;
    this.#backoffMs = options.minBackoffMs ?? 1_000;
    this.ready = new Promise((resolve) => (this.#markReady = resolve));
  }

  /** Signs in with the device credential, registers the session and starts connecting. */
  static async start(options: RelayHostOptions): Promise<RelayHost> {
    const fetchFn = options.fetch ?? fetch;
    const credentialPath = options.credentialPath ?? defaultCredentialPath();
    let device = await loadDevice(credentialPath, options.server);
    device = await renewIfDue(credentialPath, options.server, device, fetchFn);
    const relayUrl = await pickRelay(options.server, fetchFn);
    const host = new RelayHost(options, relayUrl, device.token, fetchFn);
    await host.#register();
    host.#connect();
    return host;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#teardown();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, "host shutting down");
    if (this.#hostToken) {
      await unregisterHost(this.#options.server, this.#hostToken, this.#options.session, this.#fetch).catch(() => {});
    }
  }

  async #register(): Promise<void> {
    try {
      this.#hostToken = await registerHost(this.#options.server, this.#deviceToken, this.#options.session, this.#fetch);
    } catch (err) {
      // 401/403 is a sign-in problem or the plan's session limit; retrying will not help.
      if (err instanceof RelayHttpError && (err.status === 401 || err.status === 403)) {
        throw new DeviceError(`the relay refused this host: ${err.message}`);
      }
      throw err;
    }
  }

  #connect(): void {
    this.#reconnectTimer = null;
    if (this.#stopped) return;
    this.#dial().catch((err: unknown) => {
      if (err instanceof DeviceError) this.#stop(err.message);
      else {
        this.#log(`relay: ${errorMessage(err)}`);
        this.#scheduleReconnect();
      }
    });
  }

  async #dial(): Promise<void> {
    if (!this.#hostToken) await this.#register();
    const query = new URLSearchParams({
      session: this.#options.session,
      role: "host",
      token: this.#hostToken ?? "",
      name: this.#options.name ?? os.hostname(),
      term: "termlink-agent",
      cwd: this.#options.cwd ?? process.cwd(),
      os: process.platform,
      arch: process.arch,
      relay: this.relayUrl,
      caps: "agent",
    });
    const ws = new WebSocket(`${this.relayUrl}/ws?${query}`, { handshakeTimeout: 15_000 });
    this.#socket = ws;
    ws.on("error", (err) => {
      // A rejected host token (expired, or signed with an old relay secret): register again.
      const status = /Unexpected server response: (\d+)/.exec(err.message)?.[1];
      if (status === "401" || status === "403") this.#hostToken = null;
      this.#log(`relay: ${err.message}`);
    });
    // Only a socket that opened can be lost; a dial that never got through is just retried.
    let opened = false;
    ws.on("open", () => {
      opened = true;
      this.#backoffMs = this.#options.minBackoffMs ?? 1_000;
      this.#lastLogged = "";
      this.#log(`relay: connected to ${this.relayUrl} as ${this.#options.session}`);
      this.#serve(ws);
      this.#markReady();
      this.#options.onStatus?.("connected");
    });
    ws.on("close", (code, reason) => {
      if (this.#socket === ws) {
        this.#teardown();
        this.#socket = null;
      }
      if (this.#stopped) return;
      this.#log(`relay: disconnected (${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}), reconnecting`);
      if (opened) this.#options.onStatus?.("disconnected");
      this.#scheduleReconnect();
    });
  }

  #serve(ws: WebSocket): void {
    const coalescer = new DeltaCoalescer((message) => this.#write(ws, message));
    const connection = new ClientConnection(
      this.#options.manager,
      {
        send: (message) => coalescer.push(message),
        sendBinary: (frame) => {
          // Keep terminal bytes in order with the JSON events around them.
          coalescer.flush();
          if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
        },
      },
      this.#options.hostInfo,
    );
    const assembler = new FrameAssembler();
    let clients = -1;
    let lastPong = Date.now();

    ws.on("pong", () => (lastPong = Date.now()));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        connection.handleBinary(toBytes(data));
        return;
      }
      const receivedAt = TRACE ? traceNow() : undefined;
      let message: unknown;
      try {
        message = assembler.push(data.toString());
      } catch {
        return;
      }
      if (message === undefined) return;
      if (!isRelayControl(message)) {
        void connection.handleMessage(message, receivedAt);
        return;
      }
      if (message.type === "clients") {
        // Greet newly joined clients; everyone else just sees host.ready again.
        const count = Array.isArray(message.clients) ? message.clients.length : 0;
        if (count > clients && clients >= 0) void connection.announce();
        clients = count;
      } else if (message.type === "terminated") {
        this.#stop(typeof message.reason === "string" ? message.reason : "the session was ended");
      }
    });

    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > PONG_TIMEOUT_MS) ws.terminate();
      else ws.ping();
    }, this.#options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);

    this.#live = { ws, connection, coalescer, heartbeat };
    void connection.open();
  }

  #write(ws: WebSocket, message: HostMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const frame of encodeFrames(message, RELAY_FRAME_BYTES, () => newId("ck"))) ws.send(frame);
    if (TRACE) traceSent(message);
  }

  #teardown(): void {
    const live = this.#live;
    this.#live = null;
    if (!live) return;
    clearInterval(live.heartbeat);
    live.coalescer.dispose();
    live.connection.dispose();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#options.maxBackoffMs ?? 30_000);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #stop(reason: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#log(`relay: stopped: ${reason}`);
    this.#options.onStatus?.("stopped");
    this.#teardown();
    this.#socket?.close(1000, "host stopped");
    this.#options.onStopped?.(reason);
  }

  // Reconnect loops repeat the same failure; log each distinct message once.
  #log(line: string): void {
    if (line === this.#lastLogged) return;
    this.#lastLogged = line;
    this.#options.log?.(line);
  }
}

function isRelayControl(message: unknown): message is { type: string; [field: string]: unknown } {
  return (
    typeof message === "object" &&
    message !== null &&
    !("kind" in message) &&
    "type" in message &&
    typeof message.type === "string"
  );
}

/** Relay session name for this machine: stable, so a restarted host takes its slot back. */
export function defaultRelaySession(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
  return `${host}-agent`;
}
