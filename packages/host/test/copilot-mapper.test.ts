import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  approvalBody,
  blockText,
  commandOf,
  isCommandKind,
  isEditKind,
  mapDecisions,
  mapToolCallStart,
  mapToolCallUpdate,
  mapUsage,
} from "../src/providers/copilot/mapper.js";

const cwd = tmpdir();

test("blockText joins text blocks and skips anything else", () => {
  assert.equal(blockText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "ab");
  assert.equal(blockText(undefined), "");
});

test("mapDecisions maps allow_once/allow_always/reject_* to allow/allow_session/deny", () => {
  const decisions = mapDecisions([
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ]);
  assert.deepEqual(decisions, [
    { id: "allow_once", label: "Allow once", effect: "allow" },
    { id: "allow_always", label: "Always allow", effect: "allow_session" },
    { id: "reject_once", label: "Deny", effect: "deny" },
  ]);
});

test("commandOf prefers rawInput.command, then falls back to the title unquoted", () => {
  assert.equal(commandOf({ command: "npm test" }, "Run the test suite"), "npm test");
  assert.equal(commandOf(undefined, "npm test"), "npm test");
});

test("isCommandKind/isEditKind are true only for their own kind", () => {
  assert.equal(isCommandKind("execute"), true);
  assert.equal(isEditKind("edit"), true);
  assert.equal(isCommandKind("edit"), false);
  assert.equal(isEditKind("execute"), false);
});

test("approvalBody reads only the content-wrapped text, not a diff entry", () => {
  assert.equal(
    approvalBody([
      { type: "content", content: { type: "text", text: "reason" } },
      { type: "diff", path: "a.ts", oldText: "old", newText: "new" },
    ]),
    "reason",
  );
});

test("mapToolCallStart maps an execute call to a CommandItem with the natural-language title as display", () => {
  const item = mapToolCallStart(
    {
      toolCallId: "call_1",
      title: "Show current shell user",
      kind: "execute",
      status: "pending",
      rawInput: { command: "whoami" },
    },
    cwd,
  );
  assert.deepEqual(item, {
    id: "call_1",
    kind: "command",
    command: "whoami",
    display: "Show current shell user",
    status: "in_progress",
  });
});

test("mapToolCallUpdate recomputes display when rawInput arrives after the title did", () => {
  const started = mapToolCallStart({ toolCallId: "call_1", title: "Show current shell user", kind: "execute", status: "pending" }, cwd);
  assert.ok(started.kind === "command" && started.display === undefined);
  const updated = mapToolCallUpdate(started, { rawInput: { command: "whoami" } }, cwd);
  assert.ok(updated.kind === "command");
  assert.equal(updated.command, "whoami");
  assert.equal(updated.display, "Show current shell user");
});

test("mapToolCallUpdate reads a rejected call's rawOutput.message as output", () => {
  const started = mapToolCallStart({ toolCallId: "call_1", title: "Show current shell user", kind: "execute", status: "pending", rawInput: { command: "whoami" } }, cwd);
  const updated = mapToolCallUpdate(started, { status: "failed", rawOutput: { message: "The user rejected this tool call.", code: "rejected" } }, cwd);
  assert.ok(updated.kind === "command");
  assert.equal(updated.status, "failed");
  assert.equal(updated.output, "The user rejected this tool call.");
});

test("mapToolCallStart maps an edit call to a FileChangeItem once the diff arrives, with the path relative to cwd", () => {
  const started = mapToolCallStart({ toolCallId: "call_2", title: "Update file", kind: "edit", status: "pending", rawInput: "*** patch ***" }, cwd);
  assert.deepEqual(started, { id: "call_2", kind: "file_change", changes: [], status: "in_progress" });
  const updated = mapToolCallUpdate(
    started,
    {
      status: "completed",
      content: [{ type: "diff", path: path.join(cwd, "a.ts"), oldText: "one\n", newText: "two\n" }],
    },
    cwd,
  );
  assert.ok(updated.kind === "file_change");
  assert.equal(updated.changes[0]?.path, "a.ts");
  assert.equal(updated.changes[0]?.action, "modify");
  assert.match(updated.changes[0]?.diff ?? "", /-one/);
});

test("mapUsage maps Copilot's own token counts onto TermLink's Usage", () => {
  assert.deepEqual(mapUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, thoughtTokens: 5 }), { inputTokens: 100, outputTokens: 20 });
  assert.equal(mapUsage(undefined), undefined);
});
