import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { fileChangesFor } from "../src/providers/claude/mapper.js";
import { ClaudeProvider } from "../src/providers/claude/provider.js";
import { SessionManager } from "../src/session/manager.js";
import { createFakeQuery } from "./fixtures/fake-claude.js";
import { Recorder } from "./support.js";

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-claude-"));
  const file = path.join(dir, "src.ts");
  writeFileSync(file, "export function f() {\n  return 1;\n}\n");
  return { dir, file };
}

async function open() {
  const { dir, file } = workspace();
  const fake = createFakeQuery(file);
  const manager = new SessionManager({ providers: [new ClaudeProvider({ queryFn: fake.queryFn })] });
  const session = await manager.createAgent({ provider: "claude", cwd: dir });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec, log: fake.log };
}

function completed(events: AgentEvent[]) {
  return events.filter(isType("item.completed")).map((e) => e.payload.item);
}

test("maps a Claude turn: thinking, streamed text, approved Bash, Edit diff, usage", async () => {
  const { manager, session, rec, log } = await open();
  try {
    assert.equal(session.info.providerSessionId, log.options[0]?.sessionId);
    assert.match(session.info.providerSessionId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(log.options[0]?.includePartialMessages, true);

    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    const { request } = required.payload;
    assert.equal(request.kind, "command_approval");
    assert.equal(request.command, "npm test");
    assert.equal(request.title, "Claude wants to run npm test");
    assert.deepEqual(request.decisions.map((d) => d.id), ["allow", "allow_session", "deny", "stop"]);
    session.respond(request.requestId, "allow_session");

    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.deepEqual(done.payload.usage, { inputTokens: 100, outputTokens: 5, costUsd: 0.01 });
    for (const event of rec.items) AgentEvent.parse(event);

    const granted = log.permissions[0];
    assert.ok(granted?.behavior === "allow");
    assert.equal(granted.updatedPermissions?.length, 1);

    const items = completed(rec.items);
    assert.deepEqual(items.map((i) => i.kind), ["message", "reasoning", "message", "command", "file_change", "message"]);
    const [, thinking, reply, command, edit, final] = items;
    assert.ok(thinking?.kind === "reasoning" && thinking.text === "Tests first.");
    assert.ok(reply?.kind === "message" && reply.text === "Running tests");
    assert.ok(command?.kind === "command");
    assert.equal(command.output, "ok\n");
    assert.equal(command.exitCode, 0);
    assert.ok(edit?.kind === "file_change");
    assert.equal(edit.changes[0]?.path, "src.ts");
    assert.match(edit.changes[0]?.diff ?? "", /-  return 1;\n\+  return 2;/);
    assert.match(edit.changes[0]?.diff ?? "", /^--- a\/src\.ts/);
    assert.ok(final?.kind === "message" && final.text === "Done");

    const streamed = rec.items
      .filter(isType("item.delta"))
      .filter((e) => e.payload.itemId === reply.id)
      .map((e) => e.payload.delta)
      .join("");
    assert.equal(streamed, "Running tests");
  } finally {
    await manager.shutdown();
  }
});

test("thinking with its text omitted shows as a reasoning item from its first moment", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "quiet fail" });
    await rec.waitFor(isType("turn.completed"));
    // The reasoning item starts with its block, before the reply, though no text ever comes.
    const started = rec.items.filter(isType("item.started")).map((e) => e.payload.item);
    assert.deepEqual(started.map((i) => i.kind), ["reasoning", "message"]);
    const thinking = completed(rec.items).find((i) => i.kind === "reasoning");
    assert.ok(thinking?.kind === "reasoning" && thinking.text === "" && thinking.status === "completed");
  } finally {
    await manager.shutdown();
  }
});

async function openRetrying(delays: number[]) {
  const { dir, file } = workspace();
  const fake = createFakeQuery(file);
  const manager = new SessionManager({ providers: [new ClaudeProvider({ queryFn: fake.queryFn, authRetryDelaysMs: delays })] });
  const session = await manager.createAgent({ provider: "claude", cwd: dir });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec, log: fake.log };
}

const REFRESH = /Failed to refresh OAuth token/;
const shownErrors = (events: AgentEvent[]) =>
  completed(events).filter((i) => i.kind === "message" && i.role === "assistant" && REFRESH.test(i.text));

test("a turn that failed on the login-refresh race is sent again, and its error is never shown", async () => {
  const { manager, session, rec, log } = await openRetrying([20, 20]);
  try {
    await session.send({ text: "refresh-once quick" });
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    // One turn as the reader sees it; the message went to Claude Code twice.
    assert.equal(rec.items.filter(isType("turn.started")).length, 1);
    assert.deepEqual(log.inputs.map((m) => m.message.content), ["refresh-once quick", "refresh-once quick"]);
    assert.equal(shownErrors(rec.items).length, 0);
    const retry = rec.items.find(isType("provider.event"));
    assert.equal(retry?.payload.name, "claude.retry");
    for (const event of rec.items) AgentEvent.parse(event);
  } finally {
    await manager.shutdown();
  }
});

test("when every resend fails too, the turn fails as before, with the error shown once", async () => {
  const { manager, session, rec, log } = await openRetrying([10, 10]);
  try {
    await session.send({ text: "refresh-always quick" });
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "failed");
    assert.match(done.payload.error ?? "", REFRESH);
    assert.equal(log.inputs.length, 3);
    assert.equal(shownErrors(rec.items).length, 1);
  } finally {
    await manager.shutdown();
  }
});

test("Stop while a resend is waiting ends the turn and sends nothing more", async () => {
  const { manager, session, rec, log } = await openRetrying([60_000]);
  try {
    await session.send({ text: "refresh-always quick" });
    await rec.waitFor((e) => e.type === "provider.event" && e.payload.name === "claude.retry");
    await session.interrupt();
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(log.inputs.length, 1);
  } finally {
    await manager.shutdown();
  }
});

test("a denied Bash command is reported as declined", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    session.respond(required.payload.request.requestId, "deny");
    await rec.waitFor(isType("turn.completed"));
    const command = completed(rec.items).find((i) => i.kind === "command");
    assert.equal(command?.status, "declined");
  } finally {
    await manager.shutdown();
  }
});

test("interrupting during a Claude approval cancels it and ends the turn", async () => {
  const { manager, session, rec, log } = await open();
  try {
    await session.send({ text: "run the tests" });
    await rec.waitFor(isType("input.required"));
    await session.interrupt();
    assert.equal(rec.items.find(isType("input.resolved"))?.payload.effect, "cancel");
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    assert.equal(session.info.status, "idle");
    // One process for the whole session: a Stop the CLI honours does not restart it.
    assert.equal(log.options.length, 1);
  } finally {
    await manager.shutdown();
  }
});

test("AskUserQuestion becomes a question request and answers go back by question text", async () => {
  const { manager, session, rec, log } = await open();
  try {
    await session.send({ text: "ask me" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    const { request } = required.payload;
    assert.equal(request.kind, "question");
    assert.equal(request.questions?.[0]?.question, "Which database?");
    assert.deepEqual(request.questions?.[0]?.options.map((o) => o.label), ["Postgres", "SQLite"]);
    session.respond(request.requestId, "submit", { "0": "SQLite" });
    await rec.waitFor(isType("turn.completed"));
    const answered = log.permissions[0];
    assert.ok(answered?.behavior === "allow");
    assert.deepEqual(answered.updatedInput?.answers, { "Which database?": "SQLite" });
  } finally {
    await manager.shutdown();
  }
});

test("an error result fails the turn", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "please fail" });
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "failed");
    assert.equal(done.payload.error, "something broke");
  } finally {
    await manager.shutdown();
  }
});

test("fileChangesFor diffs Write against the current file and falls back for stale edits", () => {
  const { dir, file } = workspace();
  const created = fileChangesFor("Write", { file_path: path.join(dir, "new.txt"), content: "hello\n" }, dir);
  assert.equal(created?.[0]?.action, "add");
  assert.match(created?.[0]?.diff ?? "", /\+hello/);

  const rewritten = fileChangesFor("Write", { file_path: file, content: "x\n" }, dir);
  assert.equal(rewritten?.[0]?.action, "modify");
  assert.match(rewritten?.[0]?.diff ?? "", /-export function f\(\) \{/);

  const stale = fileChangesFor("Edit", { file_path: file, old_string: "not there", new_string: "y" }, dir);
  assert.match(stale?.[0]?.diff ?? "", /-not there\n\+y/);

  assert.equal(fileChangesFor("Bash", { command: "ls" }, dir), null);
});

test("probe reports Claude as unavailable when the executable is missing", async () => {
  const status = await new ClaudeProvider({ executable: path.join(tmpdir(), "no-such-claude.exe") }).probe();
  assert.equal(status.available, false);
});
