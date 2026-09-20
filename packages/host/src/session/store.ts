import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AutoApprove, ProviderId } from "@termlink/protocol";

/** What the host remembers about a session so it can resume it after a restart. */
export interface SessionRecord {
  id: string;
  provider: ProviderId;
  providerSessionId: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  autoApprove?: AutoApprove;
  /**
   * A usage-limit auto-retry that was still armed (status `rate_limited`) when the host
   * last saved. The wait itself (the in-memory timer, and the exact turn text to resend)
   * cannot survive a restart — conversation content is never persisted (see this file's
   * own doc comment) — so restore() cannot re-arm it. Kept here only so restore() can say
   * plainly that a session's own auto-retry did not make it, instead of the wait silently
   * vanishing with no trace anywhere.
   */
  rateLimit?: { reason: string; retryAt: number };
}

export function defaultStatePath(): string {
  return path.join(os.homedir(), ".termlink", "agent-sessions.json");
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.provider === "string" &&
    typeof r.providerSessionId === "string" &&
    typeof r.cwd === "string" &&
    typeof r.createdAt === "number"
  );
}

/** A small JSON file of session records, rewritten atomically. Writes are serialized. */
export class SessionStore {
  readonly file: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(file: string = defaultStatePath()) {
    this.file = file;
  }

  async load(): Promise<SessionRecord[]> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { sessions?: unknown };
      return Array.isArray(data.sessions) ? data.sessions.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  save(records: SessionRecord[]): Promise<void> {
    this.#queue = this.#queue.then(() => this.#write(records)).catch(() => {});
    return this.#queue;
  }

  async #write(records: SessionRecord[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, sessions: records }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}
