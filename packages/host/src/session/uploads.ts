import { chmod, mkdir, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_CHUNK_BYTES } from "@termlink/protocol";
import { HostError, errorMessage } from "../errors.js";
import { newId } from "../util/id.js";

/** The host's own folder inside a session's folder. */
export const TERMLINK_DIR = ".termlink";
/** Where uploads land, inside TERMLINK_DIR. */
export const UPLOADS_DIR = "uploads";

/** An upload that has not moved for this long is dropped with its partial file. */
const IDLE_MS = 60_000;
const MAX_SWEEP_MS = 15_000;
const MAX_NAME_LENGTH = 200;

interface Upload {
  readonly id: string;
  readonly file: FileHandle;
  readonly path: string;
  readonly name: string;
  readonly size: number;
  received: number;
  touched: number;
  /** Chunk writes in flight. */
  writing: number;
}

export interface UploadManagerOptions {
  /** The folder a session's uploads go in (its cwd). Throws not_found for a session the host doesn't have. */
  folderOf: (sessionId: string) => string;
  maxBytes?: number;
  idleMs?: number;
}

/**
 * Files a client sends into a session's folder (upload.begin / chunk / end / abort).
 *
 * They are saved under <cwd>/.termlink/uploads/, where the agent or the shell in that
 * session can read them by path. The folder is chosen by the session, which the host
 * has already checked against its allowed roots; the client only names the file, and
 * only its last path segment is kept.
 *
 * Chunks carry their byte offset and are written there, because a connection handles
 * commands concurrently and a client keeps several chunks in flight: they may land in
 * any order. end checks the byte count against the size begin announced.
 */
export class UploadManager {
  readonly #uploads = new Map<string, Upload>();
  readonly #folderOf: (sessionId: string) => string;
  readonly #maxBytes: number;
  readonly #idleMs: number;
  #sweep: NodeJS.Timeout | null = null;

  constructor(options: UploadManagerOptions) {
    this.#folderOf = options.folderOf;
    this.#maxBytes = options.maxBytes ?? UPLOAD_MAX_BYTES;
    this.#idleMs = options.idleMs ?? IDLE_MS;
  }

  async begin(sessionId: string, name: string, size: number): Promise<{ uploadId: string; name: string }> {
    if (size > this.#maxBytes) {
      throw new HostError(
        "bad_request",
        `${name} is ${formatBytes(size)}; files up to ${formatBytes(this.#maxBytes)} can be uploaded`,
      );
    }
    const dir = await ensureUploadDir(this.#folderOf(sessionId));
    const { file, name: saved } = await createUnique(dir, cleanName(name));
    const id = newId("up");
    this.#uploads.set(id, {
      id,
      file,
      path: path.join(dir, saved),
      name: saved,
      size,
      received: 0,
      touched: Date.now(),
      writing: 0,
    });
    this.#arm();
    return { uploadId: id, name: saved };
  }

  async chunk(uploadId: string, offset: number, data: string): Promise<{ received: number }> {
    const upload = this.#get(uploadId);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > UPLOAD_MAX_CHUNK_BYTES) {
      await this.#drop(upload);
      throw new HostError("bad_request", `a chunk is ${bytes.length} bytes; up to ${UPLOAD_MAX_CHUNK_BYTES} allowed`);
    }
    if (offset + bytes.length > upload.size) {
      await this.#drop(upload);
      throw new HostError("bad_request", `a chunk runs past the ${upload.size} bytes begin announced`);
    }
    upload.touched = Date.now();
    upload.writing++;
    try {
      await upload.file.write(bytes, 0, bytes.length, offset);
    } catch (err) {
      upload.writing--;
      if (!this.#uploads.has(uploadId)) throw new HostError("not_found", `upload ${uploadId} was dropped`);
      await this.#drop(upload);
      throw new HostError("internal", `could not write ${upload.name}: ${errorMessage(err)}`);
    }
    upload.writing--;
    if (!this.#uploads.has(uploadId)) throw new HostError("not_found", `upload ${uploadId} was dropped`);
    upload.received += bytes.length;
    return { received: upload.received };
  }

  async end(uploadId: string): Promise<{ path: string; name: string; size: number }> {
    const upload = this.#get(uploadId);
    if (upload.writing > 0) throw new HostError("conflict", "chunks of this upload are still being written");
    this.#uploads.delete(uploadId);
    this.#disarmIfIdle();
    try {
      await upload.file.close();
    } catch (err) {
      await rm(upload.path, { force: true }).catch(() => {});
      throw new HostError("internal", `could not save ${upload.name}: ${errorMessage(err)}`);
    }
    if (upload.received !== upload.size) {
      await rm(upload.path, { force: true }).catch(() => {});
      throw new HostError("bad_request", `got ${upload.received} of the ${upload.size} bytes announced`);
    }
    return { path: upload.path, name: upload.name, size: upload.size };
  }

  async abort(uploadId: string): Promise<void> {
    const upload = this.#uploads.get(uploadId);
    if (upload) await this.#drop(upload);
  }

  /** Drops every upload in progress (the connection went away). */
  async dispose(): Promise<void> {
    await Promise.all([...this.#uploads.values()].map((upload) => this.#drop(upload)));
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
  }

  #get(uploadId: string): Upload {
    const upload = this.#uploads.get(uploadId);
    if (!upload) throw new HostError("not_found", `no upload ${uploadId}`);
    return upload;
  }

  async #drop(upload: Upload): Promise<void> {
    if (this.#uploads.get(upload.id) !== upload) return;
    this.#uploads.delete(upload.id);
    this.#disarmIfIdle();
    await upload.file.close().catch(() => {});
    await rm(upload.path, { force: true }).catch(() => {});
  }

  // A tab closed halfway through an upload says nothing over the relay, where every
  // client shares one connection; the sweep is what cleans up after it.
  #arm(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      const now = Date.now();
      for (const upload of this.#uploads.values()) {
        if (upload.writing === 0 && now - upload.touched > this.#idleMs) void this.#drop(upload);
      }
    }, Math.min(this.#idleMs, MAX_SWEEP_MS));
    this.#sweep.unref();
  }

  #disarmIfIdle(): void {
    if (this.#uploads.size > 0 || !this.#sweep) return;
    clearInterval(this.#sweep);
    this.#sweep = null;
  }
}

/**
 * <folder>/.termlink/uploads, made if missing. .termlink gets a .gitignore of "*" so the
 * folder never shows up in the user's git; their own .gitignore is left alone. 0700,
 * because nobody else on the machine has a reason to read what was sent here.
 */
async function ensureUploadDir(folder: string): Promise<string> {
  const base = path.join(folder, TERMLINK_DIR);
  const dir = path.join(base, UPLOADS_DIR);
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    await chmod(base, 0o700).catch(() => {});
    // "wx": one already there may have been edited on purpose.
    await writeFile(path.join(base, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch(() => {});
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new HostError("internal", `could not make ${dir}: ${errorMessage(err)}`);
  }
  return dir;
}

/** Opens a new file named `name` in `dir`, or "name (1).ext" and so on when it is taken. */
async function createUnique(dir: string, name: string): Promise<{ file: FileHandle; name: string }> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 10_000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    try {
      return { file: await open(path.join(dir, candidate), "wx", 0o644), name: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new HostError("internal", `could not create ${candidate}: ${errorMessage(err)}`);
    }
  }
  throw new HostError("conflict", `too many files named ${name}`);
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/**
 * A client's file name as a safe name in one folder: the last path segment only, with
 * control characters and the ones Windows refuses (<>:"|?*) replaced, and no trailing
 * dots or spaces (Windows drops them).
 */
export function cleanName(given: string): string {
  let name = given.replace(/\\/g, "/").split("/").pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().replace(/[. ]+$/, "");
  if (!name || name === "." || name === "..") return "upload";
  if (WINDOWS_DEVICE.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`;
}
