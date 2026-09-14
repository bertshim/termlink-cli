import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { ClaudeProvider } from "../src/providers/claude/provider.js";
import { SessionManager } from "../src/session/manager.js";
import { createFakeQuery } from "./fixtures/fake-claude.js";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { Recorder } from "./support.js";

// Stop, as a state machine (PROTOCOL.md, "Session status" and "Stop"): the session is `interrupting`
// until the turn ends, a message typed meanwhile waits its turn, and a Claude Code that
// does not end the turn in time is replaced on the same session.

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

const statuses = (events: AgentEvent[]) =>
  events.filter(isType("session.updated")).map((e) => e.payload.session.status);

test("Stop puts the session in `interrupting` until the turn ends, then idle", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0, interruptDelayMs: 150 })] });
  const lifecycle = new Recorder();
  manager.onHostEvent(lifecycle.push);
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "fix the failing test" });
    await rec.waitFor(isType("input.required"));

    const stop = session.interrupt();
    assert.equal(session.info.status, "interrupting");
    // A second Stop shares the first one's wait rather than interrupting twice.
    const again = session.interrupt();
    await Promise.all([stop, again]);
    assert.equal(session.info.status, "idle");
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    assert.deepEqual(statuses(lifecycle.items).slice(-3), ["waiting_input", "interrupting", "idle"]);
  } finally {
    await manager.shutdown();
  }
});

test("a message typed while stopping is held, then opens the next turn", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0, interruptDelayMs: 150 })] });
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "fix the failing test" });
    await rec.waitFor(isType("input.required"));

    const stop = session.interrupt();
    const next = session.send({ text: "/echo after the stop" });
    await stop;
    await next;
    await rec.waitFor((e) => e.type === "turn.completed" && e.payload.status === "completed");
    const turns = rec.items.filter(isType("turn.completed")).map((e) => e.payload.status);
    assert.deepEqual(turns, ["interrupted", "completed"]);
    const users = rec.items
      .filter(isType("item.completed"))
      .filter((e) => e.payload.item.kind === "message" && e.payload.item.role === "user");
    assert.equal(users.length, 2);
    // Not steered into the stopped turn: it opened its own.
    assert.equal(users[1]?.payload.turnId, null);
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("a client-chosen message id becomes the user item's id", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "/echo hi", id: "w1-m1" });
    const started = (await rec.waitFor(isType("turn.started"))) as EventOf<"turn.started">;
    assert.equal(started.payload.userItemId, "w1-m1");
    await rec.waitFor(isType("turn.completed"));
    for (const event of rec.items) AgentEvent.parse(event);
  } finally {
    await manager.shutdown();
  }
});

function fakeClaude(interruptTimeoutMs?: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-interrupt-"));
  const file = path.join(dir, "src.ts");
  writeFileSync(file, "export function f() {\n  return 1;\n}\n");
  const fake = createFakeQuery(file);
  const provider = new ClaudeProvider({
    queryFn: fake.queryFn,
    executable: "claude",
    ...(interruptTimeoutMs !== undefined ? { interruptTimeoutMs } : {}),
  });
  return { provider, log: fake.log, dir };
}

test("Claude: a tool cut short by Stop is reported as stopped, not failed", async () => {
  const { provider, log } = fakeClaude();
  const manager = new SessionManager({ providers: [provider] });
  try {
    const session = await manager.createAgent({ provider: "claude", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "run the tests" });
    await rec.waitFor(isType("input.required"));
    await session.interrupt();
    const command = rec.items
      .filter(isType("item.completed"))
      .map((e) => e.payload.item)
      .find((i) => i.kind === "command");
    assert.equal(command?.status, "interrupted");
    assert.deepEqual(log.interrupts, [{ cancelQueued: true }]);
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
  } finally {
    await manager.shutdown();
  }
});

test("Claude: a process that does not end the turn in time is replaced, resumed on the same session", async () => {
  const { provider, log } = fakeClaude(200);
  const manager = new SessionManager({ providers: [provider] });
  try {
    const session = await manager.createAgent({ provider: "claude", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);
    const claudeId = session.info.providerSessionId;
    // A finished turn first: that is what there is to resume.
    await session.send({ text: "run the tests" });
    const first = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    session.respond(first.payload.request.requestId, "allow");
    await rec.waitFor(isType("turn.completed"));

    let mark = rec.items.length;
    await session.send({ text: "stubborn: run the tests" });
    await rec.waitFor(isType("input.required"), mark);
    const t0 = Date.now();
    await session.interrupt();
    assert.ok(Date.now() - t0 < 2500, "Stop resolved within the timeout, not the SDK's own time");
    assert.equal(rec.items.filter(isType("turn.completed")).at(-1)?.payload.status, "interrupted");
    assert.equal(session.info.status, "idle");
    // A second process, resumed on the same Claude session.
    assert.equal(log.options.length, 2);
    assert.equal(log.options[1]?.resume, claudeId);
    assert.equal(session.info.providerSessionId, claudeId);
    assert.ok(rec.items.some((e) => e.type === "provider.event" && e.payload.name === "claude.restarted"));

    // The conversation goes on with the new process.
    mark = rec.items.length;
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"), mark)) as EventOf<"input.required">;
    session.respond(required.payload.request.requestId, "allow");
    const done = (await rec.waitFor(isType("turn.completed"), mark)) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.equal(log.inputs.length, 3);
    // The first process's frames after its replacement never reach the session.
    await sleep(50);
    assert.equal(rec.items.filter(isType("turn.completed")).length, 3);
  } finally {
    await manager.shutdown();
  }
});

test("Claude: with no finished turn to resume, the replacement starts fresh under a new id", async () => {
  const { provider, log } = fakeClaude(200);
  const manager = new SessionManager({ providers: [provider] });
  const lifecycle = new Recorder();
  manager.onHostEvent(lifecycle.push);
  try {
    const session = await manager.createAgent({ provider: "claude", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);
    const claudeId = session.info.providerSessionId;
    await session.send({ text: "stubborn: run the tests" });
    await rec.waitFor(isType("input.required"));
    await session.interrupt();

    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    assert.equal(log.options.length, 2);
    assert.equal(log.options[1]?.resume, undefined);
    const fresh = log.options[1]?.sessionId;
    assert.ok(fresh && fresh !== claudeId);
    assert.equal(session.info.providerSessionId, fresh);
    assert.ok(lifecycle.items.some(isType("session.updated")));

    const mark = rec.items.length;
    await session.send({ text: "/echo still here" });
    await rec.waitFor(isType("input.required"), mark);
    assert.equal(session.info.status, "waiting_input");
  } finally {
    await manager.shutdown();
  }
});
