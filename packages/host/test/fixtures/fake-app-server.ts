// Stand-in for `codex app-server` in tests. Speaks the same newline-delimited JSON-RPC and
// plays one scripted turn per turn/start: a streamed message, a plan, and a command that
// needs approval. A prompt containing "fail" ends the turn with an error instead.
// Finished turns are kept for thread/turns/list; with FAKE_CODEX_STATE set they are
// stored in that file, so a later process (a restarted host) can read them back.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stripSteerNote } from "../../src/providers/steer-note.js";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (method: string, params: object): void => send({ method, params });

const answers = new Map<number, (result: unknown) => void>();
const turnsByThread = new Map<string, number>();
const statePath = process.env.FAKE_CODEX_STATE;
let memoryHistory: Record<string, object[]> = {};
let nextRequestId = 900;
let threadCount = 0;
let turnCount = 0;
let interruptTurn: (() => void) | null = null;
/** The turn running on each thread, with the messages turn/steer added to it. */
const activeTurns = new Map<string, { turnId: string; notes: string[] }>();

function loadHistory(): Record<string, object[]> {
  if (!statePath) return memoryHistory;
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, object[]>;
  } catch {
    return {};
  }
}

function recordTurn(threadId: string, turn: object): void {
  const all = loadHistory();
  (all[threadId] ??= []).push(turn);
  if (statePath) writeFileSync(statePath, JSON.stringify(all));
  else memoryHistory = all;
}

function ask(method: string, params: object): { id: number; answer: Promise<unknown> } {
  const id = nextRequestId++;
  const answer = new Promise<unknown>((resolve) => answers.set(id, resolve));
  send({ id, method, params });
  return { id, answer };
}

function usage(input: number, output: number): object {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
  };
}

async function runTurn(threadId: string, turnId: string, text: string): Promise<void> {
  const base = { threadId, turnId };
  const done: object[] = [];
  const turn = (status: string, error: string | null = null) => ({
    id: turnId,
    status,
    items: done,
    error: error ? { message: error } : null,
  });
  const finish = (status: string, error: string | null = null): void => {
    activeTurns.delete(threadId);
    recordTurn(threadId, turn(status, error));
    notify("turn/completed", { threadId, turn: turn(status, error) });
  };
  const active = { turnId, notes: [] as string[] };
  activeTurns.set(threadId, active);
  notify("turn/started", { threadId, turn: turn("inProgress") });
  const user = { type: "userMessage", id: `user_${turnId}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
  notify("item/started", { ...base, item: user });
  notify("item/completed", { ...base, item: user });
  done.push(user);

  if (text.includes("fail")) {
    notify("error", { ...base, error: { message: "model unavailable" }, willRetry: false });
    finish("failed", "model unavailable");
    return;
  }

  const messageId = `msg_${turnId}`;
  const message = { type: "agentMessage", id: messageId, text: "Running tests" };
  notify("item/started", { ...base, item: { ...message, text: "" } });
  notify("item/agentMessage/delta", { ...base, itemId: messageId, delta: "Running" });
  notify("item/agentMessage/delta", { ...base, itemId: messageId, delta: " tests" });
  notify("item/completed", { ...base, item: message });
  done.push(message);
  notify("turn/plan/updated", { ...base, explanation: null, plan: [{ step: "Run tests", status: "inProgress" }] });

  const commandId = `cmd_${turnId}`;
  const command = {
    type: "commandExecution",
    id: commandId,
    command: "npm test",
    cwd: "/repo",
    status: "inProgress",
    aggregatedOutput: null,
    exitCode: null,
  };
  notify("item/started", { ...base, item: command });
  const approval = ask("item/commandExecution/requestApproval", {
    ...base,
    kind: "command",
    itemId: commandId,
    startedAtMs: Date.now(),
    command: "npm test",
    cwd: "/repo",
    reason: "needs network access",
  });
  const interrupted = new Promise<"interrupted">((resolve) => {
    interruptTurn = () => resolve("interrupted");
  });
  const outcome = await Promise.race([approval.answer, interrupted]);
  interruptTurn = null;
  const decision = outcome === "interrupted" ? "cancel" : (outcome as { decision?: string }).decision;

  if (decision === "cancel") {
    if (outcome === "interrupted") notify("serverRequest/resolved", { threadId, requestId: approval.id });
    const declined = { ...command, status: "declined" };
    notify("item/completed", { ...base, item: declined });
    done.push(declined);
    finish("interrupted");
    return;
  }
  if (decision === "accept" || decision === "acceptForSession") {
    notify("item/commandExecution/outputDelta", { ...base, itemId: commandId, delta: "ok\n" });
    const ran = { ...command, status: "completed", aggregatedOutput: "ok\n", exitCode: 0 };
    notify("item/completed", { ...base, item: ran });
    done.push(ran);
  } else {
    const declined = { ...command, status: "declined" };
    notify("item/completed", { ...base, item: declined });
    done.push(declined);
  }
  notify("turn/plan/updated", { ...base, explanation: null, plan: [{ step: "Run tests", status: "completed" }] });

  // Messages steered in while it worked, read at this step.
  for (const [i, note] of active.notes.splice(0).entries()) {
    const noted = { type: "agentMessage", id: `note_${turnId}_${i}`, text: `Noted: ${stripSteerNote(note)}` };
    notify("item/started", { ...base, item: { ...noted, text: "" } });
    notify("item/completed", { ...base, item: noted });
    done.push(noted);
  }

  const turns = (turnsByThread.get(threadId) ?? 0) + 1;
  turnsByThread.set(threadId, turns);
  notify("thread/tokenUsage/updated", {
    ...base,
    tokenUsage: { total: usage(100 * turns, 20 * turns), last: usage(100, 20) },
  });
  finish("completed");
}

function textOf(params: Record<string, unknown>): string {
  const input = params.input as { text?: string }[] | undefined;
  return input?.[0]?.text ?? "";
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Message;
  if (message.method === undefined) {
    if (typeof message.id === "number") {
      answers.get(message.id)?.(message.result ?? message.error);
      answers.delete(message.id);
    }
    return;
  }
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake/0", codexHome: "", platformFamily: "test", platformOs: "test" } });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ id: message.id, result: { thread: { id: `thr_${process.pid}_${++threadCount}` }, model: "fake", cwd: params.cwd } });
      break;
    case "thread/resume":
      send({ id: message.id, result: { thread: { id: params.threadId }, model: "fake", cwd: params.cwd } });
      break;
    case "thread/turns/list": {
      const turns = loadHistory()[String(params.threadId)] ?? [];
      const limit = typeof params.limit === "number" ? params.limit : turns.length;
      send({ id: message.id, result: { data: [...turns].reverse().slice(0, limit), nextCursor: null, backwardsCursor: null } });
      break;
    }
    case "turn/start": {
      const turnId = `turn_${process.pid}_${++turnCount}`;
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      void runTurn(String(params.threadId), turnId, textOf(params));
      break;
    }
    case "turn/steer": {
      const threadId = String(params.threadId);
      const active = activeTurns.get(threadId);
      if (!active || active.turnId !== params.expectedTurnId) {
        send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
        break;
      }
      const text = textOf(params);
      // Codex reports the steered input as a user message item of the running turn.
      const user = {
        type: "userMessage",
        id: `user_${active.turnId}_${active.notes.length + 1}`,
        clientId: null,
        content: [{ type: "text", text, text_elements: [] }],
      };
      notify("item/started", { threadId, turnId: active.turnId, item: user });
      notify("item/completed", { threadId, turnId: active.turnId, item: user });
      active.notes.push(text);
      send({ id: message.id, result: { turnId: active.turnId } });
      break;
    }
    case "turn/interrupt":
      interruptTurn?.();
      send({ id: message.id, result: {} });
      break;
    case "thread/unsubscribe":
      send({ id: message.id, result: { status: "unsubscribed" } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
});
