import assert from "node:assert/strict";
import { test } from "node:test";
import { displayCommand } from "../src/providers/display.js";

test("unwraps the PowerShell wrapper Codex uses on Windows", () => {
  const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'node --version'`;
  assert.equal(displayCommand(command), "node --version");
  assert.equal(displayCommand(`powershell.exe -NoProfile -Command 'Write-Output ''hi'''`), "Write-Output 'hi'");
  assert.equal(displayCommand(`pwsh -Command "Get-ChildItem"`), "Get-ChildItem");
});

test("unwraps sh -lc wrappers", () => {
  assert.equal(displayCommand(`/bin/zsh -lc 'npm test'`), "npm test");
  assert.equal(displayCommand(`bash -c "ls -la"`), "ls -la");
});

test("prefers a single parsed action and leaves plain commands alone", () => {
  assert.equal(displayCommand(`/bin/zsh -lc 'cat a.txt'`, [{ command: "cat a.txt" }]), "cat a.txt");
  assert.equal(displayCommand("npm test"), undefined);
  assert.equal(displayCommand("npm test", [{ command: "npm test" }]), undefined);
  // Several actions (a pipeline) fall back to unwrapping the whole command.
  assert.equal(displayCommand(`bash -lc 'ls | wc -l'`, [{ command: "ls" }, { command: "wc -l" }]), "ls | wc -l");
});
