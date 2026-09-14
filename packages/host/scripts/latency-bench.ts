// Measures how fast a Claude turn shows signs of life, as a client of the host sees it.
// Starts its own host in this process with TERMLINK_TRACE on, so the host's trace line
// for each turn prints next to the client's numbers. Uses a temporary state file and,
// for --transport relay, its own relay session name, so it never touches a running host.
//
//   npm run bench -w @termlink/cli -- [--transport local|relay] [--runs 3]
//       [--scenarios cold,warm,tool,idle,restore,cli] [--prompt "..."] [--tool-prompt "..."]
//       [--idle-ms 10000] [--model <model>] [--cwd <dir>]
//
// Client times are milliseconds from the moment the client wrote session.send (T0):
//   feedback   first event of any kind for the session (the user's own message coming back)
//   ack        the session.send reply
//   delta      first item.delta (thinking or text): the first sign Claude is producing output
//   text       first text delta of an assistant message (T6)
//   done       turn.completed (T8)
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  FrameAssembler,
  HostMessage,
  PROTOCOL_VERSION,
  RELAY_FRAME_BYTES,
  encodeFrames,
  type CommandResults,
  type CommandType,
  type HostInfo,
} from "@termlink/protocol";
import { WebSocket } from "ws";

// Host modules read TERMLINK_TRACE when they load, so they are imported after it is set.
process.env.TERMLINK_TRACE ??= "1";
const { SessionManager } = await import("../src/session/manager.js");
const { SessionStore } = await import("../src/session/store.js");
const { startLocalServer } = await import("../src/server/local-server.js");
const { ClaudeProvider, resolveClaudeExecutable } = await import("../src/providers/claude/provider.js");
const { RelayHost, DEFAULT_SERVER } = await import("../src/relay/relay-host.js");
const { httpBase } = await import("../src/relay/api.js");
const { defaultCredentialPath, loadDevice } = await import("../src/relay/device.js");
const { setTraceLog } = await import("../src/util/trace.js");

const { values } = parseArgs({
  options: {
    transport: { type: "string", default: "local" },
    runs: { type: "string", default: "3" },
    scenarios: { type: "string", default: "cold,warm,tool,idle,restore,cli" },
    prompt: { type: "string", default: "Reply in two short sentences: confirm you got this message, then name three colors." },
    "tool-prompt": {
      type: "string",
      default: "Use the Read tool to read package.json in the current folder, then tell me its name field in one sentence.",
    },
    "idle-ms": { type: "string", default: "10000" },
    model: { type: "string" },
    cwd: { type: "string" },
    server: { type: "string", default: process.env.TERMLINK_SERVER ?? DEFAULT_SERVER },
  },
});

const TURN_TIMEOUT_MS = 240_000;
const transport = values.transport === "relay" ? "relay" : "local";
const runs = Math.max(1, Number(values.runs) || 3);
const scenarios = new Set(values.scenarios.split(",").map((s) => s.trim()));
const root = path.resolve(values.cwd ?? path.join(import.meta.dirname, "..", "..", ".."));
const idleMs = Number(values["idle-ms"]) || 10_000;
const started = performance.now();
const say = (line: string): void => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
setTraceLog((line) => say(line));

// ---------------------------------------------------------------- client

type Message = ReturnType<typeof HostMessage.parse>;
type Listener = (message: Message, at: number) => void;

class Client {
  readonly listeners = new Set<Listener>();
  readonly #ws: WebSocket;
  readonly #assembler = new FrameAssembler();
  readonly #waiting = new Map<string, (message: Message) => void>();
  readonly #lastSeq = new Map<string, number>();
  readonly #prefix = `bench-${Math.random().toString(36).slice(2, 8)}`;
  #next = 0;
  frames = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => {
      const at = performance.now();
      this.frames++;
      const raw = this.#assembler.push(data.toString());
      if (raw === undefined) return;
      const parsed = HostMessage.safeParse(raw);
      if (!parsed.success) return; // relay control messages
      const message = parsed.data;
      if (message.kind === "res") {
        this.#waiting.get(message.reqId)?.(message);
        this.#waiting.delete(message.reqId);
        return;
      }
      if (message.kind === "evt" && message.seq !== undefined && message.sessionId) {
        if (message.seq <= (this.#lastSeq.get(message.sessionId) ?? 0)) return;
        this.#lastSeq.set(message.sessionId, message.seq);
      }
      for (const listener of this.listeners) listener(message, at);
    });
  }

  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await once(ws, "open");
    return new Client(ws);
  }

  request<T extends CommandType>(type: T, payload: unknown): Promise<CommandResults[T]> {
    const reqId = `${this.#prefix}-${++this.#next}`;
    const result = new Promise<CommandResults[T]>((resolve, reject) => {
      this.#waiting.set(reqId, (message) => {
        if (message.kind !== "res") return;
        if (message.ok) resolve(message.result as CommandResults[T]);
        else reject(new Error(`${type}: ${message.error.code}: ${message.error.message}`));
      });
    });
    for (const frame of encodeFrames({ v: PROTOCOL_VERSION, kind: "cmd", reqId, type, payload }, RELAY_FRAME_BYTES, () => `${reqId}-ck`)) {
      this.#ws.send(frame);
    }
    return result;
  }

  close(): void {
    this.#ws.close();
  }
}

// ---------------------------------------------------------------- host

interface Host {
  client: Client;
  close(): Promise<void>;
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), "tl-bench-"));
const statePath = path.join(stateDir, "agent-sessions.json");
const relaySession = `bench-${os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${process.pid}`;

async function startHost(): Promise<Host> {
  const manager = new SessionManager({
    providers: [new ClaudeProvider(values.model ? { model: values.model } : {})],
    store: new SessionStore(statePath),
    allowedRoots: [root],
  });
  const restored = await manager.restore();
  if (restored > 0) say(`host: restored ${restored} session(s)`);
  const hostInfo = async (): Promise<HostInfo> => ({
    hostId: "bench",
    name: os.hostname(),
    version: "bench",
    protocol: PROTOCOL_VERSION,
    os: `${process.platform}-${process.arch}`,
    providers: await manager.providerStatuses(),
    roots: [root],
  });

  if (transport === "local") {
    const token = Math.random().toString(36).slice(2);
    const server = await startLocalServer({ manager, hostInfo, port: 0, token });
    const client = await Client.open(`${server.url}?token=${token}`);
    return {
      client,
      close: async () => {
        client.close();
        await manager.shutdown("bench");
        await server.close();
      },
    };
  }

  const relay = await RelayHost.start({ manager, hostInfo, server: values.server, session: relaySession, cwd: root, log: (line) => say(line) });
  await relay.ready;
  const client = await joinRelay(relaySession);
  return {
    client,
    close: async () => {
      client.close();
      await relay.close();
      await manager.shutdown("bench");
    },
  };
}

/** Joins the relay session as the web app does: /hosts, /connect, then the host's relay. */
async function joinRelay(session: string): Promise<Client> {
  const device = await loadDevice(defaultCredentialPath(), values.server);
  const auth = { authorization: `Bearer ${device.token}`, "content-type": "application/json" };
  let relayUrl: string | null = null;
  for (let i = 0; i < 20 && !relayUrl; i++) {
    const res = await fetch(`${httpBase(values.server)}/hosts`, { headers: auth });
    const hosts = res.ok ? ((await res.json()) as { session: string; relay: string }[]) : [];
    const host = hosts.find((h) => h.session === session);
    if (host) relayUrl = host.relay || values.server;
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!relayUrl) throw new Error(`relay session ${session} did not appear in /hosts`);
  const res = await fetch(`${httpBase(values.server)}/connect`, { method: "POST", headers: auth, body: JSON.stringify({ session }) });
  if (!res.ok) throw new Error(`/connect: ${res.status} ${await res.text()}`);
  const { client_token: token } = (await res.json()) as { client_token: string };
  say(`client: joining ${relayUrl}`);
  return Client.open(`${relayUrl}/ws?${new URLSearchParams({ session, role: "client", client: "latency-bench", token })}`);
}

// ---------------------------------------------------------------- turns

interface TurnResult {
  scenario: string;
  feedback?: number;
  ack?: number;
  item?: number;
  delta?: number;
  text?: number;
  done?: number;
  status?: string;
  deltaFrames: number;
  approvals: number;
}

const results: TurnResult[] = [];

async function turn(client: Client, sessionId: string, text: string, scenario: string): Promise<TurnResult> {
  const r: TurnResult = { scenario, deltaFrames: 0, approvals: 0 };
  const textItems = new Set<string>();
  let t0 = 0;
  let listener: Listener = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${scenario}: turn timed out`)), TURN_TIMEOUT_MS);
    listener = (m, at) => {
      if (m.kind !== "evt" || m.sessionId !== sessionId || t0 === 0) return;
      const rel = at - t0;
      r.feedback ??= rel;
      switch (m.type) {
        case "item.started":
          // Anything Claude starts (thinking, a message, a tool) is the first thing the reader sees.
          r.item ??= rel;
          if (m.payload.item.kind === "message" && m.payload.item.role === "assistant") textItems.add(m.payload.item.id);
          break;
        case "item.delta":
          r.deltaFrames++;
          r.delta ??= rel;
          if (textItems.has(m.payload.itemId)) r.text ??= rel;
          break;
        case "input.required": {
          r.approvals++;
          const allow = m.payload.request.decisions.find((d) => d.effect === "allow") ?? m.payload.request.decisions[0];
          if (allow) void client.request("input.respond", { sessionId, requestId: m.payload.request.requestId, decisionId: allow.id });
          break;
        }
        case "turn.completed":
          r.done = rel;
          r.status = m.payload.status;
          clearTimeout(timer);
          resolve();
          break;
      }
    };
    client.listeners.add(listener);
  });
  t0 = performance.now();
  await client.request("session.send", { sessionId, input: { text } });
  r.ack = performance.now() - t0;
  try {
    await done;
  } finally {
    client.listeners.delete(listener);
  }
  results.push(r);
  say(`client: ${line(r)}`);
  return r;
}

const fmt = (v: number | undefined): string => (v === undefined ? "-" : String(Math.round(v)));
const line = (r: TurnResult): string =>
  `${r.scenario.padEnd(9)} feedback=${fmt(r.feedback)} ack=${fmt(r.ack)} item=${fmt(r.item)} delta=${fmt(r.delta)} text=${fmt(r.text)} ` +
  `done=${fmt(r.done)} frames=${r.deltaFrames}${r.approvals ? ` approvals=${r.approvals}` : ""} ${r.status ?? ""}`;

/** `claude -p` with streaming JSON: a cold CLI run, spawn to first text. */
async function cliRun(prompt: string): Promise<void> {
  const exe = resolveClaudeExecutable();
  if (!exe) throw new Error("no claude executable");
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...(values.model ? ["--model", values.model] : []), prompt];
  const t0 = performance.now();
  const child = spawn(exe, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const marks: Record<string, number> = {};
  const mark = (name: string): void => {
    marks[name] ??= performance.now() - t0;
  };
  for await (const raw of createInterface({ input: child.stdout })) {
    let m: { type?: string; subtype?: string; event?: { type?: string; delta?: { type?: string } } };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      continue;
    }
    mark("firstLine");
    if (m.type === "system" && m.subtype === "init") mark("init");
    if (m.type === "stream_event" && m.event?.type === "message_start") mark("apiStart");
    if (m.type === "stream_event" && m.event?.delta?.type === "thinking_delta") mark("thinking");
    if (m.type === "stream_event" && m.event?.delta?.type === "text_delta") mark("text");
    if (m.type === "result") mark("result");
  }
  say(
    `cli:      spawn>init=${fmt(marks.init)} spawn>api=${fmt(marks.apiStart)} spawn>thinking=${fmt(marks.thinking)} ` +
      `spawn>text=${fmt(marks.text)} spawn>result=${fmt(marks.result)}`,
  );
}

// ---------------------------------------------------------------- run

say(`bench: transport=${transport} cwd=${root} runs=${runs} scenarios=${[...scenarios].join(",")}`);
let host = await startHost();
let mainSession: string | null = null;
try {
  if (scenarios.has("cold") || scenarios.has("warm") || scenarios.has("tool") || scenarios.has("restore")) {
    const t0 = performance.now();
    const { session } = await host.client.request("session.create", { provider: "claude", cwd: root, title: "latency bench" });
    say(`client: session.create ${session.id} in ${Math.round(performance.now() - t0)}ms`);
    mainSession = session.id;
    // Cold: the Claude process was spawned by session.create a moment ago and is still starting.
    await turn(host.client, session.id, values.prompt, "cold");
    if (scenarios.has("warm")) for (let i = 0; i < runs; i++) await turn(host.client, session.id, values.prompt, "warm");
    if (scenarios.has("tool")) await turn(host.client, session.id, values["tool-prompt"], "tool");
  }

  if (scenarios.has("idle")) {
    const { session } = await host.client.request("session.create", { provider: "claude", cwd: root, title: "latency bench idle" });
    say(`client: session ${session.id} created; idle ${idleMs}ms before sending`);
    await new Promise((r) => setTimeout(r, idleMs));
    await turn(host.client, session.id, values.prompt, "idle");
    await host.client.request("session.close", { sessionId: session.id });
  }

  if (scenarios.has("restore") && mainSession) {
    say("host: restarting to test a restored session");
    await host.close();
    host = await startHost();
    await host.client.request("session.attach", { sessionId: mainSession, afterSeq: 0 });
    // A person opens the session and reads it before typing.
    await new Promise((r) => setTimeout(r, 3_000));
    await turn(host.client, mainSession, values.prompt, "restore");
    await turn(host.client, mainSession, values.prompt, "restore+1");
  }

  if (scenarios.has("cli")) await cliRun(values.prompt);
} finally {
  if (mainSession) await host.client.request("session.close", { sessionId: mainSession }).catch(() => {});
  await host.close();
  await rm(stateDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- summary

const median = (xs: (number | undefined)[]): number | undefined => {
  const v = xs.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  return v.length === 0 ? undefined : v[Math.floor((v.length - 1) / 2)];
};
console.log("\nscenario   n  feedback   ack   item  delta   text    done  frames");
for (const scenario of [...new Set(results.map((r) => r.scenario))]) {
  const rs = results.filter((r) => r.scenario === scenario);
  const col = (k: keyof TurnResult, w: number): string => fmt(median(rs.map((r) => r[k] as number | undefined))).padStart(w);
  console.log(
    `${scenario.padEnd(9)} ${String(rs.length).padStart(2)} ${col("feedback", 9)} ${col("ack", 5)} ${col("item", 6)} ${col("delta", 6)} ${col("text", 6)} ${col("done", 7)} ${col("deltaFrames", 7)}`,
  );
}
process.exit(0);
