import { execFile } from "node:child_process";
import { errorMessage } from "../../errors.js";
import type { EventSink, HistoryTurn, ProbeResult, ProviderAdapter, ProviderSession, StartOptions } from "../types.js";
import { CodexAppServer } from "./app-server.js";
import { resolveCodexCommand, type CodexCommand } from "./command.js";
import { codexHistory } from "./history.js";
import type { AskForApproval, GetAccountRateLimitsResponse, SandboxMode, ThreadResumeParams, ThreadStartParams, ThreadStartResponse } from "./protocol.js";
import { CodexThreadSession } from "./session.js";

export interface CodexProviderOptions {
  /** How to launch codex. Defaults to the user's install found on PATH; null means none. */
  command?: CodexCommand | null;
  /** Leave unset to use the user's ~/.codex/config.toml. */
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
}

// A good status is kept a minute; a bad one is re-checked soon, since a slow first run
// can time out once.
const READY_TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Drives Codex through `codex app-server`. The host never touches Codex credentials:
 * the app-server uses whatever `codex login` stored on this machine.
 */
export class CodexProvider implements ProviderAdapter {
  readonly id = "codex";
  readonly kind = "agent" as const;
  readonly label = "Codex";
  readonly resumable = true;
  readonly steer = true;
  readonly compact = true;
  readonly #options: CodexProviderOptions;
  #server: Promise<CodexAppServer> | null = null;
  #probe: { until: number; status: ProbeResult } | null = null;

  constructor(options: CodexProviderOptions = {}) {
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
    const params: ThreadStartParams = {
      cwd: options.cwd,
      ...(this.#options.approvalPolicy ? { approvalPolicy: this.#options.approvalPolicy } : {}),
      ...(this.#options.sandbox ? { sandbox: this.#options.sandbox } : {}),
    };
    // `model` was being destructured away here, and it is the only place Codex
    // ever says which model the thread runs on — there is no /status to ask
    // later, because this is the app-server protocol and not the interactive
    // CLI, where a slash command would just be sent to the model as text.
    const { thread, model } = options.resumeProviderSessionId
      ? await server.peer.request<ThreadStartResponse>("thread/resume", {
          ...params,
          threadId: options.resumeProviderSessionId,
          excludeTurns: true,
        } satisfies ThreadResumeParams)
      : await server.peer.request<ThreadStartResponse>("thread/start", params);
    const session = new CodexThreadSession(server, thread.id, sink);
    server.register(thread.id, session);
    sink.setProviderSessionId(thread.id);
    if (model) sink.setModel(model);
    // The plan's usage, once, now. The pushes (account/rateLimits/updated)
    // only arrive when something moves, so a session opened in the middle of
    // a window would show nothing at all until its first turn finished.
    // Fire-and-forget: an account read that fails is a missing gauge, not a
    // reason to refuse to open the session.
    void server.peer
      .request<GetAccountRateLimitsResponse>("account/rateLimits/read", {})
      .then((res) => session.applyRateLimits(res?.rateLimits))
      .catch(() => {});
    return session;
  }

  /** Reads the thread's stored turns without resuming it. */
  async history(threadId: string): Promise<HistoryTurn[]> {
    return codexHistory(await this.#getServer(), threadId);
  }

  async dispose(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server) (await server.catch(() => null))?.close();
  }

  #command(): CodexCommand | null {
    return this.#options.command === undefined ? resolveCodexCommand() : this.#options.command;
  }

  #getServer(): Promise<CodexAppServer> {
    if (!this.#server) {
      const command = this.#command();
      if (!command) return Promise.reject(new Error("codex was not found on PATH"));
      const starting = CodexAppServer.start(command, () => {
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
    if (!command) {
      return { available: false, version: null, detail: "codex was not found on PATH" };
    }
    const version = await run(command, ["--version"]);
    if (!version.ok) {
      return { available: false, version: null, detail: `codex failed to run: ${version.output}` };
    }
    const versionText = version.output.split(/\s+/).at(-1) ?? null;
    const login = await run(command, ["login", "status"]);
    const loggedIn = /logged in/i.test(login.output) && !/not logged in/i.test(login.output);
    if (loggedIn) {
      return { available: true, version: versionText, detail: login.output.split(/\r?\n/)[0] ?? null };
    }
    // Only an explicit "not logged in" means logged out; anything else is a failed check.
    return {
      available: false,
      version: versionText,
      detail: /not logged in/i.test(login.output)
        ? "not logged in: run `codex login` on this machine"
        : `could not check the Codex login (${login.output || "no answer"})`,
    };
  }
}

function run(command: CodexCommand, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command.file,
      [...command.args, ...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        resolve({ ok: !err, output: err && !output ? errorMessage(err) : output });
      },
    );
  });
}
