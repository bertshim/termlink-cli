import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentEvent, Command, applyDelta, isDurableEvent, type Item } from "@termlink/protocol";

test("parses a valid command and strips unknown fields", () => {
  const parsed = Command.parse({
    v: 1,
    kind: "cmd",
    reqId: "r1",
    type: "session.send",
    payload: { sessionId: "ag_1", input: { text: "hi" }, extra: true },
  });
  assert.equal(parsed.type, "session.send");
  assert.deepEqual(parsed.payload, { sessionId: "ag_1", input: { text: "hi" } });
});

test("rejects unknown command types and empty input", () => {
  const base = { v: 1, kind: "cmd", reqId: "r1" };
  assert.equal(Command.safeParse({ ...base, type: "session.nope", payload: {} }).success, false);
  assert.equal(
    Command.safeParse({ ...base, type: "session.send", payload: { sessionId: "a", input: { text: "" } } }).success,
    false,
  );
});

test("parses an input.required event", () => {
  const parsed = AgentEvent.parse({
    v: 1,
    kind: "evt",
    type: "input.required",
    ts: 1,
    sessionId: "ag_1",
    seq: 4,
    payload: {
      request: {
        requestId: "in_1",
        kind: "command_approval",
        title: "Run npm test?",
        command: "npm test",
        decisions: [{ id: "allow", label: "Allow", effect: "allow" }],
      },
    },
  });
  assert.equal(parsed.type, "input.required");
});

test("only turn, item boundaries, input and error events are durable", () => {
  assert.equal(isDurableEvent("item.completed"), true);
  assert.equal(isDurableEvent("input.required"), true);
  assert.equal(isDurableEvent("item.delta"), false);
  assert.equal(isDurableEvent("session.updated"), false);
});

test("applyDelta appends to text and output only", () => {
  const message: Item = { id: "i", kind: "message", role: "assistant", text: "Hel", status: "in_progress" };
  assert.deepEqual(applyDelta(message, "text", "lo"), { ...message, text: "Hello" });
  assert.equal(applyDelta(message, "output", "x"), message);

  const command: Item = { id: "c", kind: "command", command: "ls", status: "in_progress" };
  assert.deepEqual(applyDelta(command, "output", "a\n"), { ...command, output: "a\n" });
});
