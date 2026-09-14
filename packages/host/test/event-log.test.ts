import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "@termlink/protocol";
import { EventLog } from "../src/session/event-log.js";

function turnStarted(seq: number): AgentEvent {
  return { v: 1, kind: "evt", type: "turn.started", ts: 0, sessionId: "s", seq, payload: { turnId: `t${seq}` } };
}

test("returns events after the given seq", () => {
  const log = new EventLog(10);
  for (let seq = 1; seq <= 5; seq++) log.append(turnStarted(seq));
  const slice = log.since(3);
  assert.deepEqual(slice.events.map((e) => e.seq), [4, 5]);
  assert.equal(slice.gap, false);
  assert.equal(slice.oldestSeq, 1);
});

test("reports a gap once requested events were evicted", () => {
  const log = new EventLog(3);
  for (let seq = 1; seq <= 6; seq++) log.append(turnStarted(seq));
  assert.equal(log.since(0).gap, true);
  assert.deepEqual(log.since(0).events.map((e) => e.seq), [4, 5, 6]);
  assert.equal(log.since(3).gap, false);
  assert.equal(log.since(2).gap, true);
});

test("empty log has no gap", () => {
  const slice = new EventLog().since(0);
  assert.deepEqual(slice, { events: [], gap: false, oldestSeq: 0 });
});

test("refuses events without a seq", () => {
  const event = turnStarted(1);
  delete event.seq;
  assert.throws(() => new EventLog().append(event));
});
