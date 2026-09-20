import { setTimeout as sleep } from "node:timers/promises";
import { applyDelta, type Item, type ItemStatus } from "@termlink/protocol";
import { errorMessage, HostError } from "../../errors.js";
import type { EventSink, InputResponse, ProviderSession, UserInput } from "../types.js";
import type { AcpSessionHandler, CopilotAcpServer } from "./acp-server.js";
import { approvalBody, blockText, commandOf, isCommandKind, isEditKind, mapDecisions, mapToolCallStart, mapToolCallUpdate, mapUsage } from "./mapper.js";
import type {
  PlanUpdate,
  RequestId,
  RequestPermissionParams,
  RequestPermissionResponse,
  SessionCancelParams,
  SessionPromptParams,
  SessionPromptResponse,
  SessionUpdateNotification,
  TokenUsage,
  ToolCallProgressUpdate,
  ToolCallStartUpdate,
} from "./protocol.js";
import { RpcError } from "../rpc.js";

const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * One Copilot ACP session, driven through the shared `copilot --acp` process — structurally
 * the same as CursorAcpSession, since both drive an Agent Client Protocol server, but kept
 * as its own class rather than shared with Cursor's (the same reason Claude's and Codex's
 * own session.ts are not shared despite both being "an agent"): two agents that both speak
 * a generic protocol still answer it with their own quirks, and this file's own header note
 * on `stopReason` is exactly one of those — reusing the base module wrongly would mean
 * fixing a Copilot-only bug in a shared file two providers trust.
 *
 * Measured, load-bearing difference from Cursor: cancelling a turn resolves session/prompt
 * with `stopReason: "end_turn"` here, never `"cancelled"` (protocol.ts's own note). So this
 * class never trusts stopReason to say whether a turn was interrupted — it tracks its own
 * interrupt() call instead and treats a turn as interrupted purely because interrupt() was
 * the thing waiting on it, which is right regardless of what the CLI's own answer claims.
 */
export class CopilotAcpSession implements ProviderSession, AcpSessionHandler {
  readonly sessionId: string;
  readonly #server: CopilotAcpServer;
  readonly #sink: EventSink;
  readonly #cwd: string;
  /** Tool-call items (and the one synthetic "plan" item) still in progress, by their id. */
  readonly #items = new Map<string, Item>();
  /** Pending session/request_permission calls, by their JSON-RPC id. */
  readonly #requests = new Map<string, AbortController>();
  #openMessageId: string | null = null;
  #openThoughtId: string | null = null;
  #itemCount = 0;
  #turnId: string | null = null;
  #turnCount = 0;
  /** Set the moment interrupt() is called for the turn currently running, cleared once that
   *  turn is finished either way — see the class's own note on why stopReason is not enough. */
  #interruptedTurnId: string | null = null;
  #turnWaiters: (() => void)[] = [];
  #closed = false;
  #replaying: boolean;
  /**
   * Turn ids whose session/prompt request interrupt() gave up waiting on (10s,
   * INTERRUPT_TIMEOUT_MS) without it actually resolving — the request itself is still
   * outstanding on the wire, copilot has not necessarily stopped, and it can still send
   * session/update notifications for that abandoned turn. Unlike Claude's own process
   * (session.ts's #gen/link.gen), ACP gives a notification no id to tell an abandoned
   * turn's stray frame apart from a genuinely new one once a fresh turn has replaced
   * #turnId — so while this is non-empty, notifications are dropped outright rather than
   * risk folding a straggler into whatever turn is open now. Cleared per-turn once that
   * turn's own request actually settles (send()'s own .then/.catch).
   */
  readonly #abandoned = new Set<string>();
  readonly #interruptTimeoutMs: number;

  constructor(
    server: CopilotAcpServer,
    sessionId: string,
    sink: EventSink,
    cwd: string,
    options: { replaying?: boolean; interruptTimeoutMs?: number } = {},
  ) {
    this.#server = server;
    this.sessionId = sessionId;
    this.#sink = sink;
    this.#cwd = cwd;
    this.#replaying = options.replaying ?? false;
    this.#interruptTimeoutMs = options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
  }

  /** Called once session/load's own response arrives: everything from here on is live. */
  endReplay(): void {
    this.#replaying = false;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closed) throw new HostError("conflict", "copilot session is closed");
    if (this.#turnId) throw new HostError("conflict", "a turn is already running");
    const turnId = `turn_${++this.#turnCount}`;
    this.#turnId = turnId;
    this.#sink.emit("turn.started", { turnId });
    const params: SessionPromptParams = {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: input.text }],
    };
    // Deliberately not awaited: session/prompt does not resolve until the turn ends, and
    // send() only promises the turn was accepted. The rest is reported through the sink.
    this.#server.peer.request<SessionPromptResponse>("session/prompt", params).then(
      (res) => {
        this.#abandoned.delete(turnId);
        this.#finishTurn(turnId, this.#interruptedTurnId === turnId ? "interrupted" : "completed", undefined, res.usage);
      },
      (err: unknown) => {
        this.#abandoned.delete(turnId);
        this.#finishTurn(turnId, "failed", errorMessage(err));
      },
    );
  }

  async interrupt(): Promise<void> {
    const turnId = this.#turnId;
    if (!turnId) return;
    this.#interruptedTurnId = turnId;
    this.#withdrawApprovals();
    const done = new Promise<void>((resolve) => this.#turnWaiters.push(resolve));
    this.#server.peer.notify("session/cancel", { sessionId: this.sessionId } satisfies SessionCancelParams);
    await Promise.race([done, sleep(this.#interruptTimeoutMs)]);
    if (this.#turnId === turnId) {
      // The request never came back in time: copilot may still be working on it and can
      // still emit session/update for it, so notifications stay suppressed until send()'s
      // own .then/.catch above hears the real end of it.
      this.#abandoned.add(turnId);
      this.#finishTurn(turnId, "interrupted");
    }
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.#closed = true;
    this.#server.unregister(this.sessionId);
  }

  notification(method: string, params: unknown): void {
    if (this.#replaying) return;
    // An abandoned turn's request may still be alive server-side; do not risk folding its
    // stray frames into whatever turn is open now (this.#abandoned's own doc comment).
    if (this.#abandoned.size > 0) return;
    if (method !== "session/update") return;
    const { update } = params as SessionUpdateNotification;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.#onTextChunk("message", blockText([update.content]));
        break;
      case "agent_thought_chunk":
        this.#onTextChunk("thought", blockText([update.content]));
        break;
      case "tool_call":
        this.#onToolCallStart(update);
        break;
      case "tool_call_update":
        this.#onToolCallUpdate(update);
        break;
      case "plan":
        this.#onPlan(update);
        break;
      default:
        // session_info_update, available_commands_update, current_mode_update,
        // usage_update, config_option_update: chrome this adapter has no timeline row for.
        // user_message_chunk only replays on session/load, which never reaches here live
        // (CopilotProvider is not resumable through the live channel — see provider.ts).
        break;
    }
  }

  async request(method: string, params: unknown, id: RequestId): Promise<unknown> {
    if (method === "session/request_permission") return this.#approve(id, params as RequestPermissionParams);
    this.#sink.emit("provider.event", { name: "copilot.unsupported_request", data: { method } });
    throw new RpcError(-32601, `${method} is not supported by the TermLink host`);
  }

  closed(reason: Error): void {
    this.#closed = true;
    this.#withdrawApprovals();
    if (this.#turnId) {
      this.#sink.emit("error", { code: "copilot_exited", message: reason.message });
      this.#finishTurn(this.#turnId, "failed", reason.message);
    }
  }

  /**
   * Three request kinds, not two — see cursor/session.ts's own #approve for the full
   * reasoning (measured identically against Copilot: edit gets file_approval, so
   * autoApprove "edits" answers it, instead of falling into tool_approval where it never
   * would).
   */
  async #approve(id: RequestId, params: RequestPermissionParams): Promise<unknown> {
    const tc = params.toolCall;
    const existing = this.#items.get(tc.toolCallId);
    const body = approvalBody(tc.content);
    const request = {
      kind: (isCommandKind(tc.kind) ? "command_approval" : isEditKind(tc.kind) ? "file_approval" : "tool_approval") as
        | "command_approval"
        | "file_approval"
        | "tool_approval",
      itemId: tc.toolCallId,
      title: tc.title,
      ...(body ? { body } : {}),
      ...(isCommandKind(tc.kind)
        ? { command: existing?.kind === "command" ? existing.command : commandOf(tc.rawInput, tc.title), cwd: this.#cwd }
        : isEditKind(tc.kind)
          ? { changes: existing?.kind === "file_change" ? existing.changes : [] }
          : { toolName: tc.kind, toolInput: tc.rawInput }),
      decisions: mapDecisions(params.options),
    };
    const abort = new AbortController();
    this.#requests.set(String(id), abort);
    let response: InputResponse;
    try {
      response = await this.#sink.requestInput(request, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      response = { decisionId: null, effect: "cancel" };
    } finally {
      this.#requests.delete(String(id));
    }
    const result: RequestPermissionResponse = response.decisionId
      ? { outcome: { outcome: "selected", optionId: response.decisionId } }
      : { outcome: { outcome: "cancelled" } };
    return result;
  }

  #withdrawApprovals(): void {
    for (const abort of this.#requests.values()) abort.abort("interrupt");
  }

  #openId(which: "message" | "thought"): string | null {
    return which === "message" ? this.#openMessageId : this.#openThoughtId;
  }

  #setOpenId(which: "message" | "thought", id: string | null): void {
    if (which === "message") this.#openMessageId = id;
    else this.#openThoughtId = id;
  }

  #onTextChunk(which: "message" | "thought", text: string): void {
    if (!text) return;
    const other = which === "message" ? "thought" : "message";
    if (this.#openId(other)) this.#closeText(other, "completed");
    let id = this.#openId(which);
    if (!id) {
      id = `${which === "message" ? "msg" : "think"}_${this.#turnId}_${++this.#itemCount}`;
      const item: Item =
        which === "message"
          ? { id, kind: "message", role: "assistant", text: "", status: "in_progress" }
          : { id, kind: "reasoning", text: "", status: "in_progress" };
      this.#items.set(id, item);
      this.#setOpenId(which, id);
      this.#sink.emit("item.started", { turnId: this.#turnId, item });
    }
    const item = this.#items.get(id);
    if (!item) return;
    this.#items.set(id, applyDelta(item, "text", text));
    this.#sink.emit("item.delta", { itemId: id, field: "text", delta: text });
  }

  #closeText(which: "message" | "thought", status: ItemStatus): void {
    const id = this.#openId(which);
    if (!id) return;
    const item = this.#items.get(id);
    if (item) {
      this.#items.delete(id);
      this.#sink.emit("item.completed", { turnId: this.#turnId, item: { ...item, status } });
    }
    this.#setOpenId(which, null);
  }

  #onToolCallStart(u: ToolCallStartUpdate): void {
    this.#closeText("message", "completed");
    this.#closeText("thought", "completed");
    const item = mapToolCallStart(u, this.#cwd);
    this.#items.set(u.toolCallId, item);
    this.#sink.emit("item.started", { turnId: this.#turnId, item });
  }

  #onToolCallUpdate(u: ToolCallProgressUpdate): void {
    const existing = this.#items.get(u.toolCallId);
    if (!existing) return;
    const updated = mapToolCallUpdate(existing, u, this.#cwd);
    const terminal = u.status === "completed" || u.status === "failed";
    if (terminal) {
      this.#items.delete(u.toolCallId);
      this.#sink.emit("item.completed", { turnId: this.#turnId, item: updated });
    } else {
      this.#items.set(u.toolCallId, updated);
      this.#sink.emit("item.updated", { item: updated });
    }
  }

  #onPlan(u: PlanUpdate): void {
    const id = `plan_${this.#turnId}`;
    const item: Item = {
      id,
      kind: "todo",
      entries: u.entries.map((e) => ({ text: e.content, done: e.status === "completed" })),
      status: "in_progress",
    };
    const known = this.#items.has(id);
    this.#items.set(id, item);
    if (known) this.#sink.emit("item.updated", { item });
    else this.#sink.emit("item.started", { turnId: this.#turnId, item });
  }

  #finishTurn(turnId: string, status: "completed" | "interrupted" | "failed", error?: string, usage?: TokenUsage): void {
    if (this.#turnId !== turnId) return;
    if (this.#interruptedTurnId === turnId) this.#interruptedTurnId = null;
    const itemStatus: ItemStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted";
    this.#closeText("message", itemStatus);
    this.#closeText("thought", itemStatus);
    for (const item of this.#items.values()) {
      this.#sink.emit("item.completed", { turnId, item: { ...item, status: itemStatus } });
    }
    this.#items.clear();
    this.#turnId = null;
    const mappedUsage = mapUsage(usage);
    this.#sink.emit("turn.completed", { turnId, status, ...(mappedUsage ? { usage: mappedUsage } : {}), ...(error ? { error } : {}) });
    for (const resolve of this.#turnWaiters.splice(0)) resolve();
  }
}
