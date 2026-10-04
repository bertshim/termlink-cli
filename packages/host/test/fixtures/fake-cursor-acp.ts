// Stand-in for `cursor-agent acp` in tests. Speaks real ACP JSON-RPC 2.0 (with the
// "jsonrpc" field this adapter's peer ignores either way) and plays one scripted turn per
// session/prompt: a thought, a message, a plan, and a shell command that needs approval.
// A prompt containing "fail" rejects the session/prompt request outright, the same way a
// real cursor-agent would if the model backing it were unreachable.
//
// Every session/update sent for a session is also kept (in memory, or in FAKE_CURSOR_STATE
// if set, the same trick fake-app-server.ts uses for Codex) so session/load can replay it —
// including from a second, unrelated process, standing in for "the host restarted and
// reconnected".
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface Message {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

let nextId = 900;
let sessionCount = 0;
let callCount = 0;
const answers = new Map<number, (message: Message) => void>();

const statePath = process.env.FAKE_CURSOR_STATE;
let memoryLog: Record<string, object[]> = {};

function loadLog(): Record<string, object[]> {
  if (!statePath) return memoryLog;
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, object[]>;
  } catch {
    return {};
  }
}

function saveLog(log: Record<string, object[]>): void {
  if (statePath) writeFileSync(statePath, JSON.stringify(log));
  else memoryLog = log;
}

/** Appends an update to a session's replay log without sending it live — for
 *  user_message_chunk, which the real cursor-agent only ever showed on replay (session/load),
 *  never on the live wire during the turn that sent it (measured: the client already knows
 *  what it just typed). */
function recordOnly(sessionId: string, update: object): void {
  const log = loadLog();
  (log[sessionId] ??= []).push(update);
  saveLog(log);
}

/** Sends a session/update live and appends it to that session's replay log. */
function updated(sessionId: string, update: object): void {
  send({ method: "session/update", params: { sessionId, update } });
  recordOnly(sessionId, update);
}

function ask(method: string, params: object): { id: number; answer: Promise<Message> } {
  const id = nextId++;
  const answer = new Promise<Message>((resolve) => answers.set(id, resolve));
  send({ id, method, params });
  return { id, answer };
}

function textOf(params: Record<string, unknown>): string {
  const prompt = params.prompt as { type?: string; text?: string }[] | undefined;
  return prompt?.find((b) => b.type === "text")?.text ?? "";
}

async function runTurn(sessionId: string, text: string, requestId: number | string): Promise<void> {
  if (text.includes("fail")) {
    send({ id: requestId, error: { code: -32000, message: "agent unavailable" } });
    return;
  }

  if (text.includes("edit approval")) {
    recordOnly(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    const toolCallId = `edit_${++callCount}`;
    updated(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Edit File", kind: "edit", status: "pending", rawInput: {} });
    const approval = ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Edit File", kind: "edit", status: "pending" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const answered = await approval.answer;
    const outcome = (answered.result as { outcome: { outcome: string; optionId?: string } }).outcome;
    if (outcome.outcome === "selected" && outcome.optionId?.startsWith("allow")) {
      updated(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "old\n", newText: "new\n" }],
      });
    } else {
      updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    }
    send({ id: requestId, result: { stopReason: "end_turn" } });
    return;
  }

  recordOnly(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  updated(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
  updated(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running" } });
  updated(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " tests" } });
  updated(sessionId, { sessionUpdate: "plan", entries: [{ content: "Run tests", status: "in_progress" }] });

  const toolCallId = `call_${++callCount}`;
  updated(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "`npm test`", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
  updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });

  const approval = ask("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId,
      title: "`npm test`",
      kind: "execute",
      status: "pending",
      content: [{ type: "content", content: { type: "text", text: "needs network access" } }],
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });

  // The client's own answer is authoritative: it resolves to "cancelled" both when a person
  // picked Reject and when interrupt() aborted the wait, and either way that is this turn's
  // last word on the tool call — there is nothing left to race it against.
  const answered = await approval.answer;
  const outcome = (answered.result as { outcome: { outcome: string; optionId?: string } }).outcome;

  if (outcome.outcome === "cancelled") {
    updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    send({ id: requestId, result: { stopReason: "cancelled" } });
    return;
  }

  if (outcome.outcome === "selected" && outcome.optionId?.startsWith("allow")) {
    updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { exitCode: 0, stdout: "ok\n", stderr: "" } });
    updated(sessionId, { sessionUpdate: "plan", entries: [{ content: "Run tests", status: "completed" }] });
  } else {
    updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
  }
  send({ id: requestId, result: { stopReason: "end_turn" } });
}

function replay(sessionId: string, id: number | string | undefined): void {
  for (const update of loadLog()[sessionId] ?? []) send({ method: "session/update", params: { sessionId, update } });
  send({ id, result: {} });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Message;
  if (message.method === undefined) {
    if (typeof message.id === "number") {
      answers.get(message.id)?.(message);
      answers.delete(message.id);
    }
    return;
  }
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: 1, authMethods: [{ id: "cursor_login", name: "Cursor Login" }] } });
      break;
    case "authenticate":
      send({ id: message.id, result: {} });
      break;
    case "session/new":
      // `models` alongside the id, the way the real cursor-agent replies — it
      // is where the account's current model comes from when none is
      // configured, and it used to be destructured away.
      send({
        id: message.id,
        result: {
          sessionId: `ses_${process.pid}_${++sessionCount}`,
          models: {
            currentModelId: "fake-cursor-auto",
            availableModels: [{ modelId: "fake-cursor-auto", name: "Auto" }],
          },
        },
      });
      break;
    case "session/load":
      replay(String(params.sessionId), message.id);
      break;
    case "session/set_model":
      // Recorded under a key no real sessionId collides with, purely so a test reading
      // FAKE_CURSOR_STATE back can see which model a session asked for.
      recordOnly(`__model__${String(params.sessionId)}`, { modelId: params.modelId });
      send({ id: message.id, result: {} });
      break;
    case "session/set_mode":
      recordOnly(`__mode__${String(params.sessionId)}`, { modeId: params.modeId });
      send({ id: message.id, result: {} });
      break;
    case "session/prompt":
      void runTurn(String(params.sessionId), textOf(params), message.id as number | string);
      break;
    case "session/cancel":
      // No-op here: this fixture's only turn always has a pending session/request_permission
      // by the time a real interrupt() could reach it, and that gets its own "cancelled"
      // answer straight from the client (interrupt() aborts the wait before it notifies).
      break;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
});
