import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKAssistantMessageError,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { applyDelta, type Decision, type InputRequest, type Item, type Usage } from "@termlink/protocol";
import { HostError } from "../../errors.js";
import { isUsageLimitError, resolveRetryAt, RETRY_AFTER_RESET_MS } from "./rate-limit.js";
import {
  TRACE,
  traceApiStart,
  traceDeltaIn,
  traceLine,
  traceMark,
  traceSpawn,
  traceSpawnReady,
  traceText,
  traceTool,
} from "../../util/trace.js";
import { VERSION } from "../../version.js";
import { isSlashCommand, withSteerNote } from "../steer-note.js";
import type { EventSink, ProviderSession, UserInput } from "../types.js";
import { InputQueue } from "./input-queue.js";
import { completeToolItem, mapToolUse, type ToolResult } from "./mapper.js";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
type ToolOptions = Parameters<CanUseTool>[2];

/** How long Stop waits for the turn's result frame before the process is restarted. */
export const INTERRUPT_TIMEOUT_MS = 10_000;
/** After the interrupt's receipt, how long a result that may be on its way is given. */
const RECEIPT_GRACE_MS = 1_000;
/** How long Stop waits when the turn has not reached the API yet (the process is still starting). */
const UNARMED_TIMEOUT_MS = 1_500;
/** Waits before sending a turn's message again after Claude Code failed to refresh its login (see #retryable). */
export const AUTH_RETRY_DELAYS_MS: readonly number[] = [3_000, 8_000];
/**
 * What Claude Code says when it could not refresh the machine's shared OAuth token because
 * another Claude Code process holds the refresh lock (it is refreshing, or died doing so).
 * It ends the turn with this before anything reaches the API; the next try usually works.
 */
const AUTH_REFRESH_RACE = /Failed to refresh OAuth token/i;
/** How many sent-but-not-yet-taken message uuids are remembered; far more than ever wait at once. */
const MAX_PUSHED = 500;
/** Caps the auto-restart chain for one run of usage-limit hits (see #maybeRetryLimit) — belt
 *  and suspenders against a runaway loop if resolveRetryAt ever mis-scheduled; a real reset
 *  is hours away, so a session legitimately hitting the cap is not one this saves anyway. */
export const MAX_LIMIT_RETRIES = 5;

// Content blocks and stream events are read structurally; the SDK types them
// through the Anthropic API client, and only a few fields matter here.
type Block = { type: string };
type TextBlock = { type: "text"; text: string };
type ThinkingBlock = { type: "thinking"; thinking: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = ToolResult & { type: "tool_result"; tool_use_id: string };
type StreamEvent =
  | { type: "message_start"; message: { id: string } }
  | { type: "content_block_start"; index: number; content_block: Block }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; thinking?: string } };

/** interrupt() takes options the SDK's Query type does not declare yet (sdk.mjs does). */
type InterruptFn = (options?: { cancelQueued?: boolean }) => Promise<{ still_queued?: string[]; cancelled?: string[] } | undefined>;

interface AskQuestion {
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface ClaudeSessionOptions {
  /** Host session id, used only to label trace lines. */
  traceId?: string | undefined;
  cwd: string;
  resume?: string | undefined;
  /** Spawns Claude Code with `--chrome` (the SDK's own `extraArgs`), so this
   *  session's tools include browser control over an already-paired Chrome
   *  extension (~/.claude.json's own `chromeExtension` pairing — this flag
   *  only turns the integration ON for the process, it does not pair
   *  anything itself). Claude only; Codex has no such flag. */
  chrome?: boolean | undefined;
  model?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  executable?: string | undefined;
  queryFn: QueryFn;
  interruptTimeoutMs?: number | undefined;
  /** Waits before each resend of a turn lost to the login-refresh race; AUTH_RETRY_DELAYS_MS by default. */
  authRetryDelaysMs?: readonly number[] | undefined;
  /** How long past a usage limit's own reset the auto-retry waits (see rate-limit.ts);
   *  RETRY_AFTER_RESET_MS by default. Tests shorten it so they need not wait out a real minute. */
  limitRetryAfterResetMs?: number | undefined;
}

/**
 * One Claude Code process and the streams into and out of it. A session normally has
 * one for its whole life; a Stop the process does not honour replaces it with another
 * on the same Claude session id (see interrupt()).
 */
interface Link {
  /** Increases per process; frames from a replaced one are dropped by it. */
  gen: number;
  input: InputQueue<SDKUserMessage>;
  query: Query;
  /** Resolves at the process's first message (system/init): it is up and reading. */
  ready: Promise<void>;
  markReady: () => void;
}

/**
 * One long-lived Claude Code session in streaming-input mode. Each send() pushes a
 * user message; the turn ends at the matching result message. A message pushed while
 * a turn runs (steer) is folded into it by Claude Code at its next tool boundary.
 *
 * Lifecycle, as the host session sees it through the sink:
 *   send → turn.started → items … → turn.completed (completed | failed)
 *   interrupt → [permission requests cancelled] → turn.completed interrupted
 * and inside interrupt():
 *   interrupt control request → result frame within INTERRUPT_TIMEOUT_MS → done
 *                             → no result in time → process restarted on the same
 *                               session (resume), turn.completed interrupted
 */
export class ClaudeSession implements ProviderSession {
  #sessionId: string;
  readonly #sink: EventSink;
  readonly #cwd: string;
  readonly #options: ClaudeSessionOptions;
  readonly #interruptTimeoutMs: number;
  #link: Link;
  #gen = 0;
  /** Items still in progress, by id: streamed text/thinking blocks and tool uses. */
  readonly #items = new Map<string, Item>();
  /** Streamed block item ids per message and kind, in order, to pair with the full assistant message. */
  readonly #streamed = new Map<string, string[]>();
  readonly #blockIds = new Map<number, string>();
  readonly #declined = new Set<string>();
  readonly #requests = new Set<AbortController>();
  /** Messages steered into the turn and not yet read, by the uuid they were pushed with. */
  readonly #steered = new Map<string, string>();
  /** Uuids of the user messages written to Claude Code and not yet taken, in the order they went. */
  #pushed: string[] = [];
  #messageId: string | null = null;
  #turnId: string | null = null;
  #turnCount = 0;
  /** The running turn has reached the API: a message started on the main thread. */
  #armed = false;
  /** Something to resume: a turn has ended on this session, or it was resumed to begin with. */
  #hasTranscript: boolean;
  #turnWaiters: (() => void)[] = [];
  #interrupting = false;
  #closing = false;
  #dead: Error | null = null;
  #costSoFar = 0;
  readonly #traceId: string;
  /** The text send() opened the running turn with; null for a turn Claude Code began itself. */
  #turnText: string | null = null;
  /** How many times the running turn's message has been sent again (see #retryable). */
  #retries = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  /** An API error Claude Code reported as an assistant message, held until the turn's result says what came of it. */
  #heldError: { messageId: string; blocks: Block[]; code?: SDKAssistantMessageError } | null = null;
  readonly #authRetryDelays: readonly number[];
  readonly #limitRetryAfterReset: number;
  /** The most recent rate_limit_event frame — ambient plan state, not tied to any one
   *  turn (see #maybeRetryLimit and rate-limit.ts's resolveRetryAt). */
  #rateLimitInfo: Pick<SDKRateLimitInfo, "status" | "resetsAt"> | null = null;
  /** How many turns in the current run of usage-limit hits have been auto-resent; see MAX_LIMIT_RETRIES. */
  #limitRetries = 0;

  constructor(sink: EventSink, options: ClaudeSessionOptions) {
    this.#sink = sink;
    this.#cwd = options.cwd;
    this.#options = options;
    this.#traceId = options.traceId ?? "";
    this.#interruptTimeoutMs = options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
    this.#authRetryDelays = options.authRetryDelaysMs ?? AUTH_RETRY_DELAYS_MS;
    this.#limitRetryAfterReset = options.limitRetryAfterResetMs ?? RETRY_AFTER_RESET_MS;
    this.#sessionId = options.resume ?? randomUUID();
    this.#hasTranscript = options.resume !== undefined;
    this.#link = this.#connect(options.resume !== undefined);
  }

  /** The Claude session id. Changes only if a restart finds nothing to resume (see #restart). */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** Spawns Claude Code on this session: fresh, or resumed from its transcript. */
  #connect(resume: boolean): Link {
    const gen = ++this.#gen;
    const input = new InputQueue<SDKUserMessage>();
    let markReady = (): void => {};
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const options = this.#options;
    if (TRACE) traceSpawn(this.#traceId, resume);
    const query = options.queryFn({
      prompt: TRACE ? this.#tracedInput(input) : input,
      options: {
        cwd: options.cwd,
        includePartialMessages: true,
        canUseTool: (tool, input, opts) => this.#canUseTool(tool, input, opts),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `termlink-node/${VERSION}` },
        ...(resume ? { resume: this.#sessionId } : { sessionId: this.#sessionId }),
        ...(options.model ? { model: options.model } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
        // extraArgs' own values are strings, null for a boolean flag (the
        // SDK's own doc comment on it) — this becomes plain `--chrome` on
        // the spawned CLI's command line.
        ...(options.chrome ? { extraArgs: { chrome: null } } : {}),
      },
    });
    const link: Link = { gen, input, query, ready, markReady };
    void this.#consume(link);
    return link;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#dead) throw new HostError("conflict", `claude session ended: ${this.#dead.message}`);
    if (this.#turnId) throw new HostError("conflict", "a turn is already running");
    this.#openTurn();
    this.#turnText = input.text;
    if (TRACE) traceMark(this.#traceId, "push");
    // Written to the process's stdin at once, whether or not it has finished starting:
    // Claude Code queues it and runs it as soon as it is up.
    this.#push(this.#link, input.text);
  }

  /**
   * A message for the turn that is running. Claude Code queues it and, at priority
   * "next", folds it into the turn at the next tool boundary, where Claude reads it
   * before going on. One that comes too late to fold runs as a turn of its own after
   * this one; #handle opens that turn when its first frame arrives.
   */
  async steer(input: UserInput, itemId: string): Promise<void> {
    if (this.#dead) throw new HostError("conflict", `claude session ended: ${this.#dead.message}`);
    if (!this.#turnId) return this.send(input);
    // The uuid comes back on the first reply frame after Claude Code folds the
    // message in (user_message_uuids): that is when Claude has read it.
    // A slash command goes as typed: Claude Code runs it after the turn, and anything
    // added would become the command's arguments (the note once became a model name).
    const content = isSlashCommand(input.text) ? input.text : withSteerNote(input.text);
    const uuid = this.#push(this.#link, content, "next");
    this.#steered.set(uuid, itemId);
  }

  /** Writes a user message to Claude Code, stamped with a uuid its frames will name once it is taken. */
  #push(link: Link, content: string, priority?: "next"): string {
    const uuid = randomUUID();
    this.#pushed.push(uuid);
    if (this.#pushed.length > MAX_PUSHED) this.#pushed.splice(0, this.#pushed.length - MAX_PUSHED);
    link.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid,
      ...(priority ? { priority } : {}),
    });
    return uuid;
  }

  /**
   * Steered messages Claude Code has taken, reported as read. A reply frame names the
   * messages its turn has taken in (user_message_uuids): one folded into the turn, or one
   * that runs as a turn of its own. A slash command names its message on its result
   * instead, with no reply frames at all. And Claude Code takes queued messages in the
   * order they came, so once a message is named, every one pushed before it has been
   * taken too, named or not: none is left queued behind a later one.
   */
  #noteRead(message: SDKMessage): void {
    if (message.type !== "assistant" && message.type !== "stream_event" && message.type !== "result") return;
    if (message.type !== "result" && message.parent_tool_use_id !== null) return;
    const m = message as unknown as { user_message_uuid?: string; user_message_uuids?: string[] };
    const uuids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    let last = -1;
    for (const uuid of uuids) last = Math.max(last, this.#pushed.indexOf(uuid));
    if (last < 0) return;
    for (const uuid of this.#pushed.splice(0, last + 1)) {
      const itemId = this.#steered.get(uuid);
      if (!itemId) continue;
      this.#steered.delete(uuid);
      this.#sink.messageRead(itemId);
    }
  }

  #openTurn(): void {
    const turnId = `turn_${++this.#turnCount}`;
    this.#turnId = turnId;
    this.#interrupting = false;
    this.#armed = false;
    this.#turnText = null;
    this.#retries = 0;
    this.#heldError = null;
    this.#sink.emit("turn.started", { turnId });
  }

  /** The first frame of Claude working on something: a new API message on the main thread. */
  #opensTurn(message: SDKMessage): boolean {
    if (message.type === "assistant") return message.parent_tool_use_id === null;
    return (
      message.type === "stream_event" &&
      message.parent_tool_use_id === null &&
      (message.event as { type?: string }).type === "message_start"
    );
  }

  /** The input queue as the SDK sees it, marking when the SDK takes each message. */
  async *#tracedInput(input: InputQueue<SDKUserMessage>): AsyncGenerator<SDKUserMessage, void> {
    for await (const message of input) {
      traceMark(this.#traceId, "sdkRead");
      yield message;
    }
  }

  /**
   * Stops the running turn and resolves once it has ended. Messages sent during the
   * turn that Claude has not read yet are dropped with it (cancelQueued), so nothing
   * starts a new turn right after the Stop.
   *
   * What ends the turn is its result frame, not the interrupt's receipt — with one
   * exception. A turn that never reached the API (a Stop right after the first send
   * of a fresh session, before the process was up) has no result coming: the receipt
   * says the message was dropped from the queue, and that is the end of it. The
   * receipt itself is never waited for alone: the CLI answers it only once it is up
   * (measured at 11 s in that case).
   *
   * If the turn does not end within the timeout the process is not trusted any
   * further: it is replaced by a new one on the same conversation (#restart).
   */
  async interrupt(): Promise<void> {
    const turnId = this.#turnId;
    if (!turnId) return;
    const link = this.#link;
    this.#interrupting = true;
    for (const abort of this.#requests) abort.abort();
    const done = new Promise<void>((resolve) => this.#turnWaiters.push(resolve));
    const started = Date.now();
    const receipt = (link.query.interrupt as InterruptFn)({ cancelQueued: true }).then(
      (r) => {
        if (TRACE) {
          traceLine(
            `${this.#traceId} interrupt receipt after ${Date.now() - started}ms: armed=${this.#armed} ` +
              `still_queued=${r?.still_queued?.length ?? 0} cancelled=${r?.cancelled?.length ?? 0}`,
          );
        }
      },
      () => {},
    );
    const deadline = started + this.#interruptTimeoutMs;
    // A turn that has not reached the API is given less: the process is still
    // starting (a fresh one answers nothing for seconds), and the message it
    // holds has cost nothing yet — a restart loses nothing but that start.
    const outcome = await Promise.race([
      done.then(() => "done" as const),
      receipt.then(() => "receipt" as const),
      sleepMs(this.#armed ? this.#interruptTimeoutMs : Math.min(UNARMED_TIMEOUT_MS, this.#interruptTimeoutMs)).then(() => "timeout" as const),
    ]);
    if (this.#turnId !== turnId) return;
    if (outcome === "done") return;
    if (outcome === "receipt" && !this.#armed) {
      // Nothing reached the API, so nothing will answer: the message is gone from the queue.
      await withTimeout(done, RECEIPT_GRACE_MS);
      if (this.#turnId === turnId) this.#completeTurn("interrupted");
      return;
    }
    if (this.#armed) {
      // The result follows the receipt on a clean interrupt; give it the rest of the time.
      const remaining = Math.max(RECEIPT_GRACE_MS, deadline - Date.now());
      if (await withTimeout(done, remaining)) return;
    }
    if (this.#turnId === turnId) await this.#restart(link, "the turn did not stop in time");
  }

  /**
   * Replaces the process. The turn in progress ends as interrupted; items it left
   * open end with it. Claude Code writes the transcript as it goes, so the new process
   * resumes it and what was said before the Stop is still there — unless nothing was:
   * a session with no finished turn has no transcript to resume, and comes back fresh
   * under a new id (the host session hears it through setProviderSessionId).
   */
  async #restart(link: Link, reason: string): Promise<void> {
    if (this.#link !== link || this.#closing) return;
    if (!this.#hasTranscript) this.#sessionId = randomUUID();
    if (TRACE) traceLine(`${this.#traceId} restarting claude (${this.#hasTranscript ? "resume" : "fresh"}): ${reason}`);
    // The new process has none of the old one's queue.
    this.#pushed = [];
    this.#link = this.#connect(this.#hasTranscript);
    link.input.end();
    link.query.close();
    if (!this.#hasTranscript) this.#sink.setProviderSessionId(this.#sessionId);
    this.#sink.emit("provider.event", { name: "claude.restarted", data: { reason } });
    this.#completeTurn("interrupted");
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.#closing = true;
    this.#link.input.end();
    this.#link.query.close();
  }

  async #consume(link: Link): Promise<void> {
    try {
      for await (const message of link.query) {
        // A replaced process may still say a few things; none of them are this session's any more.
        if (this.#link !== link) return;
        this.#handle(message, link);
      }
      if (this.#link === link) this.#end(new Error("claude process exited"));
    } catch (err) {
      if (this.#link === link) this.#end(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #end(reason: Error): void {
    if (this.#dead) return;
    this.#dead = reason;
    if (this.#closing || !this.#turnId) return;
    this.#sink.emit("error", { code: "claude_exited", message: reason.message });
    this.#completeTurn("failed", reason.message);
  }

  #handle(message: SDKMessage, link: Link): void {
    link.markReady();
    if (TRACE) {
      traceSpawnReady(this.#traceId, message.type === "system" ? `system/${message.subtype}` : message.type);
      traceMark(this.#traceId, "sdkMsg");
    }
    // Claude working while no turn is open is on something no send() started: a message
    // sent during the last turn that came too late to fold in, or a turn Claude Code
    // began itself. It gets a turn of its own, closed by its result as usual.
    if (!this.#turnId && !this.#closing && this.#opensTurn(message)) this.#openTurn();
    this.#noteRead(message);
    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id === null) {
          this.#flushHeldError();
          this.#stream(message.event as unknown as StreamEvent);
        }
        break;
      case "assistant":
        // Sub-agent internals stay behind the Task tool item that started them.
        if (message.parent_tool_use_id !== null) break;
        // An API error (a login that could not be refreshed, an overload…) comes as an
        // assistant message with `error` set, right before the failed result. It is held
        // until that result, so a turn that is sent again never shows it (see #retryable).
        if (message.error) {
          this.#flushHeldError();
          this.#heldError = { messageId: message.message.id, blocks: message.message.content as Block[], code: message.error };
          break;
        }
        this.#flushHeldError();
        this.#assistant(message.message.id, message.message.content as Block[]);
        break;
      case "user":
        if (!("isReplay" in message && message.isReplay)) {
          this.#flushHeldError();
          this.#toolResults(message);
        }
        break;
      case "result":
        this.#result(message);
        break;
      case "system":
        if (message.subtype === "compact_boundary") this.#sink.emit("provider.event", { name: "claude.compacted", data: {} });
        break;
      case "rate_limit_event":
        this.#rateLimitInfo = message.rate_limit_info;
        break;
    }
  }

  #stream(event: StreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.#messageId = event.message.id;
        this.#blockIds.clear();
        this.#armed = true;
        if (TRACE) traceApiStart(this.#traceId);
        break;
      case "content_block_start": {
        const kind = event.content_block.type === "text" ? "message" : event.content_block.type === "thinking" ? "reasoning" : null;
        if (!kind || !this.#messageId) break;
        const id = `${this.#messageId}:${event.index}`;
        this.#blockIds.set(event.index, id);
        this.#pushStreamed(this.#messageId, kind, id);
        if (kind === "message") this.#start({ id, kind: "message", role: "assistant", text: "", status: "in_progress" });
        else {
          // Started now, not at the first delta: when thinking text is omitted, every
          // thinking_delta is empty, and the reader would see nothing until the answer.
          if (TRACE) traceMark(this.#traceId, "thinkStart");
          this.#start({ id, kind: "reasoning", text: "", status: "in_progress" });
        }
        break;
      }
      case "content_block_delta": {
        const id = this.#blockIds.get(event.index);
        if (!id) break;
        if (event.delta.type === "text_delta" && event.delta.text) {
          if (TRACE) traceText(this.#traceId, id);
          this.#delta(id, event.delta.text);
        }
        if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          if (TRACE) traceMark(this.#traceId, "thinking");
          if (!this.#items.has(id)) this.#start({ id, kind: "reasoning", text: "", status: "in_progress" });
          this.#delta(id, event.delta.thinking);
        }
        break;
      }
    }
  }

  #assistant(messageId: string, blocks: Block[]): void {
    this.#armed = true;
    for (const block of blocks) {
      if (block.type === "text") {
        const { text } = block as TextBlock;
        const id = this.#takeStreamed(messageId, "message") ?? `${messageId}:${randomUUID()}`;
        this.#complete({ id, kind: "message", role: "assistant", text, status: "completed" });
      } else if (block.type === "thinking") {
        const { thinking } = block as ThinkingBlock;
        const id = this.#takeStreamed(messageId, "reasoning");
        if (id && this.#items.has(id)) this.#complete({ id, kind: "reasoning", text: thinking, status: "completed" });
        else if (thinking) this.#complete({ id: id ?? `${messageId}:${randomUUID()}`, kind: "reasoning", text: thinking, status: "completed" });
      } else if (block.type === "tool_use") {
        const { id, name, input } = block as ToolUseBlock;
        if (TRACE) traceTool(this.#traceId, id, "seen", name);
        this.#start(mapToolUse(id, name, input, this.#cwd));
      }
    }
  }

  #toolResults(message: Extract<SDKMessage, { type: "user" }>): void {
    const { content } = message.message;
    if (!Array.isArray(content)) return;
    const results = (content as Block[]).filter((b): b is ToolResultBlock => b.type === "tool_result");
    const structured = results.length === 1 && "tool_use_result" in message ? message.tool_use_result : undefined;
    for (const result of results) {
      if (TRACE) traceTool(this.#traceId, result.tool_use_id, "result");
      const item = this.#items.get(result.tool_use_id);
      if (!item) continue;
      // While a Stop is in progress an error result is the tool being cut short.
      this.#complete(completeToolItem(item, result, structured, this.#declined.has(result.tool_use_id), this.#interrupting));
    }
  }

  /**
   * Whether a failed turn was lost to the login-refresh race and should be sent again
   * rather than shown as failed.
   *
   * Claude Code shares one OAuth token between all its processes on the machine. After a
   * long idle the token has expired, the next process to call the API refreshes it, and
   * only one may refresh at a time: a process that finds the lock taken (another one is
   * refreshing, or died mid-refresh) ends its turn with this error instead of waiting.
   * It hits the first message after a long break or a host restart; once the token is
   * fresh every session works.
   *
   * Only when nothing of the turn reached the API, so sending it again repeats nothing but
   * the message; not during a Stop or with steered messages waiting; at most
   * authRetryDelaysMs.length times. Claude's transcript keeps each try's user message.
   */
  #retryable(errorText: string): boolean {
    const held = this.#heldError ? this.#heldError.blocks.map((b) => (b.type === "text" ? (b as TextBlock).text : "")).join("") : "";
    return (
      this.#turnText !== null &&
      !this.#armed &&
      this.#items.size === 0 &&
      this.#steered.size === 0 &&
      !this.#interrupting &&
      !this.#closing &&
      this.#retries < this.#authRetryDelays.length &&
      (AUTH_REFRESH_RACE.test(errorText) || AUTH_REFRESH_RACE.test(held))
    );
  }

  /** Sends the turn's message again after a wait. The turn stays open meanwhile: to the reader it is one slow start. */
  #retry(): void {
    const delay = this.#authRetryDelays[this.#retries] ?? 0;
    this.#retries++;
    this.#heldError = null;
    const turnId = this.#turnId;
    const text = this.#turnText;
    const link = this.#link;
    if (TRACE) traceLine(`${this.#traceId} login refresh race: sending the message again in ${delay}ms (try ${this.#retries + 1})`);
    this.#sink.emit("provider.event", { name: "claude.retry", data: { reason: "oauth_refresh", attempt: this.#retries, delayMs: delay } });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#turnId !== turnId || this.#link !== link || this.#interrupting || this.#closing || this.#dead) return;
      // A message steered in meanwhile is already queued in Claude Code and carries the turn on.
      if (this.#steered.size > 0 || text === null) return;
      this.#push(link, text);
    }, delay);
  }

  /** Shows a held API error after all: the turn went on, or it failed for good. */
  #flushHeldError(): void {
    const held = this.#heldError;
    if (!held) return;
    this.#heldError = null;
    this.#assistant(held.messageId, held.blocks);
  }

  #result(message: SDKResultMessage): void {
    if (!this.#turnId) return;
    if (TRACE) traceMark(this.#traceId, "result");
    const failed = message.subtype !== "success" || message.is_error;
    const errorText = message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype;
    if (failed && this.#retryable(errorText)) {
      // The failed try cost nothing, but the running total moves on with it.
      this.#costSoFar = message.total_cost_usd;
      this.#hasTranscript = true;
      this.#retry();
      return;
    }
    const heldCode = this.#heldError?.code;
    this.#flushHeldError();
    const status = this.#interrupting ? "interrupted" : failed ? "failed" : "completed";
    const error = status !== "failed" ? undefined : errorText;
    const { usage } = message;
    const turnUsage: Usage = {
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      // total_cost_usd is cumulative for the session.
      costUsd: Math.max(0, message.total_cost_usd - this.#costSoFar),
    };
    this.#costSoFar = message.total_cost_usd;
    this.#hasTranscript = true;
    // Only a genuine usage-limit hit spends the budget #maybeRetryLimit checks below; any
    // other outcome — success, a Stop, or a failure of some unrelated kind — means whatever
    // limit incident that budget belonged to is over, so the next one starts with a fresh
    // MAX_LIMIT_RETRIES rather than carrying a stale count in from one an unrelated failure
    // in between never got the chance to reset.
    const limitHit = status === "failed" && error !== undefined && isUsageLimitError(error, heldCode);
    if (!limitHit) this.#limitRetries = 0;
    this.#completeTurn(status, error, turnUsage);
    if (limitHit) this.#maybeRetryLimit(error, heldCode);
  }

  /**
   * A turn that failed on a genuine usage-limit hit resends itself automatically
   * once the limit's own reset has had a minute to land (see rate-limit.ts) — the
   * SDK has no such behaviour on its own; the host supplies it (Bert, 2026-09-18).
   * Silently skipped if there is nothing to resend (a turn Claude began itself,
   * #turnText null), this run's retry budget is spent (MAX_LIMIT_RETRIES), the
   * failure was not actually the usage limit, or neither the SDK's own
   * rate_limit_event nor the CLI's reset sentence gives a time to wait for.
   */
  #maybeRetryLimit(errorText: string, heldCode: SDKAssistantMessageError | undefined): void {
    if (this.#turnText === null) return;
    if (this.#limitRetries >= MAX_LIMIT_RETRIES) return;
    if (!isUsageLimitError(errorText, heldCode)) return;
    const retryAt = resolveRetryAt({
      rateLimitInfo: this.#rateLimitInfo,
      errorText,
      now: Date.now(),
      afterResetMs: this.#limitRetryAfterReset,
    });
    if (retryAt === null) return;
    this.#limitRetries++;
    const delayMs = Math.max(retryAt - Date.now(), 0);
    if (TRACE) traceLine(`${this.#traceId} usage limit hit: auto-retry #${this.#limitRetries} in ${delayMs}ms`);
    this.#sink.retryLater(delayMs, { text: this.#turnText }, { reason: errorText, retryAt });
  }

  #completeTurn(status: "completed" | "interrupted" | "failed", error?: string, usage?: Usage): void {
    const turnId = this.#turnId;
    if (!turnId) return;
    // A resend still waiting is off: the turn ended some other way (a Stop, a restart, an exit).
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#heldError = null;
    for (const item of this.#items.values()) {
      this.#sink.emit("item.completed", { turnId, item: { ...item, status: status === "completed" ? "completed" : "interrupted" } });
    }
    this.#items.clear();
    this.#streamed.clear();
    this.#blockIds.clear();
    this.#declined.clear();
    this.#turnId = null;
    this.#interrupting = false;
    // A Stop (cancelQueued) took the unread ones with it; the host says so.
    if (status === "interrupted") this.#steered.clear();
    this.#sink.emit("turn.completed", { turnId, status, ...(usage ? { usage } : {}), ...(error ? { error } : {}) });
    for (const resolve of this.#turnWaiters.splice(0)) resolve();
  }

  #start(item: Item): void {
    this.#items.set(item.id, item);
    this.#sink.emit("item.started", { turnId: this.#turnId, item });
  }

  #complete(item: Item): void {
    this.#items.delete(item.id);
    this.#sink.emit("item.completed", { turnId: this.#turnId, item });
  }

  #delta(itemId: string, delta: string): void {
    const item = this.#items.get(itemId);
    if (!item) return;
    this.#items.set(itemId, applyDelta(item, "text", delta));
    if (TRACE) traceDeltaIn(this.#traceId);
    this.#sink.emit("item.delta", { itemId, field: "text", delta });
  }

  #pushStreamed(messageId: string, kind: string, id: string): void {
    const key = `${messageId}:${kind}`;
    const ids = this.#streamed.get(key) ?? [];
    ids.push(id);
    this.#streamed.set(key, ids);
  }

  #takeStreamed(messageId: string, kind: string): string | undefined {
    return this.#streamed.get(`${messageId}:${kind}`)?.shift();
  }

  async #canUseTool(tool: string, input: Record<string, unknown>, options: ToolOptions): Promise<PermissionResult> {
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    this.#requests.add(abort);
    if (TRACE) traceTool(this.#traceId, options.toolUseID, "ask", tool);
    try {
      if (tool === "AskUserQuestion") return await this.#askQuestions(input, abort.signal);
      if (tool === "ExitPlanMode") return await this.#approvePlan(input, abort.signal);
      return await this.#approveTool(tool, input, options, abort.signal);
    } catch {
      return { behavior: "deny", message: "The request was cancelled.", interrupt: true };
    } finally {
      if (TRACE) traceTool(this.#traceId, options.toolUseID, "answer");
      this.#requests.delete(abort);
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  async #approveTool(tool: string, input: Record<string, unknown>, options: ToolOptions, signal: AbortSignal): Promise<PermissionResult> {
    // The tool_use item was mapped already; its kind says whether this is a shell command or a file edit.
    const item = this.#items.get(options.toolUseID) ?? mapToolUse(options.toolUseID, tool, input, this.#cwd);
    const command = item.kind === "command" ? item.command : undefined;
    const changes = item.kind === "file_change" ? item.changes : undefined;
    const kind = command !== undefined ? "command_approval" : changes ? "file_approval" : "tool_approval";
    const offerSession = (options.suggestions?.length ?? 0) > 0 && !options.suppressAlwaysAllowRule;
    const decisions: Decision[] = [
      { id: "allow", label: "Allow", effect: "allow" },
      ...(offerSession ? [{ id: "allow_session", label: "Allow for this session", effect: "allow_session" } as const] : []),
      { id: "deny", label: "Deny", effect: "deny" },
      { id: "stop", label: "Deny and stop", effect: "cancel" },
    ];
    const body = options.decisionReason ?? options.description;
    const request: Omit<InputRequest, "requestId"> = {
      kind,
      itemId: options.toolUseID,
      title: options.title ?? (command !== undefined ? "Run command?" : `Allow ${options.displayName ?? tool}?`),
      ...(body ? { body } : {}),
      ...(command !== undefined ? { command, cwd: this.#cwd } : {}),
      ...(changes ? { changes } : {}),
      ...(kind === "tool_approval" ? { toolName: tool, toolInput: input } : {}),
      decisions,
    };
    const answer = await this.#sink.requestInput(request, signal);
    if (answer.effect === "allow") return { behavior: "allow", updatedInput: input };
    if (answer.effect === "allow_session") {
      return { behavior: "allow", updatedInput: input, updatedPermissions: options.suggestions ?? [] };
    }
    this.#declined.add(options.toolUseID);
    return {
      behavior: "deny",
      message: "The user denied this action.",
      ...(answer.effect === "cancel" ? { interrupt: true } : {}),
    };
  }

  async #askQuestions(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : [];
    const answer = await this.#sink.requestInput(
      {
        kind: "question",
        title: questions.length === 1 && questions[0] ? questions[0].question : "Claude has some questions",
        questions: questions.map((q, i) => ({
          id: String(i),
          question: q.question,
          options: q.options.map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
          multiSelect: q.multiSelect === true,
        })),
        decisions: [
          { id: "submit", label: "Submit", effect: "allow" },
          { id: "skip", label: "Skip", effect: "deny" },
        ],
      },
      signal,
    );
    if (answer.effect !== "allow") return { behavior: "deny", message: "The user skipped the question." };
    // Claude expects answers keyed by question text; multi-select answers are comma-separated.
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const value = answer.answers?.[String(i)];
      if (value) answers[q.question] = value;
    });
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  async #approvePlan(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const plan = typeof input.plan === "string" ? input.plan : undefined;
    const answer = await this.#sink.requestInput(
      {
        kind: "plan_approval",
        title: "Approve the plan?",
        ...(plan ? { body: plan } : {}),
        decisions: [
          { id: "approve", label: "Approve", effect: "allow" },
          { id: "keep_planning", label: "Keep planning", effect: "deny" },
        ],
      },
      signal,
    );
    return answer.effect === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user wants to keep planning." };
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** Resolves true when `p` settles within `ms`, false otherwise; the timer never outlives it. */
function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}
