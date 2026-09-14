import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { FrameAssembler, HostMessage, RELAY_FRAME_BYTES, encodeFrames, type HostInfo } from "@termlink/protocol";
import type { WebSocket } from "ws";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { DeviceError, loadDevice, renewIfDue } from "../src/relay/device.js";
import { RelayHost } from "../src/relay/relay-host.js";
import { SessionManager } from "../src/session/manager.js";
import { DEVICE_TOKEN, startFakeRelay, type FakeRelay } from "./fixtures/fake-relay.js";
import { Recorder, seqs } from "./support.js";

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

function writeDevice(dir: string, master: string, daysLeft: number): string {
  const file = path.join(dir, "device.json");
  const expires = new Date(Date.now() + daysLeft * 86_400_000).toISOString();
  writeFileSync(file, JSON.stringify({ token: DEVICE_TOKEN, id: "dev1", sub: "user1", expires_at: expires, master, extra: "kept" }));
  return file;
}

/** A browser-like relay client: unique reqIds, chunk reassembly. */
class Client {
  readonly rec = new Recorder<HostMessage>();
  readonly ws: WebSocket;
  readonly #assembler = new FrameAssembler();
  #n = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const message = this.#assembler.push(data.toString());
      if (message !== undefined) this.rec.push(HostMessage.parse(message));
    });
  }

  async request(type: string, payload: unknown) {
    const reqId = `web-${Math.random().toString(36).slice(2)}-${++this.#n}`;
    for (const frame of encodeFrames({ v: 1, kind: "cmd", reqId, type, payload }, RELAY_FRAME_BYTES, () => `${reqId}-c`)) {
      this.ws.send(frame);
    }
    const res = await this.rec.waitFor((m) => m.kind === "res" && m.reqId === reqId);
    assert.ok(res.kind === "res");
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res.result as Record<string, unknown>;
  }
}

async function setup() {
  const relay = await startFakeRelay();
  const dir = mkdtempSync(path.join(tmpdir(), "tl-relay-"));
  const credentialPath = writeDevice(dir, relay.url, 60);
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], allowedRoots: [dir] });
  const hostInfo = async (): Promise<HostInfo> => ({
    hostId: "h1",
    name: "pc",
    version: "0",
    protocol: 1,
    os: "test",
    providers: await manager.providerStatuses(),
    ...(manager.roots ? { roots: manager.roots } : {}),
  });
  const stopped: string[] = [];
  const host = await RelayHost.start({
    manager,
    hostInfo,
    server: relay.url,
    session: "pc-agent",
    name: "pc",
    cwd: dir,
    credentialPath,
    minBackoffMs: 10,
    maxBackoffMs: 50,
    onStopped: (reason) => stopped.push(reason),
  });
  await host.ready;
  const cleanup = async () => {
    await host.close();
    await manager.shutdown();
    await relay.close();
  };
  return { relay, dir, manager, host, stopped, cleanup };
}

async function connect(relay: FakeRelay): Promise<Client> {
  const client = new Client(await relay.client());
  await client.rec.waitFor((m) => m.kind === "evt" && m.type === "host.ready");
  return client;
}

test("registers, joins as caps=agent and serves sessions through the relay, chunking big messages", async () => {
  const { relay, dir, cleanup } = await setup();
  try {
    assert.deepEqual(relay.registrations, ["pc-agent"]);
    const query = relay.hostQueries[0];
    assert.equal(query?.get("role"), "host");
    assert.equal(query?.get("caps"), "agent");
    assert.equal(query?.get("session"), "pc-agent");
    assert.equal(query?.get("term"), "termlink-agent");
    assert.equal(query?.get("relay"), relay.url);

    const client = await connect(relay);
    const ready = client.rec.items.find((m) => m.kind === "evt" && m.type === "host.ready");
    assert.ok(ready?.kind === "evt" && ready.type === "host.ready");
    assert.deepEqual(ready.payload.roots, [path.resolve(dir)]);

    const { session } = (await client.request("session.create", { provider: "fake", cwd: "." })) as { session: { id: string } };
    // One 90 KB word: the message is over the relay's 64 KB frame limit both ways.
    const word = "y".repeat(90_000);
    await client.request("session.send", { sessionId: session.id, input: { text: `/echo ${word}` } });
    const reply = await client.rec.waitFor(
      (m) => m.kind === "evt" && m.type === "item.completed" && m.payload.item.kind === "message" && m.payload.item.role === "assistant",
    );
    assert.ok(reply.kind === "evt" && reply.type === "item.completed" && reply.payload.item.kind === "message");
    assert.equal(reply.payload.item.text, word);
    await client.rec.waitFor((m) => m.kind === "evt" && m.type === "turn.completed");
  } finally {
    await cleanup();
  }
});

test("reconnects after the relay drops it; a new client catches up with afterSeq", async () => {
  const { relay, manager, cleanup } = await setup();
  try {
    const client = await connect(relay);
    const { session } = (await client.request("session.create", { provider: "fake", cwd: "." })) as { session: { id: string } };
    await client.request("session.send", { sessionId: session.id, input: { text: "/echo one two three" } });
    await client.rec.waitFor((m) => m.kind === "evt" && m.type === "turn.completed");
    const lastSeq = manager.get(session.id).info.lastSeq;

    relay.kickHost();
    await waitUntil(() => relay.hostQueries.length === 2);
    assert.equal(relay.registrations.length, 1, "the host token is reused");

    const again = await connect(relay);
    const attached = await again.request("session.attach", { sessionId: session.id, afterSeq: lastSeq - 2 });
    assert.equal(attached.gap, false);
    await again.rec.waitFor((m) => m.kind === "evt" && m.seq === lastSeq);
    assert.deepEqual(seqs(again.rec.items), [lastSeq - 1, lastSeq]);
  } finally {
    await cleanup();
  }
});

test("registers again when the relay rejects its host token", async () => {
  const { relay, cleanup } = await setup();
  try {
    relay.revokeHostTokens();
    relay.kickHost();
    await waitUntil(() => relay.hostQueries.length === 2);
    assert.equal(relay.registrations.length, 2);
  } finally {
    await cleanup();
  }
});

test("stops for good when the session is ended from the account", async () => {
  const { relay, stopped, cleanup } = await setup();
  try {
    relay.terminate("This session was ended from your Termlink account.");
    await waitUntil(() => stopped.length === 1);
    assert.equal(stopped[0], "This session was ended from your Termlink account.");
    await sleep(150);
    assert.equal(relay.hostQueries.length, 1, "no reconnect after terminated");
  } finally {
    await cleanup();
  }
});

test("close unregisters the session", async () => {
  const { relay, host, cleanup } = await setup();
  await host.close();
  assert.equal(relay.unregistrations, 1);
  await cleanup();
});

test("device credential: renews near expiry and refuses unusable sign-ins", async () => {
  const relay = await startFakeRelay();
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "tl-device-"));
    const file = writeDevice(dir, relay.url, 10);
    const loaded = await loadDevice(file, relay.url);
    const fresh = await renewIfDue(file, relay.url, loaded, fetch);
    assert.equal(fresh.token, "tld1.renewed");
    assert.equal(relay.renewals, 1);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(saved.token, "tld1.renewed");
    assert.equal(saved.extra, "kept");

    await assert.rejects(loadDevice(writeDevice(dir, relay.url, -1), relay.url), DeviceError);
    await assert.rejects(loadDevice(writeDevice(dir, "wss://elsewhere:9000", 60), relay.url), DeviceError);
    await assert.rejects(loadDevice(path.join(dir, "missing.json"), relay.url), DeviceError);
  } finally {
    await relay.close();
  }
});
