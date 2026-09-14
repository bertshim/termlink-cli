import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Screen, createTerminal, defaultShell, ptyStatus, terminalEnv, type Terminal } from "../src/index.js";

const decoder = new TextDecoder();
const pty = ptyStatus();

/** Runs a node script as the "shell", so the test is the same on every platform. */
function script(source: string, cols = 80, rows = 24): Terminal {
  return createTerminal({ shell: process.execPath, args: ["-e", source], cwd: tmpdir(), cols, rows });
}

function collect(terminal: Terminal): { text: () => string; exited: Promise<number> } {
  let text = "";
  terminal.onData((data) => (text += decoder.decode(data, { stream: true })));
  const exited = new Promise<number>((resolve) => terminal.onExit((exit) => resolve(exit.exitCode)));
  return { text: () => text, exited };
}

test("defaultShell picks something that exists", () => {
  const shell = defaultShell();
  assert.ok(shell.file.length > 0);
});

test("terminalEnv sets what a terminal expects and keeps the rest", () => {
  const env = terminalEnv({ EXTRA: "1" }, { PATH: "/bin", HOME: "/home/x" });
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.EXTRA, "1");
});

test("the screen keeps what was written and serializes it", async () => {
  const screen = new Screen(20, 5, 100);
  screen.write("hello\r\nworld");
  const snapshot = await screen.snapshot();
  assert.match(snapshot, /hello/);
  assert.match(snapshot, /world/);
  screen.resize(40, 10);
  assert.equal(screen.cols, 40);
  screen.dispose();
});

test("output streams, the size reaches the child and the exit code comes back", { skip: pty.available ? false : (pty.detail ?? true) }, async () => {
  const terminal = script("process.stdout.write('cols=' + process.stdout.columns + ' 日本語'); process.exit(3)", 100, 30);
  const out = collect(terminal);
  assert.equal(await out.exited, 3);
  assert.match(out.text(), /cols=100/);
  assert.match(out.text(), /日本語/);
  assert.equal(terminal.exit?.exitCode, 3);
});

test("input reaches the child", { skip: pty.available ? false : (pty.detail ?? true) }, async () => {
  const terminal = script(
    "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { process.stdout.write('got:' + d.trim()); process.exit(0) })",
  );
  const out = collect(terminal);
  await new Promise((r) => setTimeout(r, 300));
  terminal.write(new TextEncoder().encode("abc\r"));
  assert.equal(await out.exited, 0);
  assert.match(out.text(), /got:abc/);
});

test("a snapshot holds what the child printed, and resize is remembered", { skip: pty.available ? false : (pty.detail ?? true) }, async () => {
  const terminal = script("process.stdout.write('line one\\r\\nline two\\r\\n'); setTimeout(() => process.exit(0), 1500)");
  const out = collect(terminal);
  await new Promise((r) => setTimeout(r, 500));
  const snapshot = decoder.decode(await terminal.snapshot());
  assert.match(snapshot, /line one/);
  assert.match(snapshot, /line two/);
  terminal.resize(120, 40);
  assert.equal(terminal.cols, 120);
  assert.equal(terminal.rows, 40);
  terminal.pause();
  terminal.resume();
  terminal.kill();
  await out.exited;
  assert.ok(terminal.exit);
});
