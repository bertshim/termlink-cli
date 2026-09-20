import { z } from "zod";
import { AutoApprove, type HostInfo, PROTOCOL_VERSION, ProviderId, type SessionInfo, TerminalSize } from "./common.js";
import { AgentEvent } from "./events.js";

const command = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("cmd"),
    reqId: z.string().min(1).max(64),
    type: z.literal(type),
    payload,
  });

const id = z.string().min(1).max(64);
const SessionRef = z.object({ sessionId: id });

export const UserInput = z.object({
  text: z.string().min(1).max(100_000),
  /**
   * The client's own id for this message. The host uses it as the id of the user
   * message item, so a client that drew the message before sending can match the
   * host's copy to its own. Unique per client; omitted, the host makes one.
   */
  id: z.string().min(1).max(64).optional(),
});
export type UserInput = z.infer<typeof UserInput>;

export const HostInfoCommand = command("host.info", z.object({}));
export const SessionListCommand = command("session.list", z.object({}));
export const SessionCreateCommand = command(
  "session.create",
  z.object({
    provider: ProviderId,
    cwd: z.string().min(1).max(4096),
    title: z.string().max(200).optional(),
    /** Agent sessions: defaults to the host's setting (off unless the host was started otherwise). */
    autoApprove: AutoApprove.optional(),
    /**
     * Agent sessions on a `resumable` provider (host.ready's own ProviderStatus):
     * a past session's own providerSessionId, to continue that transcript in this
     * new session instead of starting empty. Refused with `unsupported` on a
     * provider that isn't resumable.
     */
    resume: id.optional(),
    /** Claude sessions only: spawns with `--chrome` (browser control over an
     *  already-paired Chrome extension). Ignored on any other provider. */
    chrome: z.boolean().optional(),
    /** Terminal sessions: initial size. Defaults to 80x24. */
    cols: TerminalSize.shape.cols.optional(),
    rows: TerminalSize.shape.rows.optional(),
    /**
     * Terminal sessions: names this client for flow control (see terminal.ack).
     * The creating connection is attached as this client.
     */
    clientId: id.optional(),
  }),
);
export const SessionAttachCommand = command(
  "session.attach",
  SessionRef.extend({
    /** Agent sessions: replay durable events after this seq. */
    afterSeq: z.number().int().min(0).optional(),
    /** Terminal sessions: names this client for flow control (see terminal.ack). */
    clientId: id.optional(),
  }),
);
export const SessionDetachCommand = command("session.detach", SessionRef.extend({ clientId: id.optional() }));
export const SessionSendCommand = command("session.send", SessionRef.extend({ input: UserInput }));
export const SessionInterruptCommand = command("session.interrupt", SessionRef);
export const SessionCloseCommand = command("session.close", SessionRef);
/** Changes agent session settings. Changing autoApprove also applies to approvals already waiting. */
export const SessionConfigureCommand = command("session.configure", SessionRef.extend({ autoApprove: AutoApprove.optional() }));
export const InputRespondCommand = command(
  "input.respond",
  SessionRef.extend({
    requestId: id,
    decisionId: id,
    /** Answers to question-kind requests, keyed by question id. */
    answers: z.record(z.string(), z.string()).optional(),
  }),
);

// Terminal sessions. Bytes travel in binary frames (see frames.ts); these are the controls.

/** Sets the PTY size. The last client to ask wins; everyone hears terminal.size. */
export const TerminalResizeCommand = command("terminal.resize", SessionRef.extend(TerminalSize.shape));
/**
 * Flow control. `bytes` is how much terminal output this client has written to its
 * terminal since it attached (cumulative). The host pauses the shell when the slowest
 * client falls too far behind, so a phone on a slow link is not dropped by the relay.
 */
export const TerminalAckCommand = command(
  "terminal.ack",
  SessionRef.extend({ clientId: id, bytes: z.number().int().min(0) }),
);
/** Ends the shell process. Ctrl+C is not a command: it is the byte 0x03 written to the terminal. */
export const TerminalKillCommand = command("terminal.kill", SessionRef);

// File uploads. A client sends a file into a session's folder, where the agent or the
// shell can read it by path: begin, then chunks of base64 at their byte offsets (they may
// be in flight together and land in any order), then end. The host saves it under
// <session cwd>/.termlink/uploads/ and answers end with the absolute path.

/** Largest file one upload may carry. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Largest decoded chunk the host takes. Clients use 32 KiB so a chunk fits one relay frame. */
export const UPLOAD_MAX_CHUNK_BYTES = 512 * 1024;

const UploadRef = z.object({ uploadId: id });

export const UploadBeginCommand = command(
  "upload.begin",
  SessionRef.extend({
    /** The file's name. The host keeps only its last path segment and makes it unique in the folder. */
    name: z.string().min(1).max(255),
    size: z.number().int().min(0),
  }),
);
export const UploadChunkCommand = command(
  "upload.chunk",
  UploadRef.extend({
    offset: z.number().int().min(0),
    /** Base64 of the bytes at `offset`. */
    data: z.string().max(Math.ceil(UPLOAD_MAX_CHUNK_BYTES / 3) * 4),
  }),
);
export const UploadEndCommand = command("upload.end", UploadRef);
/** Drops an upload and its partial file. Unknown ids are fine: aborting twice is not an error. */
export const UploadAbortCommand = command("upload.abort", UploadRef);

/**
 * Lists a folder's own subfolders, for browsing to one instead of typing its path
 * (`session.create`'s `cwd`). `path` omitted starts at the host's own suggestion:
 * its first allowed root, or its home folder when it has none.
 */
export const FsListCommand = command("fs.list", z.object({ path: z.string().min(1).max(4096).optional() }));

/**
 * Largest file fs.read returns. Its base64 in the result, with the envelope, stays well
 * under what FrameAssembler takes (16 MiB), so the reply always reassembles.
 */
export const FS_READ_MAX_BYTES = 10 * 1024 * 1024;

/**
 * A file's own bytes, for a client previewing a path an agent's reply mentioned (a
 * screenshot it saved, a report it wrote). One reply of up to FS_READ_MAX_BYTES, not a
 * general download. The path must be under the host's allowed folders, like fs.list.
 */
export const FsReadCommand = command("fs.read", z.object({ path: z.string().min(1).max(4096) }));

export const Command = z.discriminatedUnion("type", [
  HostInfoCommand,
  SessionListCommand,
  SessionCreateCommand,
  SessionAttachCommand,
  SessionDetachCommand,
  SessionSendCommand,
  SessionInterruptCommand,
  SessionCloseCommand,
  SessionConfigureCommand,
  InputRespondCommand,
  TerminalResizeCommand,
  TerminalAckCommand,
  TerminalKillCommand,
  UploadBeginCommand,
  UploadChunkCommand,
  UploadEndCommand,
  UploadAbortCommand,
  FsListCommand,
  FsReadCommand,
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
export type CommandPayload<T extends CommandType> = CommandOf<T>["payload"];

type Empty = Record<string, never>;

export interface CommandResults {
  "host.info": HostInfo;
  "session.list": { sessions: SessionInfo[] };
  /** The creating connection is attached to the new session automatically. */
  "session.create": { session: SessionInfo };
  /**
   * Agent sessions: missed durable events follow; `gap` says some were evicted.
   * Terminal sessions: a terminal.reset event and the current screen follow; gap is false.
   */
  "session.attach": { session: SessionInfo; gap: boolean; oldestSeq: number; replayed: number };
  "session.detach": Empty;
  "session.send": Empty;
  "session.interrupt": Empty;
  "session.close": Empty;
  "session.configure": { session: SessionInfo };
  "input.respond": Empty;
  "terminal.resize": { session: SessionInfo };
  "terminal.ack": Empty;
  "terminal.kill": Empty;
  /** `name` is what the file will be called, after cleaning and de-duplicating. */
  "upload.begin": { uploadId: string; name: string };
  /** Bytes written so far. */
  "upload.chunk": { received: number };
  /** `path` is absolute, in the host's own form (backslashes on Windows). */
  "upload.end": { path: string; name: string; size: number };
  "upload.abort": Empty;
  "fs.list": {
    /** The listed folder, resolved to its real (symlink-free) path. */
    path: string;
    /** Its parent, to go up a level. Null at a filesystem root or at an
     *  allowed root — the host does not say what is above one. */
    parent: string | null;
    /** Its subfolders, sorted by name (locale-aware, case-insensitive).
     *  Hidden ("." prefixed) folders, files, and anything else that is not a
     *  plain directory (a symlink included) are left out. */
    entries: { name: string; path: string }[];
  };
  "fs.read": {
    /** Resolved, symlink-free path actually read. */
    path: string;
    /** By extension; "application/octet-stream" when unrecognised. */
    mimeType: string;
    size: number;
    /** Base64 of the file's bytes. */
    dataBase64: string;
  };
}

export const ErrorCode = z.enum(["bad_request", "forbidden", "not_found", "conflict", "unsupported", "internal"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Response = z.union([
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("res"),
    reqId: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("res"),
    reqId: z.string(),
    ok: z.literal(false),
    error: z.object({ code: ErrorCode, message: z.string() }),
  }),
]);
export type Response = z.infer<typeof Response>;

/** Everything a host sends to a client as JSON. Terminal bytes travel as binary frames. */
export const HostMessage = z.union([AgentEvent, Response]);
export type HostMessage = z.infer<typeof HostMessage>;
