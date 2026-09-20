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
} from "../src/providers/cursor/mapper.js";

const cwd = tmpdir();

test("commandOf prefers rawInput.command, then falls back to the title unquoted", () => {
  assert.equal(commandOf({ command: "npm test" }, "`something else`"), "npm test");
  assert.equal(commandOf(undefined, "`npm test`"), "npm test");
  assert.equal(commandOf({}, "npm test"), "npm test");
});

test("blockText joins text blocks and skips anything else", () => {
  assert.equal(blockText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "ab");
  assert.equal(blockText(undefined), "");
});

test("mapDecisions maps allow_once/allow_always/reject_* to allow/allow_session/deny", () => {
  const decisions = mapDecisions([
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
  ]);
  assert.deepEqual(decisions, [
    { id: "allow-once", label: "Allow once", effect: "allow" },
    { id: "allow-always", label: "Allow always", effect: "allow_session" },
    { id: "reject-once", label: "Reject", effect: "deny" },
    { id: "reject-always", label: "Reject always", effect: "deny" },
  ]);
});

test("isCommandKind is true only for execute", () => {
  assert.equal(isCommandKind("execute"), true);
  for (const kind of ["read", "edit", "delete", "move", "search", "think", "fetch", "other"] as const) {
    assert.equal(isCommandKind(kind), false);
  }
});

test("isEditKind is true only for edit", () => {
  assert.equal(isEditKind("edit"), true);
  for (const kind of ["execute", "read", "delete", "move", "search", "think", "fetch", "other"] as const) {
    assert.equal(isEditKind(kind), false);
  }
});

test("approvalBody reads only the content-wrapped text, not a diff entry", () => {
  const body = approvalBody([
    { type: "content", content: { type: "text", text: "Not in allowlist: whoami" } },
    { type: "diff", path: "a.ts", oldText: "old", newText: "new" },
  ]);
  assert.equal(body, "Not in allowlist: whoami");
  assert.equal(approvalBody(undefined), "");
});

test("mapToolCallStart maps an execute call to a CommandItem", () => {
  const item = mapToolCallStart(
    {
      toolCallId: "call_1",
      title: "`npm test`",
      kind: "execute",
      status: "pending",
      rawInput: { command: "npm test" },
    },
    cwd,
  );
  assert.deepEqual(item, { id: "call_1", kind: "command", command: "npm test", status: "in_progress" });
});

test("mapToolCallStart keeps a display title only when it differs from the command", () => {
  const item = mapToolCallStart(
    {
      toolCallId: "call_1",
      title: "Run the test suite",
      kind: "execute",
      status: "pending",
      rawInput: { command: "npm test" },
    },
    cwd,
  );
  assert.ok(item.kind === "command");
  assert.equal(item.display, "Run the test suite");
});

test("mapToolCallStart maps a non-execute call to a generic ToolItem named after its kind", () => {
  const item = mapToolCallStart(
    {
      toolCallId: "call_2",
      title: "Read File",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "a.ts" },
    },
    cwd,
  );
  assert.deepEqual(item, { id: "call_2", kind: "tool", name: "read", input: { path: "a.ts" }, output: undefined, status: "in_progress" });
});

test("mapToolCallUpdate folds a completed patch into a running command", () => {
  const started = mapToolCallStart({ toolCallId: "call_1", title: "`npm test`", kind: "execute", status: "pending", rawInput: { command: "npm test" } }, cwd);
  const updated = mapToolCallUpdate(started, { status: "completed", rawOutput: { exitCode: 0, stdout: "ok\n", stderr: "" } }, cwd);
  assert.deepEqual(updated, { id: "call_1", kind: "command", command: "npm test", status: "completed", output: "ok\n", exitCode: 0 });
});

test("mapToolCallUpdate recomputes display when rawInput arrives after the title did", () => {
  // No rawInput yet: command falls back to the (unquoted) title, so they match and no
  // display is kept — same as "mapToolCallStart maps an execute call to a CommandItem".
  const started = mapToolCallStart({ toolCallId: "call_1", title: "Run the test suite", kind: "execute", status: "pending" }, cwd);
  assert.ok(started.kind === "command" && started.display === undefined);
  const updated = mapToolCallUpdate(started, { rawInput: { command: "npm test" } }, cwd);
  assert.ok(updated.kind === "command");
  assert.equal(updated.command, "npm test");
  // The friendlier title must not be lost now that it genuinely differs from the command.
  assert.equal(updated.display, "Run the test suite");
});

test("mapToolCallUpdate drops display once a later patch's command catches up to the title", () => {
  const started = mapToolCallStart({ toolCallId: "call_1", title: "Run the test suite", kind: "execute", status: "pending", rawInput: { command: "npm test" } }, cwd);
  assert.ok(started.kind === "command" && started.display === "Run the test suite");
  const updated = mapToolCallUpdate(started, { title: "npm test", rawInput: { command: "npm test" } }, cwd);
  assert.ok(updated.kind === "command" && updated.display === undefined);
});

test("mapToolCallStart maps an edit call to an empty FileChangeItem before the diff arrives", () => {
  const item = mapToolCallStart({ toolCallId: "call_3", title: "Edit File", kind: "edit", status: "pending", rawInput: {} }, cwd);
  assert.deepEqual(item, { id: "call_3", kind: "file_change", changes: [], status: "in_progress" });
});

test("mapToolCallUpdate turns a completed edit's diff content into a real unified diff, with the path relative to cwd", () => {
  const started = mapToolCallStart({ toolCallId: "call_3", title: "Edit File", kind: "edit", status: "pending", rawInput: {} }, cwd);
  const updated = mapToolCallUpdate(
    started,
    {
      status: "completed",
      content: [{ type: "diff", path: path.join(cwd, "a.ts"), oldText: "one\n", newText: "two\n" }],
    },
    cwd,
  );
  assert.ok(updated.kind === "file_change");
  assert.equal(updated.status, "completed");
  assert.equal(updated.changes.length, 1);
  assert.equal(updated.changes[0]?.path, "a.ts");
  assert.equal(updated.changes[0]?.action, "modify");
  assert.match(updated.changes[0]?.diff ?? "", /^--- a\/a\.ts/);
  assert.match(updated.changes[0]?.diff ?? "", /-one/);
  assert.match(updated.changes[0]?.diff ?? "", /\+two/);
});

test("mapToolCallUpdate treats a null oldText as a new file", () => {
  const started = mapToolCallStart({ toolCallId: "call_4", title: "Edit File", kind: "edit", status: "pending", rawInput: {} }, cwd);
  const updated = mapToolCallUpdate(
    started,
    {
      status: "completed",
      content: [{ type: "diff", path: path.join(cwd, "b.ts"), oldText: null, newText: "new file\n" }],
    },
    cwd,
  );
  assert.ok(updated.kind === "file_change");
  assert.equal(updated.changes[0]?.action, "add");
});

test("mapToolCallUpdate on an edit call leaves the diff alone when the patch has no content", () => {
  const started = mapToolCallStart({ toolCallId: "call_3", title: "Edit File", kind: "edit", status: "pending", rawInput: {} }, cwd);
  const withDiff = mapToolCallUpdate(started, { content: [{ type: "diff", path: path.join(cwd, "a.ts"), oldText: "one\n", newText: "two\n" }] }, cwd);
  const inProgress = mapToolCallUpdate(withDiff, { status: "in_progress" }, cwd);
  assert.ok(inProgress.kind === "file_change");
  assert.deepEqual(inProgress.changes, (withDiff as { kind: "file_change"; changes: unknown }).changes);
  assert.equal(inProgress.status, "in_progress");
});

test("mapToolCallUpdate leaves fields the patch does not mention alone", () => {
  const started = mapToolCallStart({ toolCallId: "call_2", title: "Read File", kind: "read", status: "pending", rawInput: { path: "a.ts" } }, cwd);
  const updated = mapToolCallUpdate(started, { status: "in_progress" }, cwd);
  assert.deepEqual(updated, { id: "call_2", kind: "tool", name: "read", input: { path: "a.ts" }, output: undefined, status: "in_progress" });
});

test("mapToolCallUpdate keeps a diff path outside cwd unchanged", () => {
  const started = mapToolCallStart({ toolCallId: "call_5", title: "Edit File", kind: "edit", status: "pending", rawInput: {} }, cwd);
  const outside = path.join(path.parse(cwd).root, "elsewhere", "c.ts");
  const updated = mapToolCallUpdate(started, { status: "completed", content: [{ type: "diff", path: outside, oldText: "a", newText: "b" }] }, cwd);
  assert.ok(updated.kind === "file_change");
  assert.equal(updated.changes[0]?.path, outside);
});
