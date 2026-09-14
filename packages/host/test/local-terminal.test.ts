// A terminal session end to end over the local WebSocket server: create, bytes both ways
// in binary frames, resize, reset + screen on a second attach, and the exit.
import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import {
  HostMessage,
  TERMINAL_FRAME_INPUT,
  TERMINAL_FRAME_OUTPUT,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type CommandResults,
  type CommandType,
  type HostInfo,
} from "@termlink/protocol";
import { ptyStatus } from "@termlink/terminal";
import { WebSocket } from "ws";
import { ShellProvider } from "../src/providers/terminal.js";
import { startLocalServer, toBytes, type LocalServer } from "../src/server/local-server.js";
import { SessionManager } from "../src/session/manager.js";
import { Recorder } from "./support.js";

const TOKEN = "test-token";
const pty = ptyStatus();
const decoder = new TextDecoder();

class Client {
  readonly rec = new Recorder<HostMessage>();
  readonly output = new Recorder<{ sessionId: string; text: string }>();
  readonly ws: WebSocket;
  #nextReq = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = decodeTerminalFrame(toBytes(data));
        assert.ok(frame && frame.kind === TERMINAL_FRAME_OUTPUT);
        this.output.push({ sessionId: frame.sessionId, text: decoder.decode(frame.payload) });
        return;
      }
      this.rec.push(HostMessage.parse(JSON.parse(data.toString())));
    });
  }

  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(`${url}?token=${TOKEN}`);
    // Listen before the socket opens: host.ready follows the upgrade at once.
    const client = new Client(ws);
    await once(ws, "open");
    return client;
  }

  async request<T extends CommandType>(type: T, payload: unknown): Promise<CommandResults[T]> {
    const reqId = `r${++this.#nextReq}`;
    this.ws.send(JSON.stringify({ v: 1, kind: "cmd", reqId, type, payload }));
    const res = await this.rec.waitFor((m) => m.kind === "res" && m.reqId === reqId);
    assert.ok(res.kind === "res");
    if (!res.ok) throw new Error(`${type}: ${res.error.code} ${res.error.message}`);
    return res.result as CommandResults[T];
  }

  type(sessionId: string, text: string): void {
    this.ws.send(encodeTerminalFrame(TERMINAL_FRAME_INPUT, sessionId, new TextEncoder().encode(text)), { binary: true });
  }

  /** All output for a session so far, joined. */
  text(sessionId: string): string {
    return this.output.items
      .filter((o) => o.sessionId === sessionId)
      .map((o) => o.text)
      .join("");
  }

  async outputMatches(sessionId: string, pattern: RegExp, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(this.text(sessionId))) {
      if (Date.now() > deadline) throw new Error(`no output matching ${pattern}; got ${JSON.stringify(this.text(sessionId))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

let server: LocalServer;
let manager: SessionManager;
const hostInfo = async (): Promise<HostInfo> => ({
  hostId: "h",
  name: "test",
  version: "0",
  protocol: 1,
  os: "test",
  providers: await manager.providerStatuses(),
});

before(async () => {
  // node as the shell keeps the test the same on every platform; it prints its size,
  // echoes a line of input and exits when told to.
  manager = new SessionManager({
    providers: [
      new ShellProvider({
        shell: process.execPath,
        args: [
          "-e",
          "process.stdout.write('size=' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');" +
            "process.stdout.on('resize', () => process.stdout.write('resized=' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'));" +
            "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { const t = d.trim(); if (t === 'quit') process.exit(5); process.stdout.write('echo:' + t + '\\r\\n'); });",
        ],
      }),
    ],
    flow: { ackTimeoutMs: 60_000 },
  });
  server = await startLocalServer({ manager, hostInfo, token: TOKEN, port: 0 });
});

after(async () => {
  await manager.closeAll();
  await server.close();
});

test("the terminal provider is listed with its kind and label", async () => {
  const client = await Client.connect(server.url);
  const ready = await client.rec.waitFor((m) => m.kind === "evt" && m.type === "host.ready");
  assert.ok(ready.kind === "evt" && ready.type === "host.ready");
  const provider = ready.payload.providers.find((p) => p.id === "terminal");
  assert.ok(provider);
  assert.equal(provider.kind, "terminal");
  assert.equal(provider.label, "Terminal");
  assert.equal(provider.available, pty.available);
  client.ws.close();
});

test("a terminal session over the local server", { skip: pty.available ? false : (pty.detail ?? true) }, async () => {
  const a = await Client.connect(server.url);
  const { session } = await a.request("session.create", {
    provider: "terminal",
    cwd: tmpdir(),
    cols: 100,
    rows: 30,
    clientId: "a",
  });
  assert.equal(session.kind, "terminal");
  assert.equal(session.provider, "terminal");
  assert.equal(session.cols, 100);
  // The creating client is caught up like any other: reset, then the (still empty) screen.
  await a.rec.waitFor((m) => m.kind === "evt" && m.type === "terminal.reset");
  await a.outputMatches(session.id, /size=100x30/);

  a.type(session.id, "hello\r");
  await a.outputMatches(session.id, /echo:hello/);
  assert.equal(a.text(session.id).match(/echo:hello/g)?.length, 1, "input echo is not duplicated");

  await a.request("terminal.resize", { sessionId: session.id, cols: 120, rows: 40 });
  const size = await a.rec.waitFor((m) => m.kind === "evt" && m.type === "terminal.size");
  assert.ok(size.kind === "evt" && size.type === "terminal.size");
  assert.deepEqual(size.payload, { cols: 120, rows: 40 });
  // Node does not raise 'resize' on Windows consoles; the PTY itself is resized either way.
  if (process.platform !== "win32") await a.outputMatches(session.id, /resized=120x40/);

  await a.request("terminal.ack", { sessionId: session.id, clientId: "a", bytes: a.text(session.id).length });

  // A second client gets the screen so far, and both hear the reset.
  const b = await Client.connect(server.url);
  const attached = await b.request("session.attach", { sessionId: session.id, clientId: "b" });
  assert.equal(attached.session.id, session.id);
  await b.rec.waitFor((m) => m.kind === "evt" && m.type === "terminal.reset");
  await b.outputMatches(session.id, /echo:hello/);
  const listed = await b.request("session.list", {});
  assert.equal(listed.sessions.find((s) => s.id === session.id)?.status, "running");

  // Agent commands are refused on a terminal session.
  await assert.rejects(a.request("session.send", { sessionId: session.id, input: { text: "hi" } }), /unsupported/);

  b.type(session.id, "quit\r");
  const closed = await a.rec.waitFor((m) => m.kind === "evt" && m.type === "session.closed" && m.sessionId === session.id);
  assert.ok(closed.kind === "evt" && closed.type === "session.closed");
  assert.equal(closed.payload.exitCode, 5);
  assert.equal(closed.payload.session.status, "closed");
  await assert.rejects(a.request("session.attach", { sessionId: session.id }), /not_found/);

  a.ws.close();
  b.ws.close();
});

test("terminal.kill ends the shell", { skip: pty.available ? false : (pty.detail ?? true) }, async () => {
  const client = await Client.connect(server.url);
  const { session } = await client.request("session.create", { provider: "terminal", cwd: tmpdir() });
  await client.outputMatches(session.id, /size=80x24/);
  await client.request("terminal.kill", { sessionId: session.id });
  const closed = await client.rec.waitFor((m) => m.kind === "evt" && m.type === "session.closed" && m.sessionId === session.id);
  assert.ok(closed.kind === "evt" && closed.type === "session.closed");
  client.ws.close();
});
