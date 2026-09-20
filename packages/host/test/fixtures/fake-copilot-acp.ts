// Stand-in for `copilot --acp` in tests. Speaks the same ACP JSON-RPC 2.0 dialect
// cursor/rpc.ts's own note describes, and plays one scripted turn per session/prompt: a
// thought, a message, a plan, and a shell command that needs approval. A prompt containing
// "fail" rejects the session/prompt request outright.
//
// The one deliberate departure from fake-cursor-acp.ts: every session/prompt here resolves
// with `stopReason: "end_turn"`, even one ended by session/cancel or by the client answering
// a permission request "cancelled" — measured against a live `copilot --acp`, which never
// reported "cancelled" as a stopReason in any of those cases. This fixture exists partly to
// pin that down: CopilotAcpSession must not rely on stopReason to know a turn was
// interrupted (see its own header note), and a fixture that faithfully returns "cancelled"
// the way Cursor's fake does would hide a regression back to trusting it.
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

const statePath = process.env.FAKE_COPILOT_STATE;
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

function recordOnly(sessionId: string, update: object): void {
  const log = loadLog();
  (log[sessionId] ??= []).push(update);
  saveLog(log);
}

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

function usage(turns: number): object {
  return { inputTokens: 100 * turns, outputTokens: 20 * turns, totalTokens: 120 * turns };
}

async function runTurn(sessionId: string, text: string, requestId: number | string, turnNumber: number): Promise<void> {
  if (text.includes("fail")) {
    send({ id: requestId, error: { code: -32000, message: "agent unavailable" } });
    return;
  }

  if (text.includes("edit approval")) {
    recordOnly(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    const toolCallId = `edit_${++callCount}`;
    updated(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Update file", kind: "edit", status: "pending", rawInput: "*** patch ***" });
    const approval = ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Update file", kind: "edit", status: "pending" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
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
      updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { message: "The user rejected this tool call.", code: "rejected" } });
    }
    send({ id: requestId, result: { stopReason: "end_turn", usage: usage(turnNumber) } });
    return;
  }

  recordOnly(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  updated(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
  updated(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running" } });
  updated(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " tests" } });
  updated(sessionId, { sessionUpdate: "plan", entries: [{ content: "Run tests", status: "in_progress" }] });

  const toolCallId = `call_${++callCount}`;
  updated(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run the test suite", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
  updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });

  const approval = ask("session/request_permission", {
    sessionId,
    toolCall: { toolCallId, title: "Run the test suite", kind: "execute", status: "pending", rawInput: { command: "npm test" } },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
    ],
  });

  // Whatever the client answered — allow, deny, or an interrupt() abort resolving as
  // "cancelled" — the turn itself always ends with stopReason "end_turn" here. That is the
  // measured, real Copilot behavior this fixture exists to pin down (see the file header).
  const answered = await approval.answer;
  const outcome = (answered.result as { outcome: { outcome: string; optionId?: string } }).outcome;

  if (outcome.outcome === "selected" && outcome.optionId?.startsWith("allow")) {
    updated(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { exitCode: 0, stdout: "ok\n", stderr: "" },
    });
    updated(sessionId, { sessionUpdate: "plan", entries: [{ content: "Run tests", status: "completed" }] });
  } else {
    updated(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { message: "The user rejected this tool call.", code: "rejected" } });
  }
  send({ id: requestId, result: { stopReason: "end_turn", usage: usage(turnNumber) } });
}

function replay(sessionId: string, id: number | string | undefined): void {
  for (const update of loadLog()[sessionId] ?? []) send({ method: "session/update", params: { sessionId, update } });
  send({ id, result: {} });
}

let turnCount = 0;

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
      send({ id: message.id, result: { protocolVersion: 1, authMethods: [{ id: "copilot-login", name: "Log in with Copilot CLI" }] } });
      break;
    case "authenticate":
      send({ id: message.id, result: {} });
      break;
    case "session/new":
      send({ id: message.id, result: { sessionId: `ses_${process.pid}_${++sessionCount}` } });
      break;
    case "session/load":
      replay(String(params.sessionId), message.id);
      break;
    case "session/prompt":
      void runTurn(String(params.sessionId), textOf(params), message.id as number | string, ++turnCount);
      break;
    case "session/cancel":
      // No-op, same reasoning as fake-cursor-acp.ts's own: the pending
      // session/request_permission always gets its own "cancelled" answer straight from the
      // client (interrupt() aborts the wait before it notifies), and that alone is what ends
      // the turn here.
      break;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
});
