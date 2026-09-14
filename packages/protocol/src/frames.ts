import { z } from "zod";
import { PROTOCOL_VERSION } from "./common.js";

/**
 * One piece of a message too large for a single transport frame. The TermLink relay
 * caps frames at 64 KiB, so both sides split larger messages and reassemble them.
 * `data` pieces concatenated in index order are the original message's JSON text.
 */
export const Chunk = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal("chunk"),
  id: z.string().min(1).max(64),
  index: z.number().int().min(0),
  total: z.number().int().min(1).max(100_000),
  data: z.string(),
});
export type Chunk = z.infer<typeof Chunk>;

/** Frame limit that fits under the relay's 64 KiB with room to spare. */
export const RELAY_FRAME_BYTES = 60 * 1024;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Serializes a message into one or more text frames, each at most `maxBytes` of UTF-8. */
export function encodeFrames(message: unknown, maxBytes: number, makeId: () => string): string[] {
  const json = JSON.stringify(message);
  if (byteLength(json) <= maxBytes) return [json];

  const id = makeId();
  // Frame overhead besides `data`, with room for the index and total digits.
  const overhead = byteLength(JSON.stringify({ v: PROTOCOL_VERSION, kind: "chunk", id, index: 0, total: 0, data: "" })) + 16;
  const budget = maxBytes - overhead;
  if (budget < 64) throw new Error(`frame limit ${maxBytes} is too small`);

  const parts: string[] = [];
  let rest = json;
  while (rest.length > 0) {
    let size = Math.min(rest.length, budget);
    for (;;) {
      // Never split a surrogate pair across frames.
      if (size < rest.length && isHighSurrogate(rest.charCodeAt(size - 1))) size--;
      if (byteLength(JSON.stringify(rest.slice(0, size))) <= budget || size <= 1) break;
      size = Math.floor(size / 2);
    }
    parts.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return parts.map((data, index) =>
    JSON.stringify({ v: PROTOCOL_VERSION, kind: "chunk", id, index, total: parts.length, data } satisfies Chunk),
  );
}

interface Pending {
  parts: (string | undefined)[];
  received: number;
  bytes: number;
  startedAt: number;
}

/**
 * Reassembles chunked messages. push() returns the parsed message once a frame
 * completes one (a whole message completes immediately), or undefined while
 * pieces are still missing. Incomplete messages are dropped after `timeoutMs`.
 */
export class FrameAssembler {
  readonly #pending = new Map<string, Pending>();
  readonly #maxMessageBytes: number;
  readonly #timeoutMs: number;

  constructor(options: { maxMessageBytes?: number; timeoutMs?: number } = {}) {
    this.#maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Throws on a frame that is not JSON or a message that grows past the size limit. */
  push(frame: string, now = Date.now()): unknown {
    const data: unknown = JSON.parse(frame);
    const chunk = Chunk.safeParse(data);
    if (!chunk.success) return data;

    this.#expire(now);
    const { id, index, total, data: piece } = chunk.data;
    let pending = this.#pending.get(id);
    if (!pending) {
      pending = { parts: new Array<string | undefined>(total), received: 0, bytes: 0, startedAt: now };
      this.#pending.set(id, pending);
    }
    if (index >= pending.parts.length || pending.parts[index] !== undefined) return undefined;
    pending.parts[index] = piece;
    pending.received++;
    pending.bytes += piece.length;
    if (pending.bytes > this.#maxMessageBytes) {
      this.#pending.delete(id);
      throw new Error(`chunked message ${id} exceeds ${this.#maxMessageBytes} bytes`);
    }
    if (pending.received < pending.parts.length) return undefined;
    this.#pending.delete(id);
    return JSON.parse(pending.parts.join(""));
  }

  #expire(now: number): void {
    for (const [id, pending] of this.#pending) {
      if (now - pending.startedAt > this.#timeoutMs) this.#pending.delete(id);
    }
  }
}

// Terminal bytes travel in WebSocket binary frames, not in JSON, so nothing is base64
// encoded or parsed on the way. Every frame names its session, because the relay merges
// all clients into one host socket and no per-connection numbering is possible.
//
//   byte 0      kind: 1 = output (host -> client), 2 = input (client -> host)
//   byte 1      length n of the session id
//   byte 2..    session id, n ASCII bytes
//   the rest    PTY bytes as they are

export const TERMINAL_FRAME_OUTPUT = 1 as const;
export const TERMINAL_FRAME_INPUT = 2 as const;
export type TerminalFrameKind = typeof TERMINAL_FRAME_OUTPUT | typeof TERMINAL_FRAME_INPUT;

export interface TerminalFrame {
  kind: TerminalFrameKind;
  sessionId: string;
  payload: Uint8Array;
}

/** Largest payload per frame: the relay's limit less the header and some room. */
export const TERMINAL_FRAME_PAYLOAD_BYTES = RELAY_FRAME_BYTES - 128;

const TERMINAL_FRAME_KINDS: readonly number[] = [TERMINAL_FRAME_OUTPUT, TERMINAL_FRAME_INPUT];

export function encodeTerminalFrame(kind: TerminalFrameKind, sessionId: string, payload: Uint8Array): Uint8Array {
  const id = encoder.encode(sessionId);
  if (id.length === 0 || id.length > 255) throw new Error(`session id is ${id.length} bytes; 1-255 allowed`);
  const frame = new Uint8Array(2 + id.length + payload.length);
  frame[0] = kind;
  frame[1] = id.length;
  frame.set(id, 2);
  frame.set(payload, 2 + id.length);
  return frame;
}

/** Returns null for anything that is not a terminal frame. */
export function decodeTerminalFrame(data: Uint8Array): TerminalFrame | null {
  if (data.length < 3) return null;
  const kind = data[0] ?? 0;
  const idLength = data[1] ?? 0;
  if (!TERMINAL_FRAME_KINDS.includes(kind) || idLength === 0 || data.length < 2 + idLength) return null;
  const sessionId = new TextDecoder().decode(data.subarray(2, 2 + idLength));
  return { kind: kind as TerminalFrameKind, sessionId, payload: data.subarray(2 + idLength) };
}

/** Splits a byte run into frames that each fit under the relay's frame limit. */
export function encodeTerminalFrames(
  kind: TerminalFrameKind,
  sessionId: string,
  payload: Uint8Array,
  maxPayloadBytes = TERMINAL_FRAME_PAYLOAD_BYTES,
): Uint8Array[] {
  if (payload.length <= maxPayloadBytes) return [encodeTerminalFrame(kind, sessionId, payload)];
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += maxPayloadBytes) {
    frames.push(encodeTerminalFrame(kind, sessionId, payload.subarray(offset, offset + maxPayloadBytes)));
  }
  return frames;
}
