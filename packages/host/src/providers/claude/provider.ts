import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isSea } from "node:sea";
import { getSessionMessages, query, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "../../errors.js";
import { findOnPath } from "../../util/which.js";
import type { EventSink, HistoryTurn, ProbeResult, ProviderAdapter, ProviderSession, StartOptions } from "../types.js";
import { claudeHistory, type TranscriptMessage } from "./history.js";
import { ClaudeSession, type QueryFn } from "./session.js";

/** Modes a remote user may run under. bypassPermissions is deliberately not offered. */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "auto"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number] & PermissionMode;

export type HistoryFn = (sessionId: string, options: { dir: string }) => Promise<TranscriptMessage[]>;

export interface ClaudeProviderOptions {
  /** Claude Code executable. Defaults to resolveClaudeExecutable(); null means none. */
  executable?: string | null;
  model?: string;
  /** Leave unset to use the user's Claude Code settings. */
  permissionMode?: ClaudePermissionMode;
  /** Replaces the SDK's query() in tests. */
  queryFn?: QueryFn;
  /** How long Stop waits for Claude Code to end the turn before the process is restarted on the same session. */
  interruptTimeoutMs?: number;
  /** Waits before each resend of a turn that failed on the login-refresh race (see ClaudeSession); tests shorten them. */
  authRetryDelaysMs?: readonly number[];
  /** How long past a usage limit's own reset the auto-retry waits (see ClaudeSession, rate-limit.ts); tests shorten it. */
  limitRetryAfterResetMs?: number;
  /** Replaces the SDK's getSessionMessages() in tests. */
  historyFn?: HistoryFn;
  /** Read for apiKeyAuth() in probe(); tests inject one instead of the host's own process.env. */
  env?: NodeJS.ProcessEnv;
}

// A good status is kept a minute. A bad one is re-checked soon: the first run of a
// freshly installed 220 MB binary can be slow enough to time out once.
const READY_TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Drives Claude Code through the Claude Agent SDK. The host never handles Claude
 * credentials: the Claude Code process uses whatever login the user made with `claude`.
 */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = "claude";
  readonly kind = "agent" as const;
  readonly label = "Claude";
  readonly resumable = true;
  readonly steer = true;
  readonly #options: ClaudeProviderOptions;
  #probe: { until: number; status: ProbeResult } | null = null;

  constructor(options: ClaudeProviderOptions = {}) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    if (this.#probe && Date.now() < this.#probe.until) return this.#probe.status;
    const status = await this.#runProbe();
    this.#probe = { until: Date.now() + (status.available ? READY_TTL_MS : UNAVAILABLE_TTL_MS), status };
    return status;
  }

  async start(options: StartOptions, sink: EventSink): Promise<ProviderSession> {
    // The probe and the session use the same binary; the SDK's own lookup does not work
    // from a bundle or a single executable, so the path is always passed explicitly.
    const executable = this.#executable();
    if (!executable) throw new Error("Claude Code was not found: install it or set TERMLINK_CLAUDE_PATH");
    const session = new ClaudeSession(sink, {
      traceId: options.sessionId,
      cwd: options.cwd,
      resume: options.resumeProviderSessionId,
      chrome: options.chrome,
      model: this.#options.model,
      permissionMode: this.#options.permissionMode,
      executable,
      queryFn: this.#options.queryFn ?? query,
      interruptTimeoutMs: this.#options.interruptTimeoutMs,
      authRetryDelaysMs: this.#options.authRetryDelaysMs,
      limitRetryAfterResetMs: this.#options.limitRetryAfterResetMs,
    });
    sink.setProviderSessionId(session.sessionId);
    return session;
  }

  /** Reads the session's transcript from ~/.claude/projects, as Claude Code itself stores it. */
  async history(sessionId: string, cwd: string): Promise<HistoryTurn[]> {
    const read: HistoryFn = this.#options.historyFn ?? ((id, opts) => getSessionMessages(id, opts));
    return claudeHistory(await read(sessionId, { dir: cwd }), cwd);
  }

  #executable(): string | null {
    return this.#options.executable !== undefined ? this.#options.executable : resolveClaudeExecutable();
  }

  async #runProbe(): Promise<ProbeResult> {
    const executable = this.#executable();
    if (!executable) return { available: false, version: null, detail: "Claude Code was not found" };
    const version = await run(executable, ["--version"]);
    if (!version.ok) {
      return { available: false, version: null, detail: `claude failed to run: ${version.output}` };
    }
    const versionText = version.output.split(/\s+/)[0] ?? null;
    // Only loggedIn and authMethod are read; the rest of the status (account details) stays here.
    const authRun = await run(executable, ["auth", "status"]);
    const auth = parseAuthStatus(authRun.output);
    if (!auth) {
      // No answer is not the same as "logged out"; say which one it was.
      const why = authRun.ok ? "unexpected output" : authRun.output || "no answer";
      return { available: false, version: versionText, detail: `could not check the Claude login (${why})` };
    }
    if (auth.loggedIn) {
      return { available: true, version: versionText, detail: `Logged in${auth.method ? ` (${auth.method})` : ""}` };
    }
    // `claude auth status` only ever reports the OAuth /login credential — a machine
    // running Claude Code entirely off an API key or a cloud provider's own credentials
    // (screen reads "API Usage Billing" instead of a plan name) genuinely works and still
    // gets loggedIn:false here, which used to read as "not logged in" even though nothing
    // is actually wrong. Claude Code's own credential precedence below /login, checked in
    // the same order (apiKeyAuth's own doc comment).
    const apiKey = apiKeyAuth(this.#options.env ?? process.env);
    if (apiKey) return { available: true, version: versionText, detail: `Logged in (${apiKey})` };
    return { available: false, version: versionText, detail: "not logged in: run `claude` on this machine and log in" };
  }
}

/**
 * Which Claude Code to run, in order: TERMLINK_CLAUDE_PATH; a claude binary next to the
 * termlink-node executable (single-executable builds); the one bundled with the Agent SDK
 * (npm installs, version-matched to the SDK); the user's `claude` on PATH.
 */
export function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env, singleExecutable = isSea()): string | null {
  if (env.TERMLINK_CLAUDE_PATH) return env.TERMLINK_CLAUDE_PATH;
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  if (singleExecutable) {
    const beside = path.join(path.dirname(process.execPath), binary);
    if (existsSync(beside)) return beside;
  }
  return bundledClaudeExecutable() ?? findOnPath(binary, env);
}

/** The Claude Code binary shipped in the Agent SDK's platform package, if installed. */
export function bundledClaudeExecutable(): string | null {
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    for (const pkg of [base, `${base}-musl`]) {
      try {
        const file = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), binary);
        if (existsSync(file)) return file;
      } catch {
        // Not installed for this platform.
      }
    }
  } catch {
    // No module resolution from here (a single executable).
  }
  return null;
}

/**
 * Claude Code's own credential precedence below the OAuth /login this SDK never
 * touches — cloud provider flags, then ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY,
 * CLAUDE_CODE_OAUTH_TOKEN, checked in that order (Anthropic's own docs, "Authentication").
 * `apiKeyHelper` (a settings.json script) is one step further down still and is not
 * checked here — reading and running an arbitrary configured script just to label a probe
 * result is more than this is worth; a machine set up that way keeps the plain "not logged
 * in" wording instead of a wrong one.
 */
export function apiKeyAuth(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_CODE_USE_BEDROCK) return "AWS Bedrock";
  if (env.CLAUDE_CODE_USE_VERTEX) return "Google Vertex AI";
  if (env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  return null;
}

/** The two fields read from `claude auth status`, or null when the output is not its JSON. */
function parseAuthStatus(output: string): { loggedIn: boolean; method: string | null } | null {
  try {
    const status = JSON.parse(output) as { loggedIn?: unknown; authMethod?: unknown };
    if (typeof status.loggedIn !== "boolean") return null;
    return { loggedIn: status.loggedIn, method: typeof status.authMethod === "string" ? status.authMethod : null };
  } catch {
    return null;
  }
}

function run(file: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: err && !output ? errorMessage(err) : output });
    });
  });
}
