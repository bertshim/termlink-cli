import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentEvent, EventOf } from "@termlink/protocol";
import { claudeHistory, type TranscriptMessage } from "../src/providers/claude/history.js";
import { ClaudeProvider } from "../src/providers/claude/provider.js";
import { CodexProvider } from "../src/providers/codex/provider.js";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createFakeQuery } from "./fixtures/fake-claude.js";
import { Recorder } from "./support.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.ts", import.meta.url));
const codexCommand = { file: process.execPath, args: ["--import", "tsx", fixture] };

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-resume-"));
  const file = path.join(dir, "src.ts");
  writeFileSync(file, "export function f() {\n  return 1;\n}\n");
  return { dir, file, store: new SessionStore(path.join(dir, "sessions.json")) };
}

/** Runs one approved turn. */
async function runTurn(session: { send: (i: { text: string }) => Promise<void>; respond: (r: string, d: string) => void }, rec: Recorder, text: string, allow: string) {
  const mark = rec.items.length;
  await session.send({ text });
  const required = (await rec.waitFor(isType("input.required"), mark)) as EventOf<"input.required">;
  session.respond(required.payload.request.requestId, allow);
  await rec.waitFor(isType("turn.completed"), mark);
}

test("a Codex session comes back after a restart, with its history, and keeps going", async () => {
  const { dir, store } = workspace();
  process.env.FAKE_CODEX_STATE = path.join(dir, "codex-state.json");
  try {
    const first = new SessionManager({ providers: [new CodexProvider({ command: codexCommand })], store });
    const original = await first.createAgent({ provider: "codex", cwd: dir, title: "fix tests" });
    const rec = new Recorder();
    original.attach(rec.push);
    await runTurn(original, rec, "run the tests", "accept");
    const threadId = original.info.providerSessionId;
    await first.shutdown();

    const saved = await store.load();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.providerSessionId, threadId);
    assert.equal(saved[0]?.title, "fix tests");

    const second = new SessionManager({ providers: [new CodexProvider({ command: codexCommand })], store });
    try {
      assert.equal(await second.restore(), 1);
      const restored = second.agent(original.id);
      assert.equal(restored.info.status, "idle");
      assert.equal(restored.info.providerSessionId, threadId);

      const again = new Recorder();
      const { replay } = restored.attach(again.push, 0);
      const items = replay.filter(isType("item.completed")).map((e) => e.payload.item);
      assert.deepEqual(items.map((i) => i.kind), ["message", "message", "command"]);
      assert.ok(items[0]?.kind === "message" && items[0].role === "user" && items[0].text === "run the tests");
      const started = replay.find(isType("turn.started"));
      assert.equal(started?.payload.userItemId, items[0]?.id);

      // The first send resumes the thread.
      await runTurn(restored, again, "and again", "accept");
      assert.equal(again.items.filter(isType("turn.completed")).at(-1)?.payload.status, "completed");
    } finally {
      await second.shutdown();
    }
  } finally {
    delete process.env.FAKE_CODEX_STATE;
  }
});

test("a Claude session comes back with its transcript and resumes by session id", async () => {
  const { dir, file, store } = workspace();
  const fake = createFakeQuery(file);
  const calls: { id: string; dir: string }[] = [];
  const transcript: TranscriptMessage[] = [
    { type: "user", uuid: "u1", message: { role: "user", content: "run the tests" }, parent_tool_use_id: null },
    {
      type: "assistant",
      uuid: "a1",
      message: { content: [{ type: "text", text: "Running tests" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
      parent_tool_use_id: null,
    },
    { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] }, parent_tool_use_id: null },
    { type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "Done" }] }, parent_tool_use_id: null },
  ];
  const provider = () =>
    new ClaudeProvider({
      queryFn: fake.queryFn,
      historyFn: async (id, opts) => {
        calls.push({ id, dir: opts.dir });
        return transcript;
      },
    });

  const first = new SessionManager({ providers: [provider()], store });
  const original = await first.createAgent({ provider: "claude", cwd: dir });
  const rec = new Recorder();
  original.attach(rec.push);
  await runTurn(original, rec, "run the tests", "allow");
  const claudeSessionId = original.info.providerSessionId;
  await first.shutdown();

  const second = new SessionManager({ providers: [provider()], store });
  try {
    assert.equal(await second.restore(), 1);
    assert.deepEqual(calls, [{ id: claudeSessionId, dir: second.agent(original.id).info.cwd }]);
    const restored = second.agent(original.id);
    const again = new Recorder();
    const items = restored
      .attach(again.push, 0)
      .replay.filter(isType("item.completed"))
      .map((e) => e.payload.item);
    assert.deepEqual(items.map((i) => i.kind), ["message", "message", "command", "message"]);
    const command = items[2];
    assert.ok(command?.kind === "command" && command.output === "ok" && command.exitCode === 0);

    await runTurn(restored, again, "run the tests", "allow");
    assert.equal(fake.log.options.at(-1)?.resume, claudeSessionId);
  } finally {
    await second.shutdown();
  }
});

test("opening a restored Claude session resumes it before the first message", async () => {
  const { dir, file, store } = workspace();
  const fake = createFakeQuery(file);
  const provider = () => new ClaudeProvider({ queryFn: fake.queryFn, historyFn: async () => [] });

  const first = new SessionManager({ providers: [provider()], store });
  const original = await first.createAgent({ provider: "claude", cwd: dir });
  const rec = new Recorder();
  original.attach(rec.push);
  await runTurn(original, rec, "run the tests", "allow");
  const claudeSessionId = original.info.providerSessionId;
  await first.shutdown();

  const second = new SessionManager({ providers: [provider()], store });
  try {
    assert.equal(await second.restore(), 1);
    const started = fake.log.options.length;
    const restored = second.agent(original.id);
    const again = new Recorder();
    restored.attach(again.push, 0);
    // Nothing starts inside attach itself: its reply and replay go out first.
    assert.equal(fake.log.options.length, started);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.log.options.length, started + 1);
    assert.equal(fake.log.options.at(-1)?.resume, claudeSessionId);

    // The first message uses the process that is already there.
    await runTurn(restored, again, "run the tests", "allow");
    assert.equal(fake.log.options.length, started + 1);
  } finally {
    await second.shutdown();
  }
});

test("closing a session forgets it; fake sessions are never stored", async () => {
  const { dir, file, store } = workspace();
  const fake = createFakeQuery(file);
  const manager = new SessionManager({
    providers: [new ClaudeProvider({ queryFn: fake.queryFn, historyFn: async () => [] }), new FakeProvider({ stepDelayMs: 0 })],
    store,
  });
  try {
    const claude = await manager.createAgent({ provider: "claude", cwd: dir });
    const rec = new Recorder();
    claude.attach(rec.push);
    await runTurn(claude, rec, "run the tests", "allow");
    const scripted = await manager.createAgent({ provider: "fake", cwd: dir });
    await scripted.send({ text: "/echo hi" });
    await sleep(250);
    assert.deepEqual((await store.load()).map((r) => r.provider), ["claude"]);

    await manager.close(claude.id);
    await sleep(250);
    assert.deepEqual(await store.load(), []);
  } finally {
    await manager.shutdown();
  }
});

test("claudeHistory skips injected and sub-agent messages and diffs edits without reading files", () => {
  const { dir, file } = workspace();
  const turns = claudeHistory(
    [
      { type: "user", uuid: "c", message: { content: "<command-name>/clear</command-name>" }, parent_tool_use_id: null },
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "rename it" }] }, parent_tool_use_id: null },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: file, old_string: "return 1;", new_string: "return 2;" } }] },
        parent_tool_use_id: null,
      },
      { type: "assistant", uuid: "sub", message: { content: [{ type: "text", text: "inside a task" }] }, parent_tool_use_id: "task1" },
      { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "done" }] }, parent_tool_use_id: null },
      { type: "user", uuid: "u3", message: { content: "next question" }, parent_tool_use_id: null },
      { type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] }, parent_tool_use_id: null },
    ],
    dir,
  );
  assert.equal(turns.length, 2);
  const [edit] = turns[0]?.items.slice(1) ?? [];
  assert.ok(edit?.kind === "file_change");
  // Diffed from the edit itself (a one-line hunk), not from the whole file on disk.
  assert.match(edit.changes[0]?.diff ?? "", /@@ -1,1 \+1,1 @@\n-return 1;\n\+return 2;/);
  // A tool left without a result is shown as interrupted.
  assert.equal(turns[1]?.items[1]?.status, "interrupted");
});
