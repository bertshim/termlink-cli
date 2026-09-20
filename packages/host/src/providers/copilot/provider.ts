import { execFile } from "node:child_process";
import { errorMessage } from "../../errors.js";
import { RpcError } from "../rpc.js";
import type { EventSink, HistoryTurn, ProbeResult, ProviderAdapter, ProviderSession, StartOptions } from "../types.js";
import type { AcpSessionHandler } from "./acp-server.js";
import { CopilotAcpServer } from "./acp-server.js";
import { resolveCopilotCommand, type CopilotCommand } from "./command.js";
import { buildHistoryTurns } from "./history.js";
import type { SessionLoadParams, SessionLoadResponse, SessionNewParams, SessionNewResponse, SessionUpdateNotification } from "./protocol.js";
import { CopilotAcpSession } from "./session.js";

export interface CopilotProviderOptions {
  /** How to launch copilot. Defaults to the user's install found on PATH; null means none. */
  command?: CopilotCommand | null;
  /** How long interrupt() waits for session/cancel to actually end the turn before giving
   *  up on it (session.ts's own INTERRUPT_TIMEOUT_MS). Tests shorten this instead of
   *  waiting out the real 10s. */
  interruptTimeoutMs?: number;
}

// A good status is kept a minute; a bad one is re-checked soon, matching the other providers' own probes.
const READY_TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Drives `copilot` (GitHub Copilot CLI) through its Agent Client Protocol server
 * (`copilot --acp`). The host never touches Copilot credentials: the process uses whatever
 * `copilot login` already stored (system credential store, or one of the token env vars
 * `copilot login --help` documents).
 *
 * Resumable the same way cursor/provider.ts's own CursorProvider is, for the same measured
 * reason: session/load replays a session's whole history before its own response resolves
 * (re-measured here against Copilot specifically, with the same result), so start()'s resume
 * drops notifications until that response lands and history() does a second, throwaway
 * session/load purely to collect that replay into HistoryTurn[].
 *
 * Not model- or mode-selectable yet, unlike Cursor: Copilot's own mode ids are full ACP-spec
 * URLs (`https://agentclientprotocol.com/protocol/session-modes#plan`) rather than Cursor's
 * plain strings, and how a model gets set was not checked — left for whoever needs it next.
 */
export class CopilotProvider implements ProviderAdapter {
  readonly id = "copilot";
  readonly kind = "agent" as const;
  readonly label = "Copilot";
  readonly resumable = true;
  readonly #options: CopilotProviderOptions;
  #server: Promise<CopilotAcpServer> | null = null;
  #probe: { until: number; status: ProbeResult } | null = null;

  constructor(options: CopilotProviderOptions = {}) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    if (this.#probe && Date.now() < this.#probe.until) return this.#probe.status;
    const status = await this.#runProbe();
    this.#probe = { until: Date.now() + (status.available ? READY_TTL_MS : UNAVAILABLE_TTL_MS), status };
    return status;
  }

  async start(options: StartOptions, sink: EventSink): Promise<ProviderSession> {
    const server = await this.#getServer();
    if (options.resumeProviderSessionId) {
      const sessionId = options.resumeProviderSessionId;
      if (server.has(sessionId)) throw new Error(`copilot session ${sessionId} is already open on this host`);
      const session = new CopilotAcpSession(server, sessionId, sink, options.cwd, {
        replaying: true,
        interruptTimeoutMs: this.#options.interruptTimeoutMs,
      });
      server.register(sessionId, session);
      try {
        const params: SessionLoadParams = { sessionId, cwd: options.cwd, mcpServers: [] };
        await server.peer.request<SessionLoadResponse>("session/load", params);
      } catch (err) {
        server.unregister(sessionId);
        throw err;
      }
      session.endReplay();
      sink.setProviderSessionId(sessionId);
      return session;
    }
    const params: SessionNewParams = { cwd: options.cwd, mcpServers: [] };
    const { sessionId } = await server.peer.request<SessionNewResponse>("session/new", params);
    const session = new CopilotAcpSession(server, sessionId, sink, options.cwd, {
      interruptTimeoutMs: this.#options.interruptTimeoutMs,
    });
    server.register(sessionId, session);
    sink.setProviderSessionId(sessionId);
    return session;
  }

  /** Reads a session's past turns without resuming it — see the class's own note on why
   *  this is a second session/load rather than a cheaper dedicated query. */
  async history(providerSessionId: string, cwd: string): Promise<HistoryTurn[]> {
    const server = await this.#getServer();
    if (server.has(providerSessionId)) throw new Error(`copilot session ${providerSessionId} is already open on this host`);
    const updates: SessionUpdateNotification["update"][] = [];
    const collector: AcpSessionHandler = {
      notification: (method, params) => {
        if (method === "session/update") updates.push((params as SessionUpdateNotification).update);
      },
      request: async (method) => {
        throw new RpcError(-32601, `${method} has no live session to answer it during history replay`);
      },
      closed: () => {},
    };
    server.register(providerSessionId, collector);
    try {
      const params: SessionLoadParams = { sessionId: providerSessionId, cwd, mcpServers: [] };
      await server.peer.request<SessionLoadResponse>("session/load", params);
    } finally {
      server.unregister(providerSessionId);
    }
    return buildHistoryTurns(updates, cwd);
  }

  async dispose(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server) (await server.catch(() => null))?.close();
  }

  #command(): CopilotCommand | null {
    return this.#options.command === undefined ? resolveCopilotCommand() : this.#options.command;
  }

  #getServer(): Promise<CopilotAcpServer> {
    if (!this.#server) {
      const command = this.#command();
      if (!command) return Promise.reject(new Error("copilot was not found on PATH"));
      const starting = CopilotAcpServer.start(command, () => {
        if (this.#server === starting) this.#server = null;
      });
      starting.catch(() => {
        if (this.#server === starting) this.#server = null;
      });
      this.#server = starting;
    }
    return this.#server;
  }

  /**
   * Unlike cursor-agent (`status --format json`) or claude/codex (`auth status`/`login
   * status`), the Copilot CLI has no dedicated command that answers "is this logged in?"
   * without starting a real session. So the probe does exactly what start() is about to do
   * anyway: bring up the shared acp-server (or reuse it if a session already did) and let
   * initialize+authenticate answer for real, on the assumption — not directly checked, since
   * doing so meant logging this machine's own Copilot out — that authenticate() rejects when
   * `copilot login` never ran, the same way a real login is required for anything else here.
   */
  async #runProbe(): Promise<ProbeResult> {
    const command = this.#command();
    if (!command) return { available: false, version: null, detail: "copilot was not found on PATH" };
    const version = await run(command, ["--version"]);
    if (!version.ok) return { available: false, version: null, detail: `copilot failed to run: ${version.output}` };
    // "GitHub Copilot CLI 1.0.86.\nRun 'copilot update' to check for updates." — only the
    // first line is the version; the second is unconditional nag, not a version.output detail.
    const versionText = version.output.split(/\r?\n/)[0] || null;
    try {
      await this.#getServer();
      return { available: true, version: versionText, detail: "Logged in" };
    } catch (err) {
      return {
        available: false,
        version: versionText,
        detail: `not logged in: run \`copilot login\` on this machine (${errorMessage(err)})`,
      };
    }
  }
}

function run(command: CopilotCommand, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command.file,
      [...command.args, ...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: command.shell },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        resolve({ ok: !err, output: err && !output ? errorMessage(err) : output });
      },
    );
  });
}
