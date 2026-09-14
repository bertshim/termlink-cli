import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TERMINAL_FRAME_INPUT,
  TERMINAL_FRAME_OUTPUT,
  decodeTerminalFrame,
  encodeTerminalFrame,
  encodeTerminalFrames,
} from "../src/index.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("a terminal frame round-trips its kind, session and bytes", () => {
  const payload = bytes("ls -la\r\n日本語 output \x1b[31mred\x1b[0m");
  const frame = encodeTerminalFrame(TERMINAL_FRAME_OUTPUT, "ag_abc123", payload);
  const decoded = decodeTerminalFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.kind, TERMINAL_FRAME_OUTPUT);
  assert.equal(decoded.sessionId, "ag_abc123");
  assert.deepEqual([...decoded.payload], [...payload]);
});

test("an empty payload is still a frame", () => {
  const decoded = decodeTerminalFrame(encodeTerminalFrame(TERMINAL_FRAME_INPUT, "s", new Uint8Array()));
  assert.ok(decoded);
  assert.equal(decoded.payload.length, 0);
});

test("anything else is not a terminal frame", () => {
  assert.equal(decodeTerminalFrame(new Uint8Array()), null);
  assert.equal(decodeTerminalFrame(bytes('{"v":1}')), null);
  assert.equal(decodeTerminalFrame(new Uint8Array([9, 1, 65])), null);
  assert.equal(decodeTerminalFrame(new Uint8Array([1, 5, 65])), null);
  assert.equal(decodeTerminalFrame(new Uint8Array([1, 0, 65])), null);
});

test("long output is split into frames under the limit, in order", () => {
  const payload = new Uint8Array(250);
  payload.forEach((_, i) => (payload[i] = i % 256));
  const frames = encodeTerminalFrames(TERMINAL_FRAME_OUTPUT, "ag_1", payload, 100);
  assert.equal(frames.length, 3);
  const joined = frames.flatMap((f) => [...(decodeTerminalFrame(f)?.payload ?? [])]);
  assert.deepEqual(joined, [...payload]);
  for (const f of frames) assert.ok(f.length <= 100 + 2 + "ag_1".length);
});
