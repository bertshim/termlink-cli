import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { AgentEvent, EventOf } from "@termlink/protocol";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";
import { Recorder } from "./support.js";

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

test("turn.started names the user message that opened it, once per turn", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    const rec = new Recorder();
    session.attach(rec.push);

    for (const text of ["/echo one", "/echo two"]) {
      const mark = rec.items.length;
      await session.send({ text });
      await rec.waitFor(isType("turn.completed"), mark);
      const events = rec.items.slice(mark);
      const user = events.filter(isType("item.completed")).find((e) => e.payload.item.kind === "message" && e.payload.item.role === "user");
      const started = events.find(isType("turn.started"));
      assert.ok(user && started);
      assert.equal(started.payload.userItemId, user.payload.item.id);
      assert.ok(events.indexOf(user) < events.indexOf(started));
    }
  } finally {
    await manager.shutdown();
  }
});
