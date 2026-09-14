import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { completeToolItem, mapToolUse } from "../src/providers/claude/mapper.js";

test("PowerShell and Bash both map to command items", () => {
  const cwd = tmpdir();
  for (const tool of ["Bash", "PowerShell"]) {
    const item = mapToolUse("t1", tool, { command: "node --version", description: "Print Node version" }, cwd);
    assert.deepEqual(item, { id: "t1", kind: "command", command: "node --version", cwd, status: "in_progress" });
  }
});

test("command results carry output and an exit code parsed from errors", () => {
  const item = mapToolUse("t1", "Bash", { command: "false" }, tmpdir());
  const failed = completeToolItem(item, { content: "Exit code 2\nboom", is_error: true }, undefined, false);
  assert.ok(failed.kind === "command");
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.status, "failed");

  const ok = completeToolItem(item, { content: "ignored", is_error: false }, { stdout: "out", stderr: "warn" }, false);
  assert.ok(ok.kind === "command");
  assert.equal(ok.output, "out\nwarn");
  assert.equal(ok.exitCode, 0);

  const declined = completeToolItem(item, { content: "denied", is_error: true }, undefined, true);
  assert.equal(declined.status, "declined");
});

test("TodoWrite maps to a todo item and other tools to generic tool items", () => {
  const todo = mapToolUse(
    "t2",
    "TodoWrite",
    { todos: [{ content: "Write tests", status: "completed", activeForm: "Writing tests" }] },
    tmpdir(),
  );
  assert.deepEqual(todo, { id: "t2", kind: "todo", entries: [{ text: "Write tests", done: true }], status: "in_progress" });

  const grep = mapToolUse("t3", "Grep", { pattern: "TODO" }, tmpdir());
  assert.deepEqual(grep, { id: "t3", kind: "tool", name: "Grep", input: { pattern: "TODO" }, status: "in_progress" });
});
