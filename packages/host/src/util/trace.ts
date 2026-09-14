import { performance } from "node:perf_hooks";
import type { HostMessage } from "@termlink/protocol";

/**
 * Turn latency tracing for development. Off unless TERMLINK_TRACE is set
 * (`1`, or `verbose` for a line per mark). When off, every call site is guarded by
 * the TRACE constant, so production pays one boolean check and nothing else.
 *
 * Times are milliseconds from the moment the host received session.send (T1).
 * One summary line is printed per turn when it completes.
 */
const mode = (process.env.TERMLINK_TRACE ?? "").trim().toLowerCase();
export const TRACE = mode !== "" && mode !== "0" && mode !== "false" && mode !== "off";
const VERBOSE = mode === "verbose" || mode === "2";

let log: (line: string) => void = (line) => console.error(line);

/** Where trace lines go; stderr by default. */
export function setTraceLog(fn: (line: string) => void): void {
  log = fn;
}

/** A one-off line outside the per-turn summary (a restart, an interrupt receipt). */
export function traceLine(text: string): void {
  log(`[trace] ${text}`);
}

interface ToolTrace {
  name: string;
  /** The full tool_use block arrived (input complete). */
  seen: number;
  ask?: number;
  answer?: number;
  result?: number;
  /** First API stream event after the result: Claude has the result and is answering. */
  next?: number;
}

interface TurnTrace {
  sessionId: string;
  n: number;
  wall: number;
  start: number;
  marks: Map<string, number>;
  tools: Map<string, ToolTrace>;
  textItem: string | null;
  deltasIn: number;
  deltaFramesOut: number;
}

const turns = new Map<string, TurnTrace>();
const turnCounts = new Map<string, number>();
const spawns = new Map<string, { start: number; resume: boolean }>();

const now = (): number => performance.now();

/** T1: the host has the session.send command. `at` is when its frame arrived. */
export function traceTurnBegin(sessionId: string, at: number = now()): void {
  const n = (turnCounts.get(sessionId) ?? 0) + 1;
  turnCounts.set(sessionId, n);
  turns.set(sessionId, {
    sessionId,
    n,
    wall: Date.now() - (now() - at),
    start: at,
    marks: new Map(),
    tools: new Map(),
    textItem: null,
    deltasIn: 0,
    deltaFramesOut: 0,
  });
  if (VERBOSE) log(`[trace] ${sessionId} #${n} recv at ${new Date(Date.now() - (now() - at)).toISOString()}`);
}

/** Records the first occurrence of a named point in the current turn. */
export function traceMark(sessionId: string, name: string): void {
  const turn = turns.get(sessionId);
  if (!turn || turn.marks.has(name)) return;
  const t = now();
  turn.marks.set(name, t);
  if (VERBOSE) log(`[trace] ${sessionId} #${turn.n} ${name} +${(t - turn.start).toFixed(1)}ms`);
}

/** T4: the first text delta of the turn, and the item it belongs to (to spot when it is sent). */
export function traceText(sessionId: string, itemId: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turn.textItem ??= itemId;
  traceMark(sessionId, "text");
}

export function traceDeltaIn(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (turn) turn.deltasIn++;
}

/** Called by a transport right after it wrote a message to its socket (T5 and friends). */
export function traceSent(message: HostMessage): void {
  if (message.kind !== "evt" || !message.sessionId) return;
  const turn = turns.get(message.sessionId);
  if (!turn) return;
  traceMark(turn.sessionId, "firstSent");
  if (message.type === "item.delta") {
    turn.deltaFramesOut++;
    traceMark(turn.sessionId, "deltaSent");
    if (message.payload.itemId === turn.textItem) traceMark(turn.sessionId, "textSent");
  } else if (message.type === "item.started" && message.payload.item.kind === "message" && message.payload.item.role === "assistant") {
    traceMark(turn.sessionId, "msgStartSent");
  }
}

export function traceTool(sessionId: string, toolId: string, phase: "seen" | "ask" | "answer" | "result", name?: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  const t = now();
  let tool = turn.tools.get(toolId);
  if (!tool) {
    tool = { name: name ?? "?", seen: t };
    turn.tools.set(toolId, tool);
  }
  if (phase !== "seen" && tool[phase] === undefined) tool[phase] = t;
}

/** A new API response started streaming; the tools that already have results were handed back. */
export function traceApiStart(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  traceMark(sessionId, "apiStart");
  const t = now();
  for (const tool of turn.tools.values()) if (tool.result !== undefined && tool.next === undefined) tool.next = t;
}

/** Prints the turn's summary line and forgets it. */
export function traceTurnEnd(sessionId: string, status: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turns.delete(sessionId);
  const at = (name: string): number | undefined => {
    const t = turn.marks.get(name);
    return t === undefined ? undefined : t - turn.start;
  };
  const ms = (v: number | undefined): string => (v === undefined ? "-" : String(Math.round(v)));
  const between = (a: string, b: string): string => {
    const x = at(a);
    const y = at(b);
    return x === undefined || y === undefined ? "-" : String(Math.round(y - x));
  };
  const end = now() - turn.start;
  const points = ["ack", "firstSent", "provider", "push", "sdkRead", "sdkMsg", "apiStart", "thinkStart", "thinking", "text", "textSent", "result"]
    .map((name) => `${name}=${ms(at(name))}`)
    .join(" ");
  const tools = [...turn.tools.values()]
    .map((tool) => {
      const run = tool.answer ?? tool.seen;
      const parts = [
        tool.ask !== undefined ? `ask=${Math.round(tool.ask - tool.seen)}` : null,
        tool.ask !== undefined && tool.answer !== undefined ? `perm=${Math.round(tool.answer - tool.ask)}` : null,
        tool.result !== undefined ? `exec=${Math.round(tool.result - run)}` : null,
        tool.result !== undefined && tool.next !== undefined ? `next=${Math.round(tool.next - tool.result)}` : null,
      ].filter(Boolean);
      return `${tool.name}(${parts.join(",")})`;
    })
    .join(" ");
  log(
    `[trace] ${turn.sessionId} #${turn.n} ${status} at=${new Date(turn.wall).toISOString()} | ${points} end=${Math.round(end)} | ` +
      `push>sdkMsg=${between("push", "sdkMsg")} push>api=${between("push", "apiStart")} push>text=${between("push", "text")} ` +
      `text>sent=${between("text", "textSent")} deltas=${turn.deltasIn}/${turn.deltaFramesOut}` +
      (tools ? ` | tools: ${tools}` : ""),
  );
}

/** A provider process was spawned for a session (cold start). */
export function traceSpawn(sessionId: string, resume: boolean): void {
  spawns.set(sessionId, { start: now(), resume });
}

/** The spawned process produced its first message (it finished starting). */
export function traceSpawnReady(sessionId: string, what: string): void {
  const spawn = spawns.get(sessionId);
  if (!spawn) return;
  spawns.delete(sessionId);
  log(`[trace] ${sessionId} claude ${spawn.resume ? "resume" : "start"}: first message (${what}) after ${Math.round(now() - spawn.start)}ms`);
}

export const traceNow = now;
