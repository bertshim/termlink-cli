import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { HostMessage, type CommandResults, type CommandType, type HostInfo } from "@termlink/protocol";
import { WebSocket } from "ws";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { startLocalServer, type LocalServer } from "../src/server/local-server.js";
import { SessionManager } from "../src/session/manager.js";
import { Recorder, seqs } from "./support.js";

const TOKEN = "test-token";

class Client {
  readonly rec = new Recorder<HostMessage>();
  readonly invalid: unknown[] = [];
  readonly ws: WebSocket;
  #nextReq = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const raw: unknown = JSON.parse(data.toString());
      const parsed = HostMessage.safeParse(raw);
      if (parsed.success) this.rec.push(parsed.data);
      else this.invalid.push(raw);
    });
  }

  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    await once(ws, "open");
    return client;
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  async request<T extends CommandType>(type: T, payload: unknown) {
    const reqId = `r${++this.#nextReq}`;
    this.ws.send(JSON.stringify({ v: 1, kind: "cmd", reqId, type, payload }));
    const res = await this.rec.waitFor((m) => m.kind === "res" && m.reqId === reqId);
    assert.ok(res.kind === "res");
    return res as typeof res & { result: CommandResults[T] };
  }

  waitForEvent(type: string, from = 0) {
    return this.rec.waitFor((m) => m.kind === "evt" && m.type === type, from);
  }

  close(): void {
    this.ws.close();
  }
}

let server: LocalServer;
let manager: SessionManager;

before(async () => {
  manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  const hostInfo = async (): Promise<HostInfo> => ({
    hostId: "h_test",
    name: "test",
    version: "0.0.0",
    protocol: 1,
    os: "test",
    providers: await manager.providerStatuses(),
  });
  server = await startLocalServer({ manager, hostInfo, token: TOKEN, port: 0 });
});

after(async () => {
  await manager.closeAll();
  await server.close();
});

test("rejects connections without the right token", async () => {
  const ws = new WebSocket(`${server.url}?token=wrong`);
  const status = await new Promise<number | undefined>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => resolve(undefined));
  });
  assert.equal(status, 401);
});

test("answers malformed commands with bad_request", async () => {
  const client = await Client.connect(`${server.url}?token=${TOKEN}`);
  client.sendRaw("{not json");
  client.sendRaw(JSON.stringify({ v: 1, kind: "cmd", reqId: "x1", type: "session.nope", payload: {} }));
  const errors = await Promise.all([
    client.rec.waitFor((m) => m.kind === "res" && m.reqId === ""),
    client.rec.waitFor((m) => m.kind === "res" && m.reqId === "x1"),
  ]);
  for (const res of errors) {
    assert.ok(res.kind === "res" && !res.ok);
    assert.equal(res.error.code, "bad_request");
  }
  const missing = await client.request("session.send", { sessionId: "ag_missing", input: { text: "hi" } });
  assert.ok(!missing.ok);
  assert.equal(missing.error.code, "not_found");
  client.close();
});

test("runs a session end to end and replays after reconnect", async () => {
  const client = await Client.connect(`${server.url}?token=${TOKEN}`);
  const ready = await client.waitForEvent("host.ready");
  assert.ok(ready.kind === "evt" && ready.type === "host.ready");
  assert.equal(ready.payload.providers[0]?.id, "fake");

  const created = await client.request("session.create", { provider: "fake", cwd: tmpdir() });
  assert.ok(created.ok);
  const sessionId = created.result.session.id;

  const sent = await client.request("session.send", { sessionId, input: { text: "fix the tests" } });
  assert.ok(sent.ok);

  const required = await client.waitForEvent("input.required");
  assert.ok(required.kind === "evt" && required.type === "input.required");
  const answered = await client.request("input.respond", {
    sessionId,
    requestId: required.payload.request.requestId,
    decisionId: "allow",
  });
  assert.ok(answered.ok);

  const done = await client.waitForEvent("turn.completed");
  assert.ok(done.kind === "evt" && done.type === "turn.completed");
  assert.equal(done.payload.status, "completed");

  const all = seqs(client.rec.items);
  assert.deepEqual(all, all.map((_, i) => i + 1));

  // A second client picks up from seq 3 and gets everything after it, once.
  const other = await Client.connect(`${server.url}?token=${TOKEN}`);
  const attached = await other.request("session.attach", { sessionId, afterSeq: 3 });
  assert.ok(attached.ok);
  assert.equal(attached.result.gap, false);
  const last = all.at(-1)!;
  await other.rec.waitFor((m) => m.kind === "evt" && m.seq === last);
  assert.deepEqual(seqs(other.rec.items), all.filter((s) => s > 3));

  // Closing is announced to every connection, attached or not.
  const mark = other.rec.items.length;
  const closed = await client.request("session.close", { sessionId });
  assert.ok(closed.ok);
  await other.waitForEvent("session.closed", mark);

  assert.deepEqual(client.invalid, []);
  assert.deepEqual(other.invalid, []);
  client.close();
  other.close();
});
