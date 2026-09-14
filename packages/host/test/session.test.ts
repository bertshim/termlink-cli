import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";
import { Recorder, seqs } from "./support.js";

const cwd = tmpdir();

async function open({ steer, ...options }: { logCapacity?: number; steer?: boolean } = {}) {
  const manager = new SessionManager({
    providers: [new FakeProvider({ stepDelayMs: 0, ...(steer === undefined ? {} : { steer }) })],
    ...options,
  });
  const session = await manager.createAgent({ provider: "fake", cwd });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec };
}

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

function completedItems(events: AgentEvent[]) {
  return events.filter(isType("item.completed")).map((e) => e.payload.item);
}

test("a turn streams items and pauses for command approval", async () => {
  const { manager, session, rec } = await open();
  await session.send({ text: "tests are failing, fix them" });

  const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
  assert.equal(session.info.status, "waiting_input");
  session.respond(required.payload.request.requestId, "allow");

  const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
  assert.equal(done.payload.status, "completed");
  assert.equal(session.info.status, "idle");

  for (const event of rec.items) AgentEvent.parse(event);
  const sequenced = seqs(rec.items);
  assert.deepEqual(sequenced, sequenced.map((_, i) => i + 1));

  const items = completedItems(rec.items);
  assert.deepEqual(items.map((i) => i.kind), ["message", "message", "command", "message", "file_change", "message"]);
  const command = items[2];
  assert.ok(command?.kind === "command");
  assert.equal(command.exitCode, 1);
  assert.match(command.output ?? "", /1 failing/);

  // Streamed deltas add up to the final text.
  const reply = items[1];
  assert.ok(reply?.kind === "message");
  const streamed = rec.items
    .filter(isType("item.delta"))
    .filter((e) => e.payload.itemId === reply.id)
    .map((e) => e.payload.delta)
    .join("");
  assert.equal(streamed, reply.text);

  await manager.closeAll();
});

test("denying the command marks it declined and skips the edit", async () => {
  const { manager, session, rec } = await open();
  await session.send({ text: "fix it" });
  const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
  session.respond(required.payload.request.requestId, "deny");
  await rec.waitFor(isType("turn.completed"));

  const items = completedItems(rec.items);
  assert.deepEqual(items.map((i) => i.kind), ["message", "message", "command", "message"]);
  assert.equal(items[2]?.status, "declined");
  await manager.closeAll();
});

test("allow_session skips the approval on the next turn", async () => {
  const { manager, session, rec } = await open();
  await session.send({ text: "fix it" });
  const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
  session.respond(required.payload.request.requestId, "allow_session");
  await rec.waitFor(isType("turn.completed"));

  const mark = rec.items.length;
  await session.send({ text: "run it again" });
  await rec.waitFor(isType("turn.completed"), mark);
  assert.equal(rec.items.slice(mark).filter(isType("input.required")).length, 0);
  await manager.closeAll();
});

test("interrupting while waiting for approval cancels the request", async () => {
  const { manager, session, rec } = await open();
  await session.send({ text: "fix it" });
  const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;

  await session.interrupt();
  const resolved = rec.items.find(isType("input.resolved"));
  assert.equal(resolved?.payload.effect, "cancel");
  assert.equal(resolved?.payload.by, "host");
  const done = rec.items.find(isType("turn.completed"));
  assert.equal(done?.payload.status, "interrupted");
  assert.equal(completedItems(rec.items).find((i) => i.kind === "command")?.status, "interrupted");
  assert.equal(session.info.status, "idle");
  assert.throws(() => session.respond(required.payload.request.requestId, "allow"), { code: "not_found" });
  await manager.closeAll();
});

// A provider that steers takes it into the running turn instead (steer.test.ts).
test("a second send while a turn runs is rejected by a provider that can't steer", async () => {
  const { manager, session } = await open({ steer: false });
  await session.send({ text: "fix it" });
  await assert.rejects(session.send({ text: "and this" }), { code: "conflict" });
  await manager.closeAll();
});

test("re-attaching with afterSeq replays exactly the missed events", async () => {
  const { manager, session, rec } = await open();
  await session.send({ text: "fix it" });
  const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
  const lastSeen = session.info.lastSeq;

  session.respond(required.payload.request.requestId, "allow");
  await rec.waitFor(isType("turn.completed"));

  const again = session.attach(() => {}, lastSeen);
  assert.equal(again.gap, false);
  assert.deepEqual(
    seqs(again.replay),
    seqs(rec.items).filter((s) => s > lastSeen),
  );
  await manager.closeAll();
});

test("attach reports a gap and still delivers the pending input once", async () => {
  const { manager, session, rec } = await open({ logCapacity: 3 });
  await session.send({ text: "fix it" });
  const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
  // Six durable events have happened; the 3-event log no longer starts at seq 1.
  const late = session.attach(() => {}, 0);
  assert.equal(late.gap, true);
  const pending = late.replay.filter(isType("input.required"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.payload.request.requestId, required.payload.request.requestId);
  late.detach();
  await manager.closeAll();
});

test("create rejects unknown providers and missing directories", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  await assert.rejects(manager.createAgent({ provider: "codex", cwd }), { code: "unsupported" });
  await assert.rejects(manager.createAgent({ provider: "fake", cwd: path.join(cwd, "does-not-exist-tl") }), {
    code: "bad_request",
  });
});

test("closing a session cancels pending input and announces the close", async () => {
  const { manager, session, rec } = await open();
  const host = new Recorder();
  manager.onHostEvent(host.push);
  await session.send({ text: "fix it" });
  await rec.waitFor(isType("input.required"));

  await manager.close(session.id, "bye");
  assert.equal(rec.items.find(isType("input.resolved"))?.payload.effect, "cancel");
  const closed = host.items.find(isType("session.closed"));
  assert.equal(closed?.payload.reason, "bye");
  assert.equal(closed?.payload.session.status, "closed");
  assert.deepEqual(manager.list(), []);
});
