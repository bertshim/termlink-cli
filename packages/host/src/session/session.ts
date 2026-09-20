import {
  PROTOCOL_VERSION,
  applyDelta,
  isDurableEvent,
  type AgentEvent,
  type AutoApprove,
  type Decision,
  type EventPayload,
  type EventType,
  type InputKind,
  type InputRequest,
  type Item,
  type SessionInfo,
  type SessionStatus,
} from "@termlink/protocol";
import { HostError, errorMessage } from "../errors.js";
import type { EventSink, HistoryTurn, InputResponse, ProviderSession, UserInput } from "../providers/types.js";
import { newId } from "../util/id.js";
import { TRACE, traceMark, traceTurnEnd } from "../util/trace.js";
import { EventLog } from "./event-log.js";

export type Listener = (event: AgentEvent) => void;

export interface Attachment {
  /** Deliver right after the attach response: missed durable events, then catch-up snapshots. */
  replay: AgentEvent[];
  gap: boolean;
  oldestSeq: number;
  detach: () => void;
}

interface PendingInput {
  request: InputRequest;
  settle: (response: InputResponse) => void;
}

/** Approval kinds each autoApprove mode answers. Questions and plans are never on this list. */
const AUTO_KINDS: Record<AutoApprove, readonly InputKind[]> = {
  off: [],
  edits: ["file_approval"],
  all: ["command_approval", "file_approval", "tool_approval"],
};

/**
 * One agent session. Owns the seq counter, the replay log, the pending input
 * requests and the status derived from them. Providers only see its sink.
 */
export class AgentSession {
  readonly id: string;
  readonly log: EventLog;
  readonly #info: SessionInfo;
  readonly #onLifecycle: Listener;
  readonly #listeners = new Set<Listener>();
  readonly #openItems = new Map<string, Item>();
  readonly #pending = new Map<string, PendingInput>();
  #seq = 0;
  #turnActive = false;
  /** The turn the provider has started and not yet completed. */
  #turnId: string | null = null;
  /** Set from Stop until the turn ends; what send() waits on meanwhile. */
  #interrupting: Promise<void> | null = null;
  /** Messages steered into the running turn that the agent has not read yet, by item id. */
  readonly #queued = new Map<string, Item>();
  /** send() calls run one after another: the next one's "is a turn running?" is
   *  answered only once the previous one has actually opened its turn. */
  #sends: Promise<unknown> = Promise.resolve();
  #provider: ProviderSession | null = null;
  /** For a restored session: starts (resumes) the provider on first use. */
  #starter: (() => Promise<ProviderSession>) | null = null;
  #starting: Promise<ProviderSession> | null = null;
  /** The user message waiting for its turn.started, which will name it. */
  #pendingUserItemId: string | null = null;
  /** Set while importing history, so replayed turns do not announce status changes. */
  #quiet = false;
  /** Armed while status is `rate_limited`: fires the provider's own resend (see retryLater). */
  #retryTimer: NodeJS.Timeout | null = null;

  constructor(info: SessionInfo, onLifecycle: Listener, logCapacity?: number) {
    this.id = info.id;
    this.#info = { autoApprove: "off", ...info };
    this.#onLifecycle = onLifecycle;
    this.log = new EventLog(logCapacity);
  }

  get info(): SessionInfo {
    return { ...this.#info, lastSeq: this.#seq, queued: this.#queued.size };
  }

  get closed(): boolean {
    return this.#info.status === "closed";
  }

  readonly sink: EventSink = {
    emit: (type, payload) => this.#emit(type, payload),
    requestInput: (request, signal) => this.#requestInput(request, signal),
    setProviderSessionId: (id) => {
      this.#info.providerSessionId = id;
      this.#announce("session.updated");
    },
    messageRead: (itemId) => this.#settleQueued(itemId, "read"),
    retryLater: (delayMs, input, info) => this.#retryLater(delayMs, input, info),
  };

  /**
   * Schedules an automatic resend of `input` after `delayMs` — see EventSink.retryLater.
   * Recorded as session state, not just armed silently: status flips to `rate_limited`
   * and `SessionInfo.rateLimit` carries `reason`/`retryAt` at once, so a client sees the
   * wait immediately, and still sees it on reconnect hours later. A later call (a fresher
   * estimate from a second failure) replaces the one already armed rather than stacking.
   */
  #retryLater(delayMs: number, input: UserInput, info: { reason: string; retryAt: number }): void {
    if (this.closed) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#info.rateLimit = { ...info };
    this.#refreshStatus();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.closed || this.#turnActive) return;
      void this.send(input).catch(() => {});
    }, delayMs).unref();
  }

  /**
   * Clears a pending auto-retry (status `rate_limited`) if one is armed — shared by
   * a fresh send() (any send, manual or the retry's own, always ends the wait) and by
   * Stop's own use of this as "cancel it" when there is no turn running. Returns
   * whether there was one, so a caller with nothing else to announce can skip it.
   */
  #cancelRateLimitWait(): boolean {
    if (!this.#retryTimer && !this.#info.rateLimit) return false;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#info.rateLimit = undefined;
    return true;
  }

  /** A steered message's next state, said as its item again (item.completed) and in the queued count. */
  #settleQueued(itemId: string, steer: "read" | "dropped"): void {
    const item = this.#queued.get(itemId);
    if (!item || item.kind !== "message") return;
    this.#queued.delete(itemId);
    this.#emit("item.completed", { turnId: this.#turnId, item: { ...item, steer } });
    this.#announce("session.updated");
  }

  announce(): void {
    this.#announce("session.created");
  }

  bind(provider: ProviderSession): void {
    this.#provider = provider;
    this.#setStatus("idle");
  }

  /** Binds a provider that is only started when the session is next used. */
  bindLazy(start: () => Promise<ProviderSession>): void {
    this.#starter = start;
    this.#setStatus("idle");
  }

  /** Changes session settings; a new autoApprove mode also answers approvals already waiting. */
  configure(settings: { autoApprove?: AutoApprove | undefined }): void {
    if (this.closed) throw new HostError("conflict", "session is closed");
    if (settings.autoApprove && settings.autoApprove !== this.#info.autoApprove) {
      this.#info.autoApprove = settings.autoApprove;
      this.#announce("session.updated");
      for (const [requestId, pending] of [...this.#pending]) this.#applyPolicy(requestId, pending);
    }
  }

  /**
   * Replays turns from the provider's transcript into this session's log, so a
   * client attaching after a host restart sees the conversation so far.
   */
  importHistory(turns: HistoryTurn[]): void {
    this.#quiet = true;
    try {
      for (const turn of turns) {
        const [first, ...rest] = turn.items;
        const user = first?.kind === "message" && first.role === "user" ? first : undefined;
        if (user) this.#emit("item.completed", { turnId: null, item: user });
        this.#emit("turn.started", { turnId: turn.turnId, ...(user ? { userItemId: user.id } : {}) });
        for (const item of user ? rest : turn.items) this.#emit("item.completed", { turnId: turn.turnId, item });
        this.#emit("turn.completed", { turnId: turn.turnId, status: turn.status });
      }
    } finally {
      this.#quiet = false;
    }
  }

  attach(listener: Listener, afterSeq = 0): Attachment {
    if (this.closed) throw new HostError("conflict", "session is closed");
    // A client ahead of this log saw an earlier run of the host (seq restarts after a
    // restore). Its view is stale, so it gets everything and is told to redraw.
    const from = afterSeq > this.#seq ? 0 : afterSeq;
    const { events, gap: evicted, oldestSeq } = this.log.since(from);
    const gap = evicted || from !== afterSeq;
    const replay = [...events];
    for (const item of this.#openItems.values()) replay.push(this.#event("item.updated", { item }));
    if (gap) {
      // The input.required for a still-pending request may have been evicted.
      for (const { request } of this.#pending.values()) {
        const replayed = events.some(
          (e) => e.type === "input.required" && e.payload.request.requestId === request.requestId,
        );
        if (!replayed) replay.push(this.#event("input.required", { request }));
      }
    }
    this.#listeners.add(listener);
    // Someone opened a restored session: start (resume) its provider now rather than on
    // the first message, which would otherwise wait for the process to start. Deferred so
    // the attach reply and replay go out first; a failure here is reported by send().
    if (!this.#provider && this.#starter && !this.#starting) {
      setImmediate(() => {
        if (!this.closed) void this.#ensureProvider().catch(() => {});
      });
    }
    return { replay, gap, oldestSeq, detach: () => this.#listeners.delete(listener) };
  }

  send(input: UserInput): Promise<void> {
    const run = this.#sends.then(() => this.#send(input));
    this.#sends = run.catch(() => {});
    return run;
  }

  async #send(input: UserInput): Promise<void> {
    if (this.closed) throw new HostError("conflict", "session is closed");
    // Typed right after Stop: held until the turn has ended, then it opens the next one.
    if (this.#interrupting) await this.#interrupting.catch(() => {});
    if (this.closed) throw new HostError("conflict", "session is closed");
    if (this.#turnActive) return this.#steer(input);
    // A send, manual or the auto-retry's own, always ends any wait that was pending.
    this.#cancelRateLimitWait();
    // Reserve the turn before any await, so a second send cannot slip in while a restored provider resumes.
    this.#turnActive = true;
    let provider: ProviderSession;
    try {
      provider = await this.#ensureProvider();
    } catch (err) {
      this.#turnActive = false;
      throw err;
    }
    if (TRACE) traceMark(this.id, "provider");
    const userItemId = input.id ?? newId("it");
    this.#emit("item.completed", {
      turnId: null,
      item: { id: userItemId, kind: "message", role: "user", text: input.text, status: "completed" },
    });
    this.#pendingUserItemId = userItemId;
    this.#refreshStatus();
    try {
      await provider.send(input);
    } catch (err) {
      this.#pendingUserItemId = null;
      this.#turnActive = false;
      this.#refreshStatus();
      throw err;
    }
  }

  /**
   * A message while a turn runs (PROTOCOL.md, "Messages during a turn"). The provider adds it to that
   * turn; the user message goes out once it has, under the turn's id. No turn.started
   * follows unless the turn had just ended and the message opened the next one.
   */
  async #steer(input: UserInput): Promise<void> {
    const provider = this.#provider;
    // Before turn.started the turn is still being set up, and there is nothing to add to.
    if (!provider?.steer || !this.#turnId) throw new HostError("conflict", "a turn is already running");
    const item: Item = { id: input.id ?? newId("it"), kind: "message", role: "user", text: input.text, status: "completed", steer: "queued" };
    // Registered before the provider has it: one that reads it at once (Codex reports
    // the input as its own item right away) says so through the sink while steer()
    // is still running, and the item then goes out once, already read.
    this.#queued.set(item.id, item);
    try {
      await provider.steer(input, item.id);
    } catch (err) {
      this.#queued.delete(item.id);
      throw err;
    }
    if (!this.#queued.has(item.id)) return;
    this.#emit("item.completed", { turnId: this.#turnId, item });
    this.#announce("session.updated");
  }

  /**
   * Stops the running turn. The session is `interrupting` until the provider reports
   * turn.completed (or gives up on the process — see the Claude adapter), then idle.
   * Resolves after that; a second Stop meanwhile shares the wait.
   *
   * With no turn running, Stop instead cancels a pending usage-limit auto-retry if one
   * is armed (status `rate_limited`) — the same "stop what the host is about to do on
   * its own" Stop already means for a running turn, just nothing left to wait out.
   * A plain no-op otherwise, as before.
   */
  async interrupt(): Promise<void> {
    if (this.closed) throw new HostError("conflict", "session is closed");
    if (!this.#turnActive) {
      if (this.#cancelRateLimitWait()) this.#refreshStatus();
      return;
    }
    if (!this.#provider) return;
    if (this.#interrupting) return this.#interrupting;
    const run = this.#provider.interrupt();
    this.#interrupting = run.finally(() => {
      this.#interrupting = null;
      this.#refreshStatus();
    });
    this.#refreshStatus();
    return this.#interrupting;
  }

  respond(requestId: string, decisionId: string, answers?: Record<string, string>): void {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new HostError("not_found", `no pending input request ${requestId}`);
    const decision = pending.request.decisions.find((d) => d.id === decisionId);
    if (!decision) throw new HostError("bad_request", `unknown decision ${decisionId}`);
    this.#resolve(requestId, pending, decision, "user", answers);
  }

  async close(reason: string | null): Promise<void> {
    if (this.closed) return;
    // Shares #cancelRateLimitWait()'s own clear rather than re-doing half of it inline: a
    // closing session has no more use for either the timer or the rateLimit it was showing.
    this.#cancelRateLimitWait();
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      this.#emit("input.resolved", { requestId, decisionId: null, effect: "cancel", by: "host" });
      pending.settle({ decisionId: null, effect: "cancel" });
    }
    try {
      const provider = this.#provider ?? (this.#starting ? await this.#starting.catch(() => null) : null);
      await provider?.close();
    } catch {
      // The session is going away either way.
    }
    this.#turnActive = false;
    this.#info.status = "closed";
    this.#info.updatedAt = Date.now();
    this.#onLifecycle(this.#event("session.closed", { session: this.info, reason }));
    this.#listeners.clear();
  }

  async #ensureProvider(): Promise<ProviderSession> {
    if (this.#provider) return this.#provider;
    if (!this.#starter) throw new HostError("conflict", "session is still starting");
    this.#starting ??= this.#starter().then(
      (provider) => {
        this.#provider = provider;
        return provider;
      },
      (err: unknown) => {
        this.#starting = null;
        throw new HostError("internal", `could not resume the ${this.#info.provider} session: ${errorMessage(err)}`);
      },
    );
    return this.#starting;
  }

  #requestInput(input: Omit<InputRequest, "requestId">, signal?: AbortSignal): Promise<InputResponse> {
    if (this.closed) return Promise.resolve({ decisionId: null, effect: "cancel" });
    if (signal?.aborted) return Promise.reject(signal.reason);
    const request: InputRequest = { ...input, requestId: newId("in") };
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.#pending.delete(request.requestId)) return;
        this.#emit("input.resolved", { requestId: request.requestId, decisionId: null, effect: "cancel", by: "host" });
        this.#refreshStatus();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const pending: PendingInput = {
        request,
        settle: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        },
      };
      this.#pending.set(request.requestId, pending);
      // The request is always recorded, even when the policy answers it at once.
      this.#emit("input.required", { request });
      this.#refreshStatus();
      this.#applyPolicy(request.requestId, pending);
    });
  }

  #applyPolicy(requestId: string, pending: PendingInput): void {
    const mode = this.#info.autoApprove ?? "off";
    if (!AUTO_KINDS[mode].includes(pending.request.kind)) return;
    // Plain allow only: the policy never widens scope with allow_session.
    const decision = pending.request.decisions.find((d) => d.effect === "allow");
    if (decision) this.#resolve(requestId, pending, decision, "policy");
  }

  #resolve(
    requestId: string,
    pending: PendingInput,
    decision: Decision,
    by: "user" | "policy",
    answers?: Record<string, string>,
  ): void {
    this.#pending.delete(requestId);
    this.#emit("input.resolved", { requestId, decisionId: decision.id, effect: decision.effect, by });
    this.#refreshStatus();
    pending.settle(
      answers ? { decisionId: decision.id, effect: decision.effect, answers } : { decisionId: decision.id, effect: decision.effect },
    );
  }

  #event<T extends EventType>(type: T, payload: EventPayload<T>): AgentEvent {
    return { v: PROTOCOL_VERSION, kind: "evt", type, ts: Date.now(), sessionId: this.id, payload } as AgentEvent;
  }

  #emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    if (this.closed) return;
    const event = this.#event(type, payload);
    if (event.type === "turn.started" && this.#pendingUserItemId) {
      event.payload = { ...event.payload, userItemId: this.#pendingUserItemId };
      this.#pendingUserItemId = null;
    }
    this.#track(event);
    if (isDurableEvent(type)) {
      event.seq = ++this.#seq;
      this.log.append(event);
    }
    for (const listener of this.#listeners) listener(event);
    if (TRACE && event.type === "turn.completed") traceTurnEnd(this.id, event.payload.status);
  }

  #track(event: AgentEvent): void {
    switch (event.type) {
      case "turn.started":
        this.#turnActive = true;
        this.#turnId = event.payload.turnId;
        // Not just #send()'s own explicit cancel: a provider can open a turn on its own
        // initiative with no send() involved at all (Claude: a message steered in too late
        // to fold reaches its own tool boundary and runs as a turn of its own — steer()'s
        // own doc comment). Without this, a wait armed before that turn started is left
        // pointing at a retryAt already in the past, showing as `rate_limited` again once
        // the turn ends even though nothing is actually still waiting on it.
        this.#cancelRateLimitWait();
        this.#refreshStatus();
        break;
      case "turn.completed":
        this.#turnActive = false;
        // A Stop discards what the agent had not read. After a turn that ran out
        // the messages stay queued: the agent runs them as its next turn.
        if (event.payload.status === "interrupted") {
          for (const id of [...this.#queued.keys()]) this.#settleQueued(id, "dropped");
        }
        this.#turnId = null;
        this.#refreshStatus();
        break;
      case "item.started":
        this.#openItems.set(event.payload.item.id, event.payload.item);
        break;
      case "item.updated":
        if (this.#openItems.has(event.payload.item.id)) this.#openItems.set(event.payload.item.id, event.payload.item);
        break;
      case "item.delta": {
        const { itemId, field, delta } = event.payload;
        const item = this.#openItems.get(itemId);
        if (item) this.#openItems.set(itemId, applyDelta(item, field, delta));
        break;
      }
      case "item.completed":
        this.#openItems.delete(event.payload.item.id);
        break;
    }
  }

  #refreshStatus(): void {
    this.#setStatus(
      !this.#turnActive
        ? this.#info.rateLimit
          ? "rate_limited"
          : "idle"
        : this.#interrupting
          ? "interrupting"
          : this.#pending.size > 0
            ? "waiting_input"
            : "running",
    );
  }

  #setStatus(status: SessionStatus): void {
    if (this.closed || this.#info.status === status) return;
    this.#info.status = status;
    this.#announce("session.updated");
  }

  #announce(type: "session.created" | "session.updated"): void {
    if (this.#quiet) return;
    this.#info.updatedAt = Date.now();
    this.#onLifecycle(this.#event(type, { session: this.info }));
  }
}
