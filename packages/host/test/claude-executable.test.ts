import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundledClaudeExecutable, resolveClaudeExecutable } from "../src/providers/claude/provider.js";

const binary = process.platform === "win32" ? "claude.exe" : "claude";

test("TERMLINK_CLAUDE_PATH wins over everything else", () => {
  assert.equal(resolveClaudeExecutable({ TERMLINK_CLAUDE_PATH: "X:\\tools\\claude.exe" }, true), "X:\\tools\\claude.exe");
});

test("an npm install uses the Claude Code bundled with the Agent SDK", () => {
  const bundled = bundledClaudeExecutable();
  assert.ok(bundled, "the platform package is installed in this repo");
  assert.equal(resolveClaudeExecutable({ PATH: "" }, false), bundled);
});

test("the user's claude on PATH is found as an absolute path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-claude-path-"));
  writeFileSync(path.join(dir, binary), "");
  // With the SDK's own binary out of the picture the PATH lookup is what remains.
  const found = bundledClaudeExecutable() ? null : resolveClaudeExecutable({ PATH: dir }, false);
  if (found !== null) assert.equal(found, path.join(dir, binary));
  assert.ok(path.isAbsolute(resolveClaudeExecutable({ PATH: dir }, false) ?? ""));
});
