import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHistoryTurns } from "../src/providers/cursor/history.js";
import type { SessionUpdate } from "../src/providers/cursor/protocol.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const cwd = "/repo";

test("buildHistoryTurns turns a replayed plain-text exchange into one turn", () => {
  const updates: SessionUpdate[] = [
    { sessionUpdate: "user_message_chunk", content: text("Remember BANANA. Reply OK.") },
    { sessionUpdate: "agent_thought_chunk", content: text("I will remember it.") },
    { sessionUpdate: "agent_message_chunk", content: text("OK") },
  ];
  const turns = buildHistoryTurns(updates, cwd);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "completed");
  assert.deepEqual(
    turns[0]?.items.map((i) => i.kind),
    ["message", "reasoning", "message"],
  );
  const [user, thought, reply] = turns[0]?.items ?? [];
  assert.ok(user?.kind === "message" && user.role === "user" && user.text === "Remember BANANA. Reply OK.");
  assert.ok(thought?.kind === "reasoning" && thought.text === "I will remember it.");
  assert.ok(reply?.kind === "message" && reply.role === "assistant" && reply.text === "OK");
});

test("buildHistoryTurns joins consecutive chunks of the same kind into one item", () => {
  const updates: SessionUpdate[] = [
    { sessionUpdate: "user_message_chunk", content: text("hi") },
    { sessionUpdate: "agent_message_chunk", content: text("Hel") },
    { sessionUpdate: "agent_message_chunk", content: text("lo") },
  ];
  const [turn] = buildHistoryTurns(updates, cwd);
  const reply = turn?.items[1];
  assert.ok(reply?.kind === "message" && reply.text === "Hello");
});

test("buildHistoryTurns starts a new turn on the next user message", () => {
  const updates: SessionUpdate[] = [
    { sessionUpdate: "user_message_chunk", content: text("first") },
    { sessionUpdate: "agent_message_chunk", content: text("one") },
    { sessionUpdate: "user_message_chunk", content: text("second") },
    { sessionUpdate: "agent_message_chunk", content: text("two") },
  ];
  const turns = buildHistoryTurns(updates, cwd);
  assert.equal(turns.length, 2);
  assert.ok(turns[0]?.items[0]?.kind === "message" && turns[0].items[0].text === "first");
  assert.ok(turns[1]?.items[0]?.kind === "message" && turns[1].items[0].text === "second");
});

test("buildHistoryTurns replays a tool call to completion, correlated by toolCallId", () => {
  const updates: SessionUpdate[] = [
    { sessionUpdate: "user_message_chunk", content: text("run the tests") },
    { sessionUpdate: "tool_call", toolCallId: "call_1", title: "`npm test`", kind: "execute", status: "pending", rawInput: { command: "npm test" } },
    { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: { exitCode: 0, stdout: "ok\n", stderr: "" } },
    { sessionUpdate: "agent_message_chunk", content: text("Done") },
  ];
  const [turn] = buildHistoryTurns(updates, cwd);
  assert.deepEqual(
    turn?.items.map((i) => i.kind),
    ["message", "command", "message"],
  );
  const cmd = turn?.items[1];
  assert.ok(cmd?.kind === "command");
  assert.equal(cmd.status, "completed");
  assert.equal(cmd.output, "ok\n");
});

test("buildHistoryTurns drops a tool call that never reached a terminal status into the turn as-is", () => {
  const updates: SessionUpdate[] = [
    { sessionUpdate: "user_message_chunk", content: text("go") },
    { sessionUpdate: "tool_call", toolCallId: "call_1", title: "`sleep 100`", kind: "execute", status: "pending", rawInput: { command: "sleep 100" } },
  ];
  const [turn] = buildHistoryTurns(updates, cwd);
  assert.equal(turn?.items.length, 2);
  assert.equal(turn?.items[1]?.status, "in_progress");
});

test("buildHistoryTurns returns nothing for an empty replay", () => {
  assert.deepEqual(buildHistoryTurns([], cwd), []);
});
