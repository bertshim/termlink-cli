import { readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FS_READ_MAX_BYTES } from "@termlink/protocol";
import type { AgentEvent, AutoApprove, CommandResults, ProviderId, ProviderStatus, SessionInfo } from "@termlink/protocol";
import { HostError, errorMessage } from "../errors.js";
import type { HostProvider, ProviderAdapter, TerminalProvider } from "../providers/types.js";
import { newId } from "../util/id.js";
import { AgentSession, type Listener } from "./session.js";
import type { SessionRecord, SessionStore } from "./store.js";
import { TerminalSession, type FlowControlOptions } from "./terminal-session.js";

export type HostSession = AgentSession | TerminalSession;

export interface CreateSessionOptions {
  provider: ProviderId;
  cwd: string;
  title?: string | undefined;
  /** Agent sessions. */
  autoApprove?: AutoApprove | undefined;
  /**
   * Agent sessions on a `resumable` provider: a past session's own
   * providerSessionId (SessionInfo.providerSessionId), to continue its
   * transcript in a brand new session rather than starting empty — the same
   * mechanism restore() already uses to bring a session back after a host
   * restart, now reachable from a client that closed a session on purpose
   * and wants it back (session.create's own `resume` field). Rejected with
   * `unsupported` when the provider isn't resumable.
   */
  resumeProviderSessionId?: string | undefined;
  /** Claude only: spawns with `--chrome` (StartOptions' own doc comment).
   *  Ignored by any other provider. */
  chrome?: boolean | undefined;
  /** Terminal sessions. */
  cols?: number | undefined;
  rows?: number | undefined;
}

export interface SessionManagerOptions {
  providers: HostProvider[];
  logCapacity?: number;
  /** Folders sessions may be opened in. Unset means any folder. */
  allowedRoots?: string[];
  /** Remembers resumable agent sessions across host restarts. */
  store?: SessionStore;
  /** autoApprove for new agent sessions that do not ask for one. Defaults to off. */
  autoApprove?: AutoApprove;
  /** Flow control for terminal sessions. */
  flow?: FlowControlOptions;
}

const PERSIST_DELAY_MS = 100;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Owns all sessions on this host and fans host-channel events out to every connection. */
export class SessionManager {
  readonly #providers = new Map<string, HostProvider>();
  readonly #sessions = new Map<string, HostSession>();
  readonly #hostListeners = new Set<Listener>();
  readonly #logCapacity: number | undefined;
  readonly #roots: string[] | undefined;
  readonly #store: SessionStore | undefined;
  readonly #autoApprove: AutoApprove;
  readonly #flow: FlowControlOptions;
  #persistTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #lastRestoreRateLimitLost = 0;

  constructor(options: SessionManagerOptions) {
    for (const provider of options.providers) this.#providers.set(provider.id, provider);
    this.#logCapacity = options.logCapacity;
    this.#roots = options.allowedRoots?.map((root) => path.resolve(root));
    this.#store = options.store;
    this.#autoApprove = options.autoApprove ?? "off";
    this.#flow = options.flow ?? {};
  }

  /** Folders sessions may be opened in, or undefined when unrestricted. */
  get roots(): string[] | undefined {
    return this.#roots ? [...this.#roots] : undefined;
  }

  /** How many of the sessions restore() just brought back had a usage-limit auto-retry
   *  armed that could not come back with them (see restore()'s own note on why). */
  get lastRestoreRateLimitLost(): number {
    return this.#lastRestoreRateLimitLost;
  }

  onHostEvent(listener: Listener): () => void {
    this.#hostListeners.add(listener);
    return () => this.#hostListeners.delete(listener);
  }

  async providerStatuses(): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.#providers.values()].map(async (provider) => {
        const identity = {
          id: provider.id,
          kind: provider.kind,
          label: provider.label,
          ...(provider.kind === "agent" && provider.steer ? { steer: true } : {}),
          // A client offers "resume this closed session" only for a provider
          // that can actually do it (session.create's own `resume` field).
          ...(provider.kind === "agent" && provider.resumable ? { resumable: true } : {}),
        };
        try {
          return { ...identity, ...(await provider.probe()) };
        } catch (err) {
          return { ...identity, available: false, version: null, detail: errorMessage(err) };
        }
      }),
    );
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info);
  }

  get(sessionId: string): HostSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new HostError("not_found", `no session ${sessionId}`);
    return session;
  }

  /** The session, if it is an agent session; commands for turns and approvals need one. */
  agent(sessionId: string): AgentSession {
    const session = this.get(sessionId);
    if (!(session instanceof AgentSession)) throw new HostError("unsupported", `${sessionId} is a terminal session`);
    return session;
  }

  terminal(sessionId: string): TerminalSession {
    const session = this.get(sessionId);
    if (!(session instanceof TerminalSession)) throw new HostError("unsupported", `${sessionId} is not a terminal session`);
    return session;
  }

  async create(options: CreateSessionOptions): Promise<HostSession> {
    const provider = this.#providers.get(options.provider);
    if (!provider) throw new HostError("unsupported", `provider ${options.provider} is not enabled on this host`);
    const cwd = await this.#resolveCwd(options.cwd);
    return provider.kind === "terminal"
      ? this.#createTerminal(provider, cwd, options)
      : this.#createAgent(provider, cwd, options);
  }

  /** create() for callers that need an agent session, such as tests. */
  async createAgent(options: CreateSessionOptions): Promise<AgentSession> {
    const session = await this.create(options);
    if (!(session instanceof AgentSession)) {
      await this.close(session.id, "not an agent session");
      throw new HostError("unsupported", `${options.provider} opens terminal sessions`);
    }
    return session;
  }

  /** create() for callers that need a terminal session. */
  async createTerminal(options: CreateSessionOptions): Promise<TerminalSession> {
    const session = await this.create(options);
    if (!(session instanceof TerminalSession)) {
      await this.close(session.id, "not a terminal session");
      throw new HostError("unsupported", `${options.provider} opens agent sessions`);
    }
    return session;
  }

  async #createAgent(provider: ProviderAdapter, cwd: string, options: CreateSessionOptions): Promise<AgentSession> {
    const resumeId = options.resumeProviderSessionId;
    if (resumeId && !provider.resumable) {
      throw new HostError("unsupported", `${provider.id} sessions can't be resumed`);
    }
    const now = Date.now();
    const session = new AgentSession(
      {
        id: newId("ag"),
        kind: "agent",
        provider: provider.id,
        // Known immediately for a resume, same as restore() below — the
        // provider's own start() will report it again once the process is
        // actually up, but SessionInfo carries it from the first announce.
        providerSessionId: resumeId ?? null,
        cwd,
        title: options.title ?? null,
        status: "starting",
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        autoApprove: options.autoApprove ?? this.#autoApprove,
      },
      this.#broadcast,
      this.#logCapacity,
    );
    this.#sessions.set(session.id, session);
    session.announce();
    if (resumeId && provider.history) {
      // History is a convenience; a session without it can still be resumed
      // (restore()'s own comment) — the CLI's own transcript still loads
      // once start() actually spawns it, this just has it on screen already
      // rather than waiting on that.
      const turns = await provider.history(resumeId, cwd).catch(() => []);
      session.importHistory(turns);
    }
    try {
      session.bind(
        await provider.start(
          {
            sessionId: session.id,
            cwd,
            ...(resumeId ? { resumeProviderSessionId: resumeId } : {}),
            ...(options.chrome ? { chrome: true } : {}),
          },
          session.sink,
        ),
      );
    } catch (err) {
      await this.close(session.id, `failed to start: ${errorMessage(err)}`);
      throw new HostError("internal", `failed to start ${provider.id}: ${errorMessage(err)}`);
    }
    return session;
  }

  async #createTerminal(provider: TerminalProvider, cwd: string, options: CreateSessionOptions): Promise<TerminalSession> {
    const now = Date.now();
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const session = new TerminalSession(
      {
        id: newId("tm"),
        kind: "terminal",
        provider: provider.id,
        providerSessionId: null,
        cwd,
        title: options.title ?? null,
        status: "starting",
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        cols,
        rows,
      },
      this.#broadcast,
      this.#flow,
    );
    this.#sessions.set(session.id, session);
    session.announce();
    try {
      session.bind(await provider.open({ sessionId: session.id, cwd, cols, rows }));
    } catch (err) {
      await this.close(session.id, `failed to start: ${errorMessage(err)}`);
      throw new HostError("internal", `failed to start a terminal: ${errorMessage(err)}`);
    }
    return session;
  }

  /**
   * Brings back the agent sessions the store remembers, with their recent history read
   * from each provider's transcript. Providers resume on first use. Returns how many came back.
   * Terminal sessions are never remembered: their shell died with the previous host.
   */
  async restore(): Promise<number> {
    this.#lastRestoreRateLimitLost = 0;
    if (!this.#store) return 0;
    let restored = 0;
    for (const record of await this.#store.load()) {
      const provider = this.#providers.get(record.provider);
      if (provider?.kind !== "agent" || !provider.resumable || this.#sessions.has(record.id)) continue;
      let cwd: string;
      try {
        cwd = await this.#resolveCwd(record.cwd);
      } catch {
        continue; // The folder is gone or no longer allowed.
      }
      const session = new AgentSession(
        {
          id: record.id,
          kind: "agent",
          provider: provider.id,
          providerSessionId: record.providerSessionId,
          cwd,
          title: record.title,
          status: "starting",
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          lastSeq: 0,
          autoApprove: record.autoApprove ?? this.#autoApprove,
        },
        this.#broadcast,
        this.#logCapacity,
      );
      if (provider.history) {
        // History is a convenience; a session without it can still be resumed.
        const turns = await provider.history(record.providerSessionId, cwd).catch(() => []);
        session.importHistory(turns);
      }
      this.#sessions.set(session.id, session);
      session.announce();
      // The wait itself could not come back (store.ts's own note on why) — no client is
      // necessarily attached yet to hear a provider.event about it (and provider.event
      // is not durable, so one emitted here with nobody listening would just be lost).
      // Counted instead, for whoever starts the host to see in its own startup line.
      if (record.rateLimit) this.#lastRestoreRateLimitLost++;
      session.bindLazy(() =>
        provider.start({ sessionId: session.id, cwd, resumeProviderSessionId: record.providerSessionId }, session.sink),
      );
      restored++;
    }
    return restored;
  }

  /** Closed by a client: the session is forgotten and will not come back after a restart. */
  async close(sessionId: string, reason: string | null = null): Promise<void> {
    const session = this.get(sessionId);
    this.#sessions.delete(sessionId);
    await session.close(reason);
    this.#persistSoon();
  }

  async closeAll(reason: string | null = null): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id, reason)));
  }

  /**
   * Stops the host: saves resumable sessions, closes everything, then releases provider
   * resources such as the Codex app-server. Unlike close(), agent sessions stay remembered.
   */
  async shutdown(reason: string | null = null): Promise<void> {
    this.#stopping = true;
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    await this.#persistNow();
    await this.closeAll(reason);
    await Promise.all(
      [...this.#providers.values()].map((p) => (p.kind === "agent" ? p.dispose?.().catch(() => {}) : undefined)),
    );
  }

  #persistSoon(): void {
    if (!this.#store || this.#stopping) return;
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => void this.#persistNow(), PERSIST_DELAY_MS);
  }

  async #persistNow(): Promise<void> {
    this.#persistTimer = null;
    if (!this.#store) return;
    const records: SessionRecord[] = [];
    for (const session of this.#sessions.values()) {
      if (!(session instanceof AgentSession)) continue;
      const info = session.info;
      const provider = this.#providers.get(info.provider);
      // Only sessions with a conversation to go back to.
      if (provider?.kind !== "agent" || !provider.resumable || !info.providerSessionId || info.lastSeq === 0) continue;
      records.push({
        id: info.id,
        provider: info.provider,
        providerSessionId: info.providerSessionId,
        cwd: info.cwd,
        title: info.title,
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
        ...(info.autoApprove ? { autoApprove: info.autoApprove } : {}),
        ...(info.rateLimit ? { rateLimit: info.rateLimit } : {}),
      });
    }
    await this.#store.save(records);
  }

  // Remote clients choose the folder, so it is checked after resolving symlinks.
  async #resolveCwd(requested: string): Promise<string> {
    const resolved = path.resolve(this.#roots?.[0] ?? process.cwd(), requested);
    const real = await realpath(resolved).catch(() => null);
    const stats = real ? await stat(real).catch(() => null) : null;
    if (!real || !stats?.isDirectory()) throw new HostError("bad_request", `not a directory: ${resolved}`);
    if (this.#roots) {
      const roots = await this.#realRoots();
      if (!roots.some((root) => isInside(real, root))) {
        throw new HostError("forbidden", `${resolved} is outside the folders this host allows`);
      }
    }
    return real;
  }

  /** This host's allowed roots, each resolved past its own symlinks (or `undefined` when unrestricted). */
  async #realRoots(): Promise<string[]> {
    if (!this.#roots) return [];
    return Promise.all(this.#roots.map((root) => realpath(root).catch(() => root)));
  }

  /**
   * A folder's own subfolders, for a client browsing to a `session.create` cwd instead
   * of typing it — the same allowed-folder check `#resolveCwd` makes, since this is the
   * same remote choice made one step earlier. `requested` omitted starts at this host's
   * own suggestion: its first allowed root, or its home folder when it has none.
   */
  async listDirectory(requested?: string): Promise<CommandResults["fs.list"]> {
    const base = requested ?? this.#roots?.[0] ?? os.homedir();
    const resolved = path.resolve(this.#roots?.[0] ?? process.cwd(), base);
    const real = await realpath(resolved).catch(() => null);
    const stats = real ? await stat(real).catch(() => null) : null;
    if (!real || !stats?.isDirectory()) throw new HostError("bad_request", `not a directory: ${resolved}`);
    const roots = await this.#realRoots();
    const isRoot = roots.some((root) => isInside(real, root) && path.relative(root, real) === "");
    if (this.#roots && !roots.some((root) => isInside(real, root))) {
      throw new HostError("forbidden", `${resolved} is outside the folders this host allows`);
    }
    const dirents = await readdir(real, { withFileTypes: true }).catch((err: unknown) => {
      throw new HostError("internal", `could not read ${real}: ${errorMessage(err)}`);
    });
    const entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: path.join(real, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const up = path.dirname(real);
    // Never above an allowed root — the host does not say what is above one — and
    // never above the filesystem's own root, which dirname() answers by repeating it.
    const parent = isRoot || up === real ? null : up;
    return { path: real, parent, entries };
  }

  /**
   * A file's own bytes (protocol `fs.read`), for a client previewing a path an agent
   * mentioned in its reply: a screenshot it saved, a report it wrote. The same
   * allowed-folder check as `#resolveCwd` and `listDirectory`, after resolving symlinks,
   * so `termlink start` (which always has allowed folders) serves nothing outside them.
   * Hidden files inside them are served too. One reply of up to FS_READ_MAX_BYTES,
   * whose base64 reassembles within FrameAssembler's limit: a preview, not a general
   * file transfer.
   */
  async readFile(requested: string): Promise<CommandResults["fs.read"]> {
    const resolved = path.resolve(this.#roots?.[0] ?? process.cwd(), requested);
    const real = await realpath(resolved).catch(() => null);
    const stats = real ? await stat(real).catch(() => null) : null;
    if (!real || !stats?.isFile()) throw new HostError("bad_request", `not a file: ${resolved}`);
    if (this.#roots) {
      const roots = await this.#realRoots();
      if (!roots.some((root) => isInside(real, root))) {
        throw new HostError("forbidden", `${resolved} is outside the folders this host allows`);
      }
    }
    if (stats.size > FS_READ_MAX_BYTES) {
      throw new HostError(
        "bad_request",
        `${resolved} is ${formatBytes(stats.size)}, over the ${formatBytes(FS_READ_MAX_BYTES)} preview limit`,
      );
    }
    const data = await readFile(real).catch((err: unknown) => {
      throw new HostError("internal", `could not read ${real}: ${errorMessage(err)}`);
    });
    return {
      path: real,
      mimeType: mimeTypeFor(real),
      size: stats.size,
      dataBase64: data.toString("base64"),
    };
  }

  readonly #broadcast = (event: AgentEvent): void => {
    // A session that ended on its own (a shell that exited) is forgotten like a closed one.
    if (event.type === "session.closed" && event.sessionId) this.#sessions.delete(event.sessionId);
    for (const listener of this.#hostListeners) listener(event);
    this.#persistSoon();
  };
}

function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * By extension, not by sniffing the content: a wrong guess costs a preview drawn the wrong
 * way, never a security decision. Anything unrecognised is application/octet-stream, which a
 * client offers as a download instead of rendering.
 */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".log": "text/plain",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
};

function mimeTypeFor(filePath: string): string {
  return EXT_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
