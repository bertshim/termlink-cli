import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentEvent, ProviderStatus, type EventOf } from "@termlink/protocol";
import { ClaudeProvider } from "../src/providers/claude/provider.js";
import { CodexProvider } from "../src/providers/codex/provider.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import { SessionManager } from "../src/session/manager.js";
import { createFakeQuery } from "./fixtures/fake-claude.js";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { Recorder } from "./support.js";

// Messages sent while a turn runs (PROTOCOL.md, "Messages during a turn"): they join that turn
// instead of being refused, and Stop drops the ones not yet read.

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

const userMessages = (events: AgentEvent[]) =>
  events
    .filter(isType("item.completed"))
    .filter((e) => e.payload.item.kind === "message" && e.payload.item.role === "user")
    .map((e) => ({ turnId: e.payload.turnId, text: e.payload.item.kind === "message" ? e.payload.item.text : "" }));

const assistantTexts = (events: AgentEvent[]) =>
  events
    .filter(isType("item.completed"))
    .flatMap((e) => (e.payload.item.kind === "message" && e.payload.item.role === "assistant" ? [e.payload.item.text] : []));

async function open(provider: ProviderAdapter) {
  const manager = new SessionManager({ providers: [provider] });
  const session = await manager.createAgent({ provider: provider.id, cwd: tmpdir() });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec };
}

function fakeClaude() {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-steer-"));
  const file = path.join(dir, "src.ts");
  writeFileSync(file, "export function f() {\n  return 1;\n}\n");
  const fake = createFakeQuery(file);
  return { provider: new ClaudeProvider({ queryFn: fake.queryFn, executable: "claude" }), log: fake.log };
}

const codexFixture = fileURLToPath(new URL("./fixtures/fake-app-server.ts", import.meta.url));
const fakeCodex = () => new CodexProvider({ command: { file: process.execPath, args: ["--import", "tsx", codexFixture] } });

test("the host says which providers take messages mid-turn", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  try {
    const [status] = await manager.providerStatuses();
    assert.equal(ProviderStatus.parse(status).steer, true);
    assert.equal(new ClaudeProvider().steer, true);
    assert.equal(new CodexProvider({ command: null }).steer, true);
  } finally {
    await manager.shutdown();
  }
  const without = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0, steer: false })] });
  try {
    const [status] = await without.providerStatuses();
    assert.equal(status?.steer, undefined);
  } finally {
    await without.shutdown();
  }
});

/** A user message item's steer states, in the order they were said. */
const steerStates = (events: AgentEvent[], itemId: string) =>
  events
    .filter(isType("item.completed"))
    .filter((e) => e.payload.item.id === itemId)
    .map((e) => (e.payload.item.kind === "message" ? e.payload.item.steer : undefined));

test("a message sent while the turn waits on an approval joins that turn, queued until read", async () => {
  const { manager, session, rec } = await open(new FakeProvider({ stepDelayMs: 0 }));
  try {
    await session.send({ text: "fix the failing test" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    const started = rec.items.find(isType("turn.started"));
    assert.ok(started);

    await session.send({ text: "use pnpm", id: "m-steer" });
    assert.deepEqual(userMessages(rec.items).at(-1), { turnId: started.payload.turnId, text: "use pnpm" });
    assert.equal(session.info.status, "waiting_input");
    // Delivered to the turn, not yet read: the session counts it.
    assert.deepEqual(steerStates(rec.items, "m-steer"), ["queued"]);
    assert.equal(session.info.queued, 1);

    session.respond(required.payload.request.requestId, "allow");
    await rec.waitFor(isType("turn.completed"));
    assert.equal(rec.items.filter(isType("turn.started")).length, 1);
    assert.equal(rec.items.filter(isType("turn.completed")).length, 1);
    assert.equal(assistantTexts(rec.items).at(-1), "Noted: use pnpm");
    // Read by the agent before it answered; said again as the same item.
    assert.deepEqual(steerStates(rec.items, "m-steer"), ["queued", "read"]);
    assert.equal(session.info.queued, 0);
    assert.equal(session.info.status, "idle");
    for (const event of rec.items) AgentEvent.parse(event);
  } finally {
    await manager.shutdown();
  }
});

test("a message the agent had not read when Stop came is marked dropped", async () => {
  const { manager, session, rec } = await open(new FakeProvider({ stepDelayMs: 0 }));
  try {
    await session.send({ text: "fix the failing test" });
    await rec.waitFor(isType("input.required"));
    await session.send({ text: "use pnpm", id: "m-late" });
    await session.interrupt();
    assert.deepEqual(steerStates(rec.items, "m-late"), ["queued", "dropped"]);
    assert.equal(session.info.queued, 0);
  } finally {
    await manager.shutdown();
  }
});

test("a provider without steer still refuses a second message", async () => {
  const { manager, session, rec } = await open(new FakeProvider({ stepDelayMs: 0, steer: false }));
  try {
    await session.send({ text: "fix the failing test" });
    await rec.waitFor(isType("input.required"));
    await assert.rejects(session.send({ text: "use pnpm" }), /a turn is already running/);
    assert.equal(userMessages(rec.items).length, 1);
  } finally {
    await manager.shutdown();
  }
});

test("Claude: a queued message is folded into the running turn at the next tool boundary", async () => {
  const { provider, log } = fakeClaude();
  const { manager, session, rec } = await open(provider);
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    await session.send({ text: "use pnpm" });

    const pushed = log.inputs.at(-1);
    assert.equal(pushed?.priority, "next");
    assert.match(pushed?.uuid ?? "", /^[0-9a-f-]{36}$/);
    // What Claude gets carries the note asking it to say how it takes the message on;
    // what the page shows is what was typed.
    assert.ok(String(pushed?.message.content).startsWith("use pnpm\n\n(Sent while you were working."));
    assert.equal(userMessages(rec.items).at(-1)?.text, "use pnpm");

    session.respond(required.payload.request.requestId, "allow");
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.ok(assistantTexts(rec.items).includes("Noted: use pnpm"));
    // The fold-in frame named the message's uuid: read.
    const steered = userMessages(rec.items).at(-1);
    const readEvents = rec.items.filter(isType("item.completed")).filter((e) => e.payload.item.kind === "message" && e.payload.item.role === "user" && e.payload.item.steer === "read");
    assert.equal(readEvents.length, 1);
    assert.equal(readEvents[0]?.payload.item.kind === "message" && readEvents[0].payload.item.text, steered?.text);
    assert.equal(rec.items.filter(isType("turn.started")).length, 1);
    const [first, second] = userMessages(rec.items);
    assert.equal(first?.turnId, null);
    assert.equal(second?.turnId, done.payload.turnId);
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("Claude: a message too late to fold runs as its own turn afterwards", async () => {
  const { provider } = fakeClaude();
  const { manager, session, rec } = await open(provider);
  try {
    await session.send({ text: "ask me something" });
    const question = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    await session.send({ text: "then run the tests" });
    session.respond(question.payload.request.requestId, "submit", { "0": "Postgres" });

    // The leftover message starts a second turn, which the host opens from Claude's frames.
    const approval = (await rec.waitFor(
      (e) => e.type === "input.required" && e.payload.request.kind === "command_approval",
    )) as EventOf<"input.required">;
    const starts = rec.items.filter(isType("turn.started"));
    assert.equal(starts.length, 2);
    assert.equal(starts[1]?.payload.userItemId, undefined);
    assert.equal(session.info.status, "waiting_input");

    session.respond(approval.payload.request.requestId, "allow");
    await rec.waitFor(isType("turn.completed"), rec.items.indexOf(starts[1]!));
    const ends = rec.items.filter(isType("turn.completed"));
    assert.deepEqual(ends.map((e) => e.payload.turnId), starts.map((e) => e.payload.turnId));
    assert.equal(session.info.status, "idle");
    // Its own turn's first frame named it: read, not left queued.
    assert.equal(session.info.queued, 0);
  } finally {
    await manager.shutdown();
  }
});

test("Claude: a slash command sent mid-turn goes as typed, runs after the turn, and is not left queued", async () => {
  const { provider, log } = fakeClaude();
  const { manager, session, rec } = await open(provider);
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    await session.send({ text: "/model sonnet", id: "m-cmd" });
    // Nothing added: the note would become the command's arguments.
    assert.equal(log.inputs.at(-1)?.message.content, "/model sonnet");
    assert.equal(session.info.queued, 1);

    session.respond(required.payload.request.requestId, "allow");
    // Claude Code runs the command once the turn is over; its result names it.
    await rec.waitFor((e) => e.type === "item.completed" && e.payload.item.id === "m-cmd" && e.payload.item.kind === "message" && e.payload.item.steer === "read");
    assert.deepEqual(steerStates(rec.items, "m-cmd"), ["queued", "read"]);
    assert.equal(session.info.queued, 0);
    // A command is no turn of its own.
    assert.equal(rec.items.filter(isType("turn.started")).length, 1);
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("Claude: a queued message no frame names is settled once a later message is taken", async () => {
  const { provider } = fakeClaude();
  const { manager, session, rec } = await open(provider);
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    await session.send({ text: "a silent one", id: "m-silent" });
    session.respond(required.payload.request.requestId, "allow");
    await rec.waitFor(isType("turn.completed"));
    await sleep(30);
    // Taken without a word: nothing has named it yet.
    assert.equal(session.info.queued, 1);

    const before = rec.items.length;
    await session.send({ text: "hello quick" });
    await rec.waitFor(isType("turn.completed"), before);
    // The next message was taken, so the one queued before it was too.
    assert.deepEqual(steerStates(rec.items, "m-silent"), ["queued", "read"]);
    assert.equal(session.info.queued, 0);
  } finally {
    await manager.shutdown();
  }
});

test("Claude: Stop drops a queued message instead of running it next", async () => {
  const { provider, log } = fakeClaude();
  const { manager, session, rec } = await open(provider);
  try {
    await session.send({ text: "run the tests" });
    await rec.waitFor(isType("input.required"));
    await session.send({ text: "use pnpm" });
    await session.interrupt();

    assert.deepEqual(log.interrupts, [{ cancelQueued: true }]);
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    await sleep(50);
    assert.equal(rec.items.filter(isType("turn.started")).length, 1);
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("Codex: a message sent mid-turn goes in with turn/steer and is shown once", async () => {
  const { manager, session, rec } = await open(fakeCodex());
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    await session.send({ text: "use pnpm" });
    session.respond(required.payload.request.requestId, "accept");

    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.ok(assistantTexts(rec.items).includes("Noted: use pnpm"));
    // Codex's own userMessage item for the steered input is not shown a second time.
    assert.deepEqual(
      userMessages(rec.items).map((m) => m.text),
      ["run the tests", "use pnpm"],
    );
    assert.equal(userMessages(rec.items)[1]?.turnId, done.payload.turnId);
    assert.equal(rec.items.filter(isType("turn.started")).length, 1);
    // Codex reported the steered input as its own userMessage item while turn/steer
    // was still being answered, so the message went out once, already read.
    const states = rec.items
      .filter(isType("item.completed"))
      .filter((e) => e.payload.item.kind === "message" && e.payload.item.role === "user" && e.payload.item.text === "use pnpm")
      .map((e) => (e.payload.item.kind === "message" ? e.payload.item.steer : undefined));
    assert.deepEqual(states, ["read"]);
  } finally {
    await manager.shutdown();
  }
});
