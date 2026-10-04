import { execFile } from "node:child_process";
import { errorMessage } from "../../errors.js";
import { RpcError } from "../rpc.js";
import type { EventSink, HistoryTurn, ProbeResult, ProviderAdapter, ProviderSession, StartOptions } from "../types.js";
import type { AcpSessionHandler } from "./acp-server.js";
import { CursorAcpServer } from "./acp-server.js";
import { resolveCursorCommand, type CursorCommand } from "./command.js";
import { buildHistoryTurns } from "./history.js";
import type {
  CursorMode,
  SessionLoadParams,
  SessionLoadResponse,
  SessionNewParams,
  SessionNewResponse,
  SessionSetModelParams,
  SessionSetModeParams,
  SessionUpdateNotification,
} from "./protocol.js";
import { CursorAcpSession } from "./session.js";

export interface CursorProviderOptions {
  /** How to launch cursor-agent. Defaults to the user's install found on PATH; null means none. */
  command?: CursorCommand | null;
  /**
   * A `session/new` response's own `models.availableModels[].modelId` (e.g.
   * `"claude-sonnet-5[thinking=true,context=300k,effort=high]"`), applied with
   * session/set_model right after a session opens. Leave unset to use the account's
   * default (whatever `models.currentModelId` already is — "Auto" unless changed with
   * `cursor-agent --model` or in Cursor's own settings).
   */
  model?: string;
  /**
   * Applied with session/set_mode right after a session opens, the same way `model` is.
   * "plan" (read-only planning) or "ask" (Q&A, no edits or commands) give new Cursor
   * sessions the same kind of safer-by-default posture Claude's `permissionMode: "plan"`
   * does; leave unset for the account's own default ("agent" unless changed elsewhere).
   */
  mode?: CursorMode;
  /** How long interrupt() waits for session/cancel to actually end the turn before giving
   *  up on it (session.ts's own INTERRUPT_TIMEOUT_MS). Tests shorten this instead of
   *  waiting out the real 10s. */
  interruptTimeoutMs?: number;
}

// A good status is kept a minute; a bad one is re-checked soon, matching Claude's and Codex's own probes.
const READY_TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Drives `cursor-agent` through its Agent Client Protocol server (`cursor-agent acp`). The
 * host never touches Cursor credentials: the process uses whatever `cursor-agent login`
 * stored on this machine (ACP's own `authenticate` step just points at that).
 *
 * Resumable, unlike this adapter's first cut: reconnecting with session/load replays a
 * session's whole history back down the same session/update channel a live turn uses, with
 * no marker in the wire format to tell replay apart from something actually happening — but
 * measured by hand, every replay notification arrives before session/load's own response
 * does, and calling session/load twice in a row for the same id replays cleanly both times
 * and leaves the session just as usable afterward. So start()'s own resume registers the
 * session before sending session/load and drops notifications until that response lands
 * (CursorAcpSession's `replaying`), and history() does a second, throwaway session/load
 * purely to collect that same replay into HistoryTurn[] (history.ts) before start() ever
 * runs. Two loads per resume rather than one, but neither is a turn — there is no cheaper
 * "just tell me what happened" query in ACP the way Codex has thread/turns/list.
 */
export class CursorProvider implements ProviderAdapter {
  readonly id = "cursor";
  readonly kind = "agent" as const;
  readonly label = "Cursor";
  readonly resumable = true;
  readonly #options: CursorProviderOptions;
  #server: Promise<CursorAcpServer> | null = null;
  #probe: { until: number; status: ProbeResult } | null = null;

  constructor(options: CursorProviderOptions = {}) {
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
      // Should never happen (the manager only resumes a session it isn't already holding
      // live), but register() has no way to tell "already mine" from "steal it": if this
      // id is somehow still claimed, fail loudly rather than hijack whatever owns it.
      if (server.has(sessionId)) throw new Error(`cursor session ${sessionId} is already open on this host`);
      // Registered before session/load is even sent: replay notifications carry this same
      // sessionId, and CursorAcpSession starts in `replaying` mode so it drops them instead
      // of reporting a resumed conversation's whole past as things that just happened.
      const session = new CursorAcpSession(server, sessionId, sink, options.cwd, {
        replaying: true,
        interruptTimeoutMs: this.#options.interruptTimeoutMs,
      });
      server.register(sessionId, session);
      try {
        const params: SessionLoadParams = { sessionId, cwd: options.cwd, mcpServers: [] };
        const loaded = await server.peer.request<SessionLoadResponse>("session/load", params);
        await this.#applySettings(server, sessionId);
        this.#reportModel(sink, loaded?.models?.currentModelId);
      } catch (err) {
        server.unregister(sessionId);
        throw err;
      }
      session.endReplay();
      sink.setProviderSessionId(sessionId);
      return session;
    }
    const params: SessionNewParams = { cwd: options.cwd, mcpServers: [] };
    const { sessionId, models } = await server.peer.request<SessionNewResponse>("session/new", params);
    await this.#applySettings(server, sessionId);
    this.#reportModel(sink, models?.currentModelId);
    const session = new CursorAcpSession(server, sessionId, sink, options.cwd, {
      interruptTimeoutMs: this.#options.interruptTimeoutMs,
    });
    server.register(sessionId, session);
    sink.setProviderSessionId(sessionId);
    return session;
  }

  /**
   * session/set_model and session/set_mode, each only when configured — both live-verified:
   * a session set to "claude-haiku-4-5" answered "which model are you" as Claude Haiku 4.5,
   * and session/set_mode fired its own current_mode_update right back. Applied before the
   * session is handed back so the very first turn already uses them, on a fresh session and
   * a resumed one alike.
   */
  /**
   * Which model this session is actually on, for SessionInfo.model.
   *
   * A configured one wins over what the reply said: #applySettings has just
   * switched the session onto it with session/set_model, so the reply's
   * `currentModelId` is already out of date by the time this runs. With
   * nothing configured the reply is the answer — the account's own default,
   * "Auto" unless it was changed elsewhere.
   *
   * Silent when neither is known. An older cursor-agent that does not report
   * `models` should leave the model blank rather than have this guess.
   */
  #reportModel(sink: EventSink, reported: string | undefined): void {
    const model = this.#options.model ?? reported;
    if (model) sink.setModel(model);
  }

  async #applySettings(server: CursorAcpServer, sessionId: string): Promise<void> {
    // Two independent session settings — nothing about one needs the other to have already
    // landed, so both go out together rather than paying two round trips in series.
    await Promise.all([
      this.#options.model
        ? server.peer.request("session/set_model", { sessionId, modelId: this.#options.model } satisfies SessionSetModelParams)
        : undefined,
      this.#options.mode
        ? server.peer.request("session/set_mode", { sessionId, modeId: this.#options.mode } satisfies SessionSetModeParams)
        : undefined,
    ]);
  }

  /**
   * Reads a session's past turns without resuming it: a throwaway session/load whose only
   * job is to collect the replay it fires before resolving (see the class's own note), then
   * let go of the session again. `cwd` only matters if cursor-agent were to complain about
   * a workspace mismatch; it hasn't, in the one case this was checked against.
   */
  async history(providerSessionId: string, cwd: string): Promise<HistoryTurn[]> {
    const server = await this.#getServer();
    // Same reasoning as start()'s own check: manager.ts only ever calls history() for a
    // session it is not already holding live, but register() below would silently steal
    // that session's notifications out from under it if it somehow were.
    if (server.has(providerSessionId)) throw new Error(`cursor session ${providerSessionId} is already open on this host`);
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

  #command(): CursorCommand | null {
    return this.#options.command === undefined ? resolveCursorCommand() : this.#options.command;
  }

  #getServer(): Promise<CursorAcpServer> {
    if (!this.#server) {
      const command = this.#command();
      if (!command) return Promise.reject(new Error("cursor-agent was not found on PATH"));
      const starting = CursorAcpServer.start(command, () => {
        if (this.#server === starting) this.#server = null;
      });
      starting.catch(() => {
        if (this.#server === starting) this.#server = null;
      });
      this.#server = starting;
    }
    return this.#server;
  }

  async #runProbe(): Promise<ProbeResult> {
    const command = this.#command();
    if (!command) return { available: false, version: null, detail: "cursor-agent was not found on PATH" };
    // Neither reads the other's result, so both go out together — the common case (both
    // succeed) is one round trip's worth of latency instead of two in series; a broken
    // cursor-agent just costs one wasted spawn instead of skipping the second entirely.
    const [version, status] = await Promise.all([run(command, ["--version"]), run(command, ["status", "--format", "json"])]);
    if (!version.ok) return { available: false, version: null, detail: `cursor-agent failed to run: ${version.output}` };
    const auth = parseStatus(status.output);
    if (!auth) {
      const why = status.ok ? "unexpected output" : status.output || "no answer";
      return { available: false, version: version.output || null, detail: `could not check the Cursor login (${why})` };
    }
    return {
      available: auth.loggedIn,
      version: version.output || null,
      detail: auth.loggedIn
        ? `Logged in${auth.email ? ` (${auth.email})` : ""}`
        : "not logged in: run `cursor-agent login` on this machine",
    };
  }
}

function parseStatus(output: string): { loggedIn: boolean; email: string | null } | null {
  try {
    const status = JSON.parse(output) as { isAuthenticated?: unknown; userInfo?: { email?: unknown } };
    if (typeof status.isAuthenticated !== "boolean") return null;
    return { loggedIn: status.isAuthenticated, email: typeof status.userInfo?.email === "string" ? status.userInfo.email : null };
  } catch {
    return null;
  }
}

function run(command: CursorCommand, args: string[]): Promise<{ ok: boolean; output: string }> {
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
