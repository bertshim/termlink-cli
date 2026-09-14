import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider } from "../src/providers/claude/provider.js";
import { CodexProvider } from "../src/providers/codex/provider.js";

// node.exe stands in for a CLI whose --version works but whose login check does not:
// `node auth status` fails (there is no script called "auth").

test("a failed Claude login check is reported as a failed check, not as logged out", async () => {
  const status = await new ClaudeProvider({ executable: process.execPath }).probe();
  assert.equal(status.available, false);
  assert.match(status.detail ?? "", /^could not check the Claude login/);
  assert.equal(status.version, process.version);
});

test("a failed Codex login check is reported as a failed check, not as logged out", async () => {
  const status = await new CodexProvider({ command: { file: process.execPath, args: [] } }).probe();
  assert.equal(status.available, false);
  assert.match(status.detail ?? "", /^could not check the Codex login/);
});

test("an unavailable status is re-checked soon instead of being kept a minute", async () => {
  const provider = new ClaudeProvider({ executable: process.execPath });
  const first = await provider.probe();
  const cached = await provider.probe();
  assert.equal(cached, first, "within a few seconds the same result is reused");
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  const again = await provider.probe();
  assert.notEqual(again, first, "after the short TTL it runs again");
});
