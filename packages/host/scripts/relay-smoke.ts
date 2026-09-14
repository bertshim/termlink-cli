// Checks a running `termlink-node start` through the real relay, the way the
// web app reaches it: mint a client token with this machine's TermLink sign-in, find the
// host in /hosts, join its relay session as a client and run a turn.
//
//   npm run relay-smoke -w @termlink/cli -- [--provider fake|claude|codex] [--text "..."]
//                                             [--session <name>] [--server <url>] [--decision <id>]
//
// With the fake provider it also sends and receives a 90 KB message, over the relay's
// 64 KB frame limit, to exercise chunking both ways.
import { once } from "node:events";
import { parseArgs } from "node:util";
import { FrameAssembler, HostMessage, RELAY_FRAME_BYTES, encodeFrames, type CommandResults, type CommandType } from "@termlink/protocol";
import { WebSocket } from "ws";
import { httpBase } from "../src/relay/api.js";
import { defaultCredentialPath, loadDevice } from "../src/relay/device.js";
import { DEFAULT_SERVER, defaultRelaySession } from "../src/relay/relay-host.js";

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "claude" },
    text: { type: "string" },
    session: { type: "string", default: defaultRelaySession() },
    server: { type: "string", default: process.env.TERMLINK_SERVER ?? DEFAULT_SERVER },
    decision: { type: "string" },
  },
});
const server = values.server;
const started = Date.now();
const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`.padStart(6);
const say = (line: string): void => console.log(`${elapsed()}  ${line}`);

const device = await loadDevice(defaultCredentialPath(), server);
const auth = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };

// 1. The host as the web app sees it.
const hostsRes = await fetch(`${httpBase(server)}/hosts`, { headers: auth });
if (!hostsRes.ok) throw new Error(`/hosts: ${hostsRes.status} ${await hostsRes.text()}`);
const hosts = (await hostsRes.json()) as { session: string; name: string; term: string; relay: string; caps?: string[] }[];
const host = hosts.find((h) => h.session === values.session);
if (!host) throw new Error(`session ${values.session} is not in /hosts; is the host running?`);
say(`/hosts: ${host.session} name=${host.name} term=${host.term} caps=${JSON.stringify(host.caps ?? [])} relay=${host.relay}`);

// 2. A session-scoped client token, as /api/auth/connect gets for the browser.
const connectRes = await fetch(`${httpBase(server)}/connect`, { method: "POST", headers: auth, body: JSON.stringify({ session: values.session }) });
if (!connectRes.ok) throw new Error(`/connect: ${connectRes.status} ${await connectRes.text()}`);
const { client_token: clientToken } = (await connectRes.json()) as { client_token: string };

// 3. Join as a client.
const relay = host.relay || server;
const query = new URLSearchParams({ session: values.session, role: "client", client: "relay-smoke", token: clientToken });
const ws = new WebSocket(`${relay}/ws?${query}`);
await once(ws, "open");
say(`joined ${relay} as a client`);

const assembler = new FrameAssembler();
const waiting = new Map<string, (message: HostMessage) => void>();
const listeners = new Set<(message: HostMessage) => void>();
const lastSeq = new Map<string, number>();
let frames = 0;
let chunkFrames = 0;
const prefix = `smoke-${Math.random().toString(36).slice(2, 8)}`;
let nextReq = 0;

ws.on("message", (data) => {
  frames++;
  const text = data.toString();
  if (text.includes('"kind":"chunk"')) chunkFrames++;
  const raw = assembler.push(text);
  if (raw === undefined) return;
  const message = HostMessage.parse(raw);
  if (message.kind === "res") {
    waiting.get(message.reqId)?.(message);
    waiting.delete(message.reqId);
    return;
  }
  // Other tabs' attach replays are broadcast too; drop what this client already has.
  if (message.seq !== undefined && message.sessionId) {
    if (message.seq <= (lastSeq.get(message.sessionId) ?? 0)) return;
    lastSeq.set(message.sessionId, message.seq);
  }
  for (const listener of listeners) listener(message);
});

function request<T extends CommandType>(type: T, payload: unknown): Promise<CommandResults[T]> {
  const reqId = `${prefix}-${++nextReq}`;
  for (const frame of encodeFrames({ v: 1, kind: "cmd", reqId, type, payload }, RELAY_FRAME_BYTES, () => `${reqId}-ck`)) {
    ws.send(frame);
  }
  return new Promise((resolve, reject) => {
    waiting.set(reqId, (message) => {
      if (message.kind !== "res") return;
      if (message.ok) resolve(message.result as CommandResults[T]);
      else reject(new Error(`${type}: ${message.error.code}: ${message.error.message}`));
    });
  });
}

function next(predicate: (message: HostMessage) => boolean): Promise<HostMessage> {
  return new Promise((resolve) => {
    const listener = (message: HostMessage): void => {
      if (!predicate(message)) return;
      listeners.delete(listener);
      resolve(message);
    };
    listeners.add(listener);
  });
}

const info = await request("host.info", {});
say(`host.info: ${info.name} ${info.os}, roots=${JSON.stringify(info.roots ?? null)}`);
for (const p of info.providers) say(`  ${p.id}: ${p.available ? "ready" : "unavailable"}${p.detail ? ` (${p.detail})` : ""}`);

const { session } = await request("session.create", { provider: values.provider, cwd: ".", title: "relay smoke" });
say(`session ${session.id} (${session.provider}) in ${session.cwd}`);

listeners.add((message) => {
  if (message.kind !== "evt") return;
  switch (message.type) {
    case "input.required": {
      const { request: req } = message.payload;
      const choice = req.decisions.find((d) => d.id === values.decision) ?? req.decisions[0];
      say(`? ${req.title}${req.command ? ` ${req.command}` : ""} -> ${choice?.id}`);
      if (choice) void request("input.respond", { sessionId: session.id, requestId: req.requestId, decisionId: choice.id });
      break;
    }
    case "item.completed": {
      const { item } = message.payload;
      if (item.kind === "message") say(`${item.role}: ${item.text.length > 120 ? `${item.text.slice(0, 60)}... (${item.text.length} chars)` : item.text}`);
      else if (item.kind === "command") say(`$ ${item.display ?? item.command} -> ${item.status}, exit ${item.exitCode ?? "-"}`);
      else if (item.kind === "file_change") say(`changed ${item.changes.map((c) => c.path).join(", ")}`);
      else say(`${item.kind} ${item.status}`);
      break;
    }
    case "turn.completed": {
      const { status, usage } = message.payload;
      say(`turn ${status}${usage ? ` (${usage.inputTokens} in / ${usage.outputTokens} out)` : ""}`);
      break;
    }
  }
});

async function turn(text: string): Promise<void> {
  const done = next((m) => m.kind === "evt" && m.type === "turn.completed" && m.sessionId === session.id);
  await request("session.send", { sessionId: session.id, input: { text } });
  await done;
}

if (values.provider === "fake" && !values.text) {
  const word = "z".repeat(90_000);
  const reply = next(
    (m) => m.kind === "evt" && m.type === "item.completed" && m.payload.item.kind === "message" && m.payload.item.role === "assistant",
  );
  await turn(`/echo ${word}`);
  const got = await reply;
  const ok = got.kind === "evt" && got.type === "item.completed" && got.payload.item.kind === "message" && got.payload.item.text === word;
  say(`90 KB round trip through the relay: ${ok ? "intact" : "MISMATCH"} (${chunkFrames} chunk frames so far)`);
  if (!ok) process.exitCode = 1;
  await turn("The auth tests are failing. Fix them.");
} else {
  await turn(values.text ?? "Run node --version in this directory and tell me the version it prints. Do not modify any files.");
}

await request("session.close", { sessionId: session.id });
say(`closed; ${frames} frames received (${chunkFrames} chunk frames)`);
ws.close();
