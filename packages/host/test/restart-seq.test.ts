import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";

test("attaching with a seq past the end is a gap with a full replay", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    session.importHistory([
      {
        turnId: "t1",
        status: "completed",
        items: [
          { id: "u1", kind: "message", role: "user", text: "hi", status: "completed" },
          { id: "a1", kind: "message", role: "assistant", text: "hello", status: "completed" },
        ],
      },
    ]);
    const lastSeq = session.info.lastSeq;
    assert.equal(lastSeq, 4);

    // As if the client last saw seq 10 from the host's previous run.
    const stale = session.attach(() => {}, 10);
    assert.equal(stale.gap, true);
    assert.deepEqual(stale.replay.map((e) => e.seq), [1, 2, 3, 4]);

    const current = session.attach(() => {}, lastSeq);
    assert.equal(current.gap, false);
    assert.deepEqual(current.replay, []);
  } finally {
    await manager.shutdown();
  }
});
