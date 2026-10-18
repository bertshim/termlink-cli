import { setTimeout as sleep } from "node:timers/promises";
import { applyDelta, type DeltaField, type InputRequest, type Item, type Usage } from "@termlink/protocol";
import { HostError } from "../../errors.js";
import type { EventSink, InputResponse, ProviderSession, UserInput } from "../types.js";
import { stripSteerNote, withSteerNote } from "../steer-note.js";
import type { CodexAppServer, ThreadHandler } from "./app-server.js";
import { userText } from "./history.js";
import { APPROVAL_DECISIONS, mapFileChange, mapItem } from "./mapper.js";
import type {
  ApprovalDecision,
  CommandExecutionRequestApprovalParams,
  DeltaNotification,
  ErrorNotification,
  FileChangePatchUpdatedNotification,
  FileChangeRequestApprovalParams,
  ItemNotification,
  ReasoningSummaryPartAddedNotification,
  RequestId,
  ServerRequestResolvedNotification,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
  AccountRateLimitsUpdatedNotification,
  RateLimitSnapshot,
  RateLimitWindow,
  TokenUsageBreakdown,
  Turn,
  TurnNotification,
  TurnPlanUpdatedNotification,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./protocol.js";
import { isUsageLimitError, MAX_LIMIT_RETRIES, RETRY_AFTER_RESET_MS, resolveRetryAt, type LimitWindows } from "./rate-limit.js";
import { NO_RESPONSE, RpcError } from "./rpc.js";

const INTERRUPT_TIMEOUT_MS = 10_000;

export interface CodexSessionOptions {
  /** How long past the limit's own reset to resend; RETRY_AFTER_RESET_MS unless a test shortens it. */
  limitRetryAfterResetMs?: number | undefined;
}

/** One Codex thread, driven through the shared app-server. */
export class CodexThreadSession implements ProviderSession, ThreadHandler {
  readonly threadId: string;
  readonly #server: CodexAppServer;
  readonly #sink: EventSink;
  /** Mapped items still in progress, kept current with deltas. */
  readonly #items = new Map<string, Item>();
  /** Pending approvals by JSON-RPC id. Abort reason "resolved" means Codex withdrew it. */
  readonly #requests = new Map<string, AbortController>();
  readonly #finishedTurns = new Set<string>();
  /** Messages steered into the turn that Codex has not reported back yet. */
  #steered: { itemId: string; text: string }[] = [];
  #turnId: string | null = null;
  #turnWaiters: (() => void)[] = [];
  #totals: TokenUsageBreakdown | null = null;
  #totalsAtTurnStart: TokenUsageBreakdown | null = null;
  #closed = false;
  /**
   * The message the running turn was started with, kept so a turn that fails on the plan's
   * usage limit can be sent again (see #maybeRetryLimit). Null for a turn the host did not
   * start with a message of its own — a compaction, or one Codex began itself.
   */
  #turnText: string | null = null;
  /** The plan's usage windows as last reported; what #maybeRetryLimit reads the reset from. */
  #limits: LimitWindows = {};
  /** How many turns in the current run of usage-limit hits have been resent; see MAX_LIMIT_RETRIES. */
  #limitRetries = 0;
  readonly #limitRetryAfterReset: number;

  constructor(server: CodexAppServer, threadId: string, sink: EventSink, options: CodexSessionOptions = {}) {
    this.#server = server;
    this.threadId = threadId;
    this.#sink = sink;
    this.#limitRetryAfterReset = options.limitRetryAfterResetMs ?? RETRY_AFTER_RESET_MS;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#closed) throw new HostError("conflict", "codex session is closed");
    if (this.#turnId) throw new HostError("conflict", "a turn is already running");
    const params: TurnStartParams = {
      threadId: this.threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
    };
    this.#turnText = input.text;
    try {
      const { turn } = await this.#server.peer.request<TurnStartResponse>("turn/start", params);
      this.#beginTurn(turn.id);
    } catch (err) {
      // No turn began, so nothing for a later one to be mistaken for a resend of.
      if (!this.#turnId) this.#turnText = null;
      throw err;
    }
  }

  /**
   * Adds the message to the running turn (turn/steer); Codex reads it at its next step
   * and reports it then as a userMessage item of the turn — which is how the host
   * learns it was read (#userMessage).
   */
  async steer(input: UserInput, itemId: string): Promise<void> {
    if (this.#closed) throw new HostError("conflict", "codex session is closed");
    const turnId = this.#turnId;
    if (!turnId) return this.send(input);
    const text = withSteerNote(input.text);
    this.#steered.push({ itemId, text });
    const params: TurnSteerParams = {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      expectedTurnId: turnId,
    };
    try {
      await this.#server.peer.request<TurnSteerResponse>("turn/steer", params);
    } catch (err) {
      this.#steered = this.#steered.filter((s) => s.itemId !== itemId);
      // The turn ended while the message was on its way: it opens the next one instead.
      if (err instanceof RpcError && this.#turnId !== turnId) return this.send(input);
      throw err;
    }
  }

  /** Codex's own item for a message steered in, matched by text: the agent has it now. */
  #userMessage(item: ThreadItem): void {
    if (item.type !== "userMessage" || this.#steered.length === 0) return;
    const text = userText(item);
    const i = this.#steered.findIndex((s) => stripSteerNote(s.text) === text || s.text === text);
    if (i < 0) return;
    const [read] = this.#steered.splice(i, 1);
    if (read) this.#sink.messageRead(read.itemId);
  }

  /**
   * Summarise the thread and carry on from the summary — Codex's own
   * thread/compact/start, not a "/compact" typed at it. Over the app-server
   * protocol that string is ordinary text: Codex reads it, decides it is being
   * asked about a terminal command, and answers in prose.
   *
   * The compaction runs as a turn of its own and reports through the same
   * notifications any turn does, so there is nothing to wait for here beyond
   * Codex accepting it.
   */
  async compact(): Promise<void> {
    if (this.#closed) throw new HostError("conflict", "codex session is closed");
    // Not a message to resend if it hits the limit.
    this.#turnText = null;
    await this.#server.peer.request("thread/compact/start", { threadId: this.threadId });
  }

  async interrupt(): Promise<void> {
    const turnId = this.#turnId;
    if (!turnId) return;
    this.#withdrawRequests("interrupt");
    const done = new Promise<void>((resolve) => this.#turnWaiters.push(resolve));
    await this.#server.peer.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => {});
    await Promise.race([done, sleep(INTERRUPT_TIMEOUT_MS)]);
    if (this.#turnId === turnId) this.#completeTurn({ id: turnId, status: "interrupted", error: null });
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.#closed = true;
    this.#server.unregister(this.threadId);
    if (!this.#server.peer.closed) {
      await this.#server.peer.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
    }
  }

  notification(method: string, params: unknown): void {
    switch (method) {
      case "turn/started":
        this.#beginTurn((params as TurnNotification).turn.id);
        break;
      case "turn/completed":
        this.#completeTurn((params as TurnNotification).turn);
        break;
      case "item/started": {
        const { turnId, item } = params as ItemNotification;
        this.#beginTurn(turnId);
        this.#userMessage(item);
        const mapped = mapItem(item, "started");
        if (!mapped) break;
        this.#items.set(mapped.id, mapped);
        this.#sink.emit("item.started", { turnId, item: mapped });
        break;
      }
      case "item/completed": {
        const { turnId, item } = params as ItemNotification;
        this.#userMessage(item);
        const mapped = mapItem(item, "completed");
        if (!mapped) break;
        this.#items.delete(mapped.id);
        this.#sink.emit("item.completed", { turnId, item: mapped });
        break;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta } = params as DeltaNotification;
        this.#delta(itemId, "text", delta);
        break;
      }
      case "item/reasoning/summaryPartAdded": {
        const { itemId, summaryIndex } = params as ReasoningSummaryPartAddedNotification;
        if (summaryIndex > 0) this.#delta(itemId, "text", "\n\n");
        break;
      }
      case "item/commandExecution/outputDelta": {
        const { itemId, delta } = params as DeltaNotification;
        this.#delta(itemId, "output", delta);
        break;
      }
      case "item/fileChange/patchUpdated": {
        const { itemId, changes } = params as FileChangePatchUpdatedNotification;
        const item = this.#items.get(itemId);
        if (item?.kind !== "file_change") break;
        const updated: Item = { ...item, changes: changes.map(mapFileChange) };
        this.#items.set(itemId, updated);
        this.#sink.emit("item.updated", { item: updated });
        break;
      }
      case "turn/plan/updated":
        this.#updatePlan(params as TurnPlanUpdatedNotification);
        break;
      case "thread/tokenUsage/updated":
        this.#totals = (params as ThreadTokenUsageUpdatedNotification).tokenUsage.total;
        break;
      case "account/rateLimits/updated":
        this.applyRateLimits((params as AccountRateLimitsUpdatedNotification).rateLimits);
        break;
      case "error": {
        const { error, willRetry } = params as ErrorNotification;
        if (willRetry) this.#sink.emit("provider.event", { name: "codex.retrying", data: { message: error.message } });
        else this.#sink.emit("error", { code: "codex", message: error.message });
        break;
      }
      case "serverRequest/resolved": {
        const { requestId } = params as ServerRequestResolvedNotification;
        this.#requests.get(String(requestId))?.abort("resolved");
        break;
      }
    }
  }

  /**
   * An account-level notification, which names no thread and so reaches every
   * thread on this connection (CodexAppServer). Only the rate limits matter
   * here; the rest of the account surface is the CLI's own business.
   */
  accountNotification(method: string, params: unknown): void {
    if (method !== "account/rateLimits/updated") return;
    this.applyRateLimits((params as AccountRateLimitsUpdatedNotification).rateLimits);
  }

  /**
   * Hand a snapshot of the plan's usage to the host session.
   *
   * Also the way the first one arrives: the provider reads it once with
   * `account/rateLimits/read` when the thread opens, because the pushes only
   * start when something moves and a session opened mid-window would
   * otherwise show nothing until the next turn.
   *
   * Codex reports `resetsAt` in SECONDS; this protocol is milliseconds
   * throughout, so it is converted here rather than left for each client to
   * discover the hard way.
   */
  applyRateLimits(snapshot: RateLimitSnapshot | null | undefined): void {
    if (!snapshot) return;
    const window = (w: RateLimitWindow | null | undefined) =>
      w === undefined
        ? undefined
        : w === null
          ? null
          : {
              usedPercent: w.usedPercent,
              resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
              windowMinutes: w.windowDurationMins ?? null,
            };
    const primary = window(snapshot.primary);
    const secondary = window(snapshot.secondary);
    // Merged the same sparse way the session merges them: a window left out of an
    // update has not gone away.
    this.#limits = {
      ...this.#limits,
      ...(primary !== undefined ? { primary } : {}),
      ...(secondary !== undefined ? { secondary } : {}),
    };
    this.#sink.setLimits({
      ...(primary !== undefined ? { primary } : {}),
      ...(secondary !== undefined ? { secondary } : {}),
      ...(snapshot.planType !== undefined ? { plan: snapshot.planType } : {}),
    });
  }

  async request(method: string, params: unknown, id: RequestId): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const p = params as CommandExecutionRequestApprovalParams;
        const item = this.#items.get(p.itemId);
        const command = p.command ?? (item?.kind === "command" ? item.command : undefined);
        return this.#approve(id, {
          kind: "command_approval",
          itemId: p.itemId,
          title: p.kind === "writeStdin" ? "Send input to a running command?" : "Run command?",
          ...(p.reason ? { body: p.reason } : {}),
          ...(command ? { command } : {}),
          ...(p.cwd ? { cwd: p.cwd } : {}),
          decisions: APPROVAL_DECISIONS,
        });
      }
      case "item/fileChange/requestApproval": {
        const p = params as FileChangeRequestApprovalParams;
        const item = this.#items.get(p.itemId);
        return this.#approve(id, {
          kind: "file_approval",
          itemId: p.itemId,
          title: p.grantRoot ? `Allow writes under ${p.grantRoot}?` : "Apply file changes?",
          ...(p.reason ? { body: p.reason } : {}),
          ...(item?.kind === "file_change" ? { changes: item.changes } : {}),
          decisions: APPROVAL_DECISIONS,
        });
      }
      default:
        this.#sink.emit("provider.event", { name: "codex.unsupported_request", data: { method } });
        throw new RpcError(-32601, `${method} is not supported by the TermLink host`);
    }
  }

  closed(reason: Error): void {
    this.#closed = true;
    this.#withdrawRequests("resolved");
    if (this.#turnId) {
      this.#sink.emit("error", { code: "codex_exited", message: reason.message });
      this.#completeTurn({ id: this.#turnId, status: "failed", error: { message: reason.message } });
    }
  }

  async #approve(id: RequestId, request: Omit<InputRequest, "requestId">): Promise<unknown> {
    const abort = new AbortController();
    this.#requests.set(String(id), abort);
    let response: InputResponse;
    try {
      response = await this.#sink.requestInput(request, abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      if (abort.signal.reason === "resolved") return NO_RESPONSE;
      response = { decisionId: null, effect: "cancel" };
    } finally {
      this.#requests.delete(String(id));
    }
    const decision = (response.decisionId ?? "cancel") as ApprovalDecision;
    return { decision };
  }

  #withdrawRequests(reason: "resolved" | "interrupt"): void {
    for (const abort of this.#requests.values()) abort.abort(reason);
  }

  #beginTurn(turnId: string): void {
    if (this.#turnId === turnId || this.#finishedTurns.has(turnId)) return;
    this.#turnId = turnId;
    this.#totalsAtTurnStart = this.#totals;
    this.#sink.emit("turn.started", { turnId });
  }

  #completeTurn(turn: Turn): void {
    if (this.#finishedTurns.has(turn.id)) return;
    if (this.#turnId !== turn.id) this.#beginTurn(turn.id);
    for (const item of this.#items.values()) {
      const status = item.kind === "todo" || turn.status === "completed" ? "completed" : "interrupted";
      this.#sink.emit("item.completed", { turnId: turn.id, item: { ...item, status } });
    }
    this.#items.clear();
    this.#finishedTurns.add(turn.id);
    this.#turnId = null;
    // Steered before the turn ended and never reported back: Codex took it with the
    // turn (read), unless the turn was stopped (the host marks those dropped).
    if (turn.status === "completed") for (const s of this.#steered) this.#sink.messageRead(s.itemId);
    this.#steered = [];

    const usage = this.#turnUsage();
    const status = turn.status === "inProgress" ? "failed" : turn.status;
    const text = this.#turnText;
    this.#turnText = null;
    // Only a genuine usage-limit hit spends the budget #maybeRetryLimit checks; any other
    // outcome — a success, a Stop, an unrelated failure — means the limit incident that
    // budget belonged to is over, so the next one starts with a fresh MAX_LIMIT_RETRIES.
    const limitHit = status === "failed" && !!turn.error && isUsageLimitError(turn.error.message);
    if (!limitHit) this.#limitRetries = 0;
    this.#sink.emit("turn.completed", {
      turnId: turn.id,
      status,
      ...(usage ? { usage } : {}),
      ...(turn.error ? { error: turn.error.message } : {}),
    });
    for (const resolve of this.#turnWaiters.splice(0)) resolve();
    if (limitHit && turn.error) this.#maybeRetryLimit(turn.error.message, text);
  }

  /**
   * A turn that failed on the plan's usage limit is sent again by itself once the limit's
   * own reset has had a minute to land — over the app-server protocol Codex has no such
   * wait of its own (the interactive CLI's is not part of it), so the host supplies it,
   * the same as for Claude. Skipped when there is nothing to resend (a compaction, or a
   * turn Codex began itself), this run's budget is spent (MAX_LIMIT_RETRIES), or neither
   * the plan's reported windows nor the error's own "try again at" gives a time to wait
   * for. Done after the turn is announced as ended, so the wait shows as `rate_limited`
   * on top of an idle session rather than in the middle of a running one.
   */
  #maybeRetryLimit(errorText: string, text: string | null): void {
    if (text === null) return;
    if (this.#limitRetries >= MAX_LIMIT_RETRIES) return;
    const now = Date.now();
    const retryAt = resolveRetryAt({ limits: this.#limits, errorText, now, afterResetMs: this.#limitRetryAfterReset });
    if (retryAt === null) return;
    this.#limitRetries++;
    this.#sink.retryLater(Math.max(retryAt - now, 0), { text }, { reason: errorText, retryAt });
  }

  #turnUsage(): Usage | undefined {
    const now = this.#totals;
    if (!now) return undefined;
    const before = this.#totalsAtTurnStart;
    return {
      inputTokens: now.inputTokens - (before?.inputTokens ?? 0),
      outputTokens: now.outputTokens - (before?.outputTokens ?? 0),
    };
  }

  #delta(itemId: string, field: DeltaField, delta: string): void {
    const item = this.#items.get(itemId);
    if (!item) return;
    this.#items.set(itemId, applyDelta(item, field, delta));
    this.#sink.emit("item.delta", { itemId, field, delta });
  }

  // Codex reports the plan per turn rather than as an item; the host shows it as one todo item.
  #updatePlan({ turnId, plan }: TurnPlanUpdatedNotification): void {
    const id = `plan_${turnId}`;
    const item: Item = {
      id,
      kind: "todo",
      entries: plan.map((step) => ({ text: step.step, done: step.status === "completed" })),
      status: "in_progress",
    };
    const known = this.#items.has(id);
    this.#items.set(id, item);
    if (known) this.#sink.emit("item.updated", { item });
    else this.#sink.emit("item.started", { turnId, item });
  }
}
