import assert from "node:assert/strict";
import { test } from "node:test";
import { Chunk, FrameAssembler, encodeFrames } from "@termlink/protocol";

const encoder = new TextEncoder();
let ids = 0;
const makeId = () => `c${++ids}`;

test("small messages go out as a single plain frame", () => {
  const frames = encodeFrames({ v: 1, kind: "evt", type: "x" }, 1024, makeId);
  assert.equal(frames.length, 1);
  assert.equal(new FrameAssembler().push(frames[0]!) !== undefined, true);
});

test("large messages split under the byte limit and reassemble exactly", () => {
  // Mixed content: multi-byte text, surrogate pairs and characters JSON escapes.
  const text = "日本語 café diff 🙂 \"quoted\" \n\t line\u0001 ".repeat(4000);
  const message = { v: 1, kind: "evt", type: "item.completed", payload: { text } };
  const frames = encodeFrames(message, 2048, makeId);
  assert.ok(frames.length > 10);
  for (const frame of frames) {
    assert.ok(encoder.encode(frame).length <= 2048, "frame over limit");
    assert.equal(Chunk.safeParse(JSON.parse(frame)).success, true);
  }

  const assembler = new FrameAssembler();
  // Deliver out of order: reassembly goes by index.
  const shuffled = [...frames].reverse();
  const results = shuffled.map((f) => assembler.push(f));
  assert.deepEqual(results.slice(0, -1).filter((r) => r !== undefined), []);
  assert.deepEqual(results.at(-1), message);
});

test("interleaved chunked messages do not mix", () => {
  const a = { payload: "a".repeat(5000) };
  const b = { payload: "b".repeat(5000) };
  const fa = encodeFrames(a, 1024, makeId);
  const fb = encodeFrames(b, 1024, makeId);
  const assembler = new FrameAssembler();
  const out: unknown[] = [];
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    for (const f of [fa[i], fb[i]]) {
      if (!f) continue;
      const r = assembler.push(f);
      if (r !== undefined) out.push(r);
    }
  }
  assert.deepEqual(out, [a, b]);
});

test("incomplete messages expire and oversized ones are refused", () => {
  const frames = encodeFrames({ payload: "x".repeat(5000) }, 1024, makeId);
  const assembler = new FrameAssembler({ timeoutMs: 1000, maxMessageBytes: 3000 });
  assert.equal(assembler.push(frames[0]!, 0), undefined);
  assert.throws(() => {
    for (const f of frames.slice(1)) assembler.push(f, 10);
  }, /exceeds/);

  const small = encodeFrames({ payload: "y".repeat(2000) }, 1024, makeId);
  const late = new FrameAssembler({ timeoutMs: 1000 });
  late.push(small[0]!, 0);
  // The first piece has expired by the time the rest arrives, so the message never completes.
  const results = small.slice(1).map((f) => late.push(f, 5000));
  assert.deepEqual(results.filter((r) => r !== undefined), []);
});
