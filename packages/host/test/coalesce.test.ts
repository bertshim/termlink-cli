import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { HostMessage } from "@termlink/protocol";
import { DeltaCoalescer } from "../src/server/coalesce.js";

const WINDOW = 30;

function delta(itemId: string, text: string): HostMessage {
  return { v: 1, kind: "evt", type: "item.delta", ts: 0, sessionId: "ag_1", payload: { itemId, field: "text", delta: text } } as HostMessage;
}

function other(): HostMessage {
  return { v: 1, kind: "evt", type: "turn.completed", ts: 0, sessionId: "ag_1", seq: 9, payload: { turnId: "t", status: "completed" } } as HostMessage;
}

/** A coalescer on a clock the test moves, with what it sent as short strings. */
function setup() {
  mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1_000;
  const sent: string[] = [];
  const coalescer = new DeltaCoalescer(
    (m) => sent.push(m.kind === "evt" && m.type === "item.delta" ? `${m.payload.itemId}:${m.payload.delta}` : m.kind === "evt" ? m.type : m.kind),
    WINDOW,
    () => clock,
  );
  const advance = (ms: number): void => {
    clock += ms;
    mock.timers.tick(ms);
  };
  return { coalescer, sent, advance };
}

test("the first delta goes out at once; the ones right behind it are merged until the window ends", (t) => {
  t.after(() => mock.timers.reset());
  const { coalescer, sent, advance } = setup();
  coalescer.push(delta("a", "He"));
  assert.deepEqual(sent, ["a:He"]);
  advance(5);
  coalescer.push(delta("a", "ll"));
  advance(5);
  coalescer.push(delta("a", "o"));
  assert.deepEqual(sent, ["a:He"]);
  advance(WINDOW);
  assert.deepEqual(sent, ["a:He", "a:llo"]);
});

test("after a quiet spell the next delta is not held", (t) => {
  t.after(() => mock.timers.reset());
  const { coalescer, sent, advance } = setup();
  coalescer.push(delta("a", "one"));
  advance(WINDOW + 1);
  coalescer.push(delta("a", "two"));
  assert.deepEqual(sent, ["a:one", "a:two"]);
});

test("a new item's first delta is sent at once, after whatever the previous item had waiting", (t) => {
  t.after(() => mock.timers.reset());
  const { coalescer, sent, advance } = setup();
  coalescer.push(delta("thinking", "x"));
  advance(1);
  coalescer.push(delta("thinking", "y"));
  advance(1);
  coalescer.push(delta("text", "Hi"));
  assert.deepEqual(sent, ["thinking:x", "thinking:y", "text:Hi"]);
});

test("any other message flushes the pending delta first, keeping the order", (t) => {
  t.after(() => mock.timers.reset());
  const { coalescer, sent, advance } = setup();
  coalescer.push(delta("a", "1"));
  advance(1);
  coalescer.push(delta("a", "2"));
  coalescer.push(other());
  assert.deepEqual(sent, ["a:1", "a:2", "turn.completed"]);
  advance(WINDOW);
  assert.deepEqual(sent, ["a:1", "a:2", "turn.completed"]);
});

test("dispose drops what is pending", (t) => {
  t.after(() => mock.timers.reset());
  const { coalescer, sent, advance } = setup();
  coalescer.push(delta("a", "1"));
  advance(1);
  coalescer.push(delta("a", "2"));
  coalescer.dispose();
  advance(WINDOW);
  assert.deepEqual(sent, ["a:1"]);
});
