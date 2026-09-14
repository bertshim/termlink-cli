import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { HostMessage, encodeFrames, type HostInfo } from "@termlink/protocol";
import { WebSocket } from "ws";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { startLocalServer } from "../src/server/local-server.js";
import { SessionManager } from "../src/session/manager.js";
import { Recorder } from "./support.js";

test("the local server reassembles chunked commands", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  const hostInfo = async (): Promise<HostInfo> => ({
    hostId: "h",
    name: "t",
    version: "0",
    protocol: 1,
    os: "t",
    providers: [],
  });
  const server = await startLocalServer({ manager, hostInfo, token: "t", port: 0 });
  const ws = new WebSocket(`${server.url}?token=t`);
  const rec = new Recorder<HostMessage>();
  ws.on("message", (data) => rec.push(HostMessage.parse(JSON.parse(data.toString()))));
  try {
    await once(ws, "open");
    const send = (reqId: string, type: string, payload: unknown, maxBytes = 1024) => {
      let n = 0;
      for (const frame of encodeFrames({ v: 1, kind: "cmd", reqId, type, payload }, maxBytes, () => `${reqId}-${++n}`)) {
        ws.send(frame);
      }
    };
    const response = (reqId: string) => rec.waitFor((m) => m.kind === "res" && m.reqId === reqId);

    send("c1", "session.create", { provider: "fake", cwd: tmpdir() });
    const created = await response("c1");
    assert.ok(created.kind === "res" && created.ok);
    const { session } = created.result as { session: { id: string } };

    // 50 KB of input goes out as many frames and arrives as one message.
    const text = `/echo ${"x".repeat(50_000)}`;
    send("c2", "session.send", { sessionId: session.id, input: { text } });
    const sent = await response("c2");
    assert.ok(sent.kind === "res" && sent.ok);
    const user = await rec.waitFor(
      (m) => m.kind === "evt" && m.type === "item.completed" && m.payload.item.kind === "message" && m.payload.item.role === "user",
    );
    assert.ok(user.kind === "evt" && user.type === "item.completed" && user.payload.item.kind === "message");
    assert.equal(user.payload.item.text, text);
  } finally {
    ws.close();
    await manager.shutdown();
    await server.close();
  }
});
