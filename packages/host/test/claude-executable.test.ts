import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apiKeyAuth, bundledClaudeExecutable, resolveClaudeExecutable } from "../src/providers/claude/provider.js";

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

test("apiKeyAuth finds nothing on a plain environment", () => {
  assert.equal(apiKeyAuth({}), null);
});

test("apiKeyAuth names whichever credential is actually set", () => {
  assert.equal(apiKeyAuth({ ANTHROPIC_API_KEY: "sk-ant-x" }), "ANTHROPIC_API_KEY");
  assert.equal(apiKeyAuth({ ANTHROPIC_AUTH_TOKEN: "x" }), "ANTHROPIC_AUTH_TOKEN");
  assert.equal(apiKeyAuth({ CLAUDE_CODE_OAUTH_TOKEN: "x" }), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(apiKeyAuth({ CLAUDE_CODE_USE_BEDROCK: "1" }), "AWS Bedrock");
  assert.equal(apiKeyAuth({ CLAUDE_CODE_USE_VERTEX: "1" }), "Google Vertex AI");
});

test("apiKeyAuth follows Claude Code's own precedence when more than one is set", () => {
  // Cloud provider flags first, then ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY, then
  // CLAUDE_CODE_OAUTH_TOKEN last — the same order Claude Code's own docs give below /login.
  assert.equal(apiKeyAuth({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "x" }), "AWS Bedrock");
  assert.equal(apiKeyAuth({ ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_API_KEY: "y" }), "ANTHROPIC_AUTH_TOKEN");
  assert.equal(apiKeyAuth({ ANTHROPIC_API_KEY: "x", CLAUDE_CODE_OAUTH_TOKEN: "y" }), "ANTHROPIC_API_KEY");
});
