// Minimal protocol client: opens a session, sends one message, answers every approval
// with a fixed decision, prints the timeline and exits.
//
//   npm run demo -- "ws://127.0.0.1:7420/ws?token=..." [--provider codex] [--text "..."]
//                   [--cwd <dir>] [--decision <id>]
import { once } from "node:events";
import { parseArgs } from "node:util";
import type { CommandResults, CommandType, HostMessage } from "@termlink/protocol";
import { WebSocket } from "ws";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", default: "claude" },
    text: { type: "string", default: "The auth tests are failing. Fix them." },
    cwd: { type: "string", default: process.cwd() },
    decision: { type: "string" },
  },
});
const url = positionals[0] ?? process.env.TERMLINK_LOCAL_URL;
if (!url) {
  console.error('usage: npm run demo -- "ws://127.0.0.1:7420/ws?token=..." [--provider codex] [--text "..."]');
  process.exit(1);
}

const ws = new WebSocket(url);
const waiting = new Map<string, (message: HostMessage) => void>();
let nextReq = 0;
let turnDone: () => void = () => {};
let finished = false;

function request<T extends CommandType>(type: T, payload: unknown): Promise<CommandResults[T]> {
  const reqId = `demo${++nextReq}`;
  ws.send(JSON.stringify({ v: 1, kind: "cmd", reqId, type, payload }));
  return new Promise((resolve, reject) => {
    waiting.set(reqId, (message) => {
      if (message.kind !== "res") return;
      if (message.ok) resolve(message.result as CommandResults[T]);
      else reject(new Error(`${message.error.code}: ${message.error.message}`));
    });
  });
}

ws.on("message", (data) => {
  const message = JSON.parse(data.toString()) as HostMessage;
  if (message.kind === "res") {
    waiting.get(message.reqId)?.(message);
    waiting.delete(message.reqId);
    return;
  }
  const seq = message.seq === undefined ? "    " : String(message.seq).padStart(4);
  switch (message.type) {
    case "host.ready":
      for (const p of message.payload.providers) {
        console.log(`provider ${p.id}: ${p.available ? "ready" : "unavailable"}${p.detail ? ` (${p.detail})` : ""}`);
      }
      break;
    case "session.updated":
      console.log(`     [status ${message.payload.session.status}]`);
      break;
    case "turn.started":
      console.log(`${seq} turn started`);
      break;
    case "item.started": {
      const { item } = message.payload;
      if (item.kind === "message") process.stdout.write(`${seq} assistant: `);
      if (item.kind === "reasoning") process.stdout.write(`${seq} thinking: `);
      if (item.kind === "command") console.log(`${seq} $ ${item.command}`);
      break;
    }
    case "item.delta":
      process.stdout.write(message.payload.field === "output" ? `       | ${message.payload.delta}` : message.payload.delta);
      break;
    case "item.completed": {
      const { item } = message.payload;
      if (item.kind === "message" && item.role === "user") console.log(`${seq} you: ${item.text}`);
      else if (item.kind === "message" || item.kind === "reasoning") process.stdout.write("\n");
      else if (item.kind === "command") console.log(`${seq} command ${item.status}, exit ${item.exitCode ?? "-"}`);
      else if (item.kind === "file_change") for (const c of item.changes) console.log(`${seq} ${c.action} ${c.path}\n${c.diff ?? ""}`);
      else if (item.kind === "tool") console.log(`${seq} tool ${item.name} ${item.status}`);
      else if (item.kind === "todo") console.log(`${seq} plan: ${item.entries.map((e) => `${e.done ? "[x]" : "[ ]"} ${e.text}`).join("  ")}`);
      break;
    }
    case "input.required": {
      const { request: req } = message.payload;
      const choice = req.decisions.find((d) => d.id === values.decision) ?? req.decisions[0];
      const detail = req.command ? ` ${req.command}` : "";
      console.log(`${seq} ? ${req.title}${detail} [${req.decisions.map((d) => d.id).join(" / ")}] -> ${choice?.id}`);
      if (choice && message.sessionId) {
        setTimeout(() => {
          void request("input.respond", { sessionId: message.sessionId, requestId: req.requestId, decisionId: choice.id });
        }, 500);
      }
      break;
    }
    case "error":
      console.log(`${seq} error ${message.payload.code}: ${message.payload.message}`);
      break;
    case "turn.completed": {
      const { status, usage, error } = message.payload;
      const tokens = usage ? ` (${usage.inputTokens} in / ${usage.outputTokens} out)` : "";
      console.log(`${seq} turn ${status}${tokens}${error ? `: ${error}` : ""}`);
      turnDone();
      break;
    }
  }
});

ws.on("close", () => {
  if (finished) return;
  console.error("connection closed before the turn finished");
  process.exit(1);
});

await once(ws, "open");
const { session } = await request("session.create", { provider: values.provider, cwd: values.cwd, title: "demo" });
const done = new Promise<void>((resolve) => (turnDone = resolve));
await request("session.send", { sessionId: session.id, input: { text: values.text } });
await done;
finished = true;
await request("session.close", { sessionId: session.id });
ws.close();
