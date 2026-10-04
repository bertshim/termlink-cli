import type {
  DecisionEffect,
  EventPayload,
  InputRequest,
  Item,
  ProviderId,
  ProviderStatus,
  UsageLimits,
  UserInput,
} from "@termlink/protocol";
import type { Terminal } from "@termlink/terminal";

export type { UserInput };

/** What a probe reports; the manager adds the id, kind and label. */
export type ProbeResult = Pick<ProviderStatus, "available" | "version" | "detail">;

/** Session events an agent provider may emit. Lifecycle and input events belong to the host. */
export type ProviderEventType =
  | "turn.started"
  | "turn.completed"
  | "item.started"
  | "item.delta"
  | "item.updated"
  | "item.completed"
  | "error"
  | "provider.event";

export interface InputResponse {
  decisionId: string | null;
  effect: DecisionEffect;
  answers?: Record<string, string>;
}

/** How a provider talks back to the host session that owns it. */
export interface EventSink {
  emit<T extends ProviderEventType>(type: T, payload: EventPayload<T>): void;
  /**
   * Blocks until a client answers. Rejects with the signal's reason if the signal aborts;
   * resolves with effect "cancel" if the session closes first.
   */
  requestInput(request: Omit<InputRequest, "requestId">, signal?: AbortSignal): Promise<InputResponse>;
  setProviderSessionId(id: string): void;
  /**
   * The model this session is actually running on, once the provider knows it.
   *
   * Session STATE rather than an event, for the reason SessionInfo.rateLimit
   * gives for being state too: it is true for as long as the session lives, so
   * a client that was not connected when it was first reported still has to
   * see it — on session.list, or on its next attach. Codex reports it in its
   * thread/start reply; a provider that never calls this simply has no model
   * to show, and SessionInfo.model stays absent.
   */
  setModel(model: string): void;
  /**
   * How much of the account's plan is spent, where the provider reports it —
   * SessionInfo.limits. Session state for the same reason setModel's is.
   *
   * Merged, not replaced: Codex's rolling updates are sparse, and a window
   * missing from one of them means "nothing new to say", not "gone".
   */
  setLimits(limits: UsageLimits): void;
  /** A message steered into the turn (its item id, as given to steer()) has reached the agent. */
  messageRead(itemId: string): void;
  /**
   * Resends `input` as a fresh send() after `delayMs`, as if it had been typed
   * again — for a provider whose turn failed on something that fixes itself with
   * time (Claude: a genuine usage-limit hit, a minute past its own reset). The host
   * session tracks the wait as real session state (status `rate_limited`,
   * `SessionInfo.rateLimit`), not a one-shot event: it can span hours, so a client
   * that reconnects partway through must still see it. A no-op at fire time if the
   * session has closed, or a turn is already running by then — the wait was
   * superseded by a real send, including this same mechanism's own.
   */
  retryLater(delayMs: number, input: UserInput, info: { reason: string; retryAt: number }): void;
}

export interface StartOptions {
  sessionId: string;
  cwd: string;
  /** Provider session or thread to resume instead of starting fresh. */
  resumeProviderSessionId?: string;
  /** Claude only: spawns with `--chrome` (browser control over an
   *  already-paired Chrome extension). Ignored by a provider that has no
   *  such thing — Codex, a terminal. */
  chrome?: boolean;
}

export interface ProviderSession {
  /** Resolves once the turn is accepted. The turn itself runs on and reports through the sink. */
  send(input: UserInput): Promise<void>;
  /**
   * Adds a message to the turn that is running, for the agent to read at its next step
   * (Claude: a queued user message folded in at the next tool boundary; Codex: turn/steer).
   * Resolves once the provider has taken it. If the turn has just ended, the message
   * starts a turn of its own, reported through the sink as usual. `itemId` names the
   * user message item the host shows for it; the provider reports through
   * sink.messageRead(itemId) once the agent has read it.
   * Present only on providers whose adapter sets `steer`.
   */
  steer?(input: UserInput, itemId: string): Promise<void>;
  /**
   * Summarise the conversation so far and carry on from the summary, as a real
   * call rather than a message typed at the agent (Codex: thread/compact/start).
   * Present only on providers whose adapter sets `compact`; the rest have no
   * such call, and a client that wants it there sends the provider's own
   * command as ordinary text instead.
   */
  compact?(): Promise<void>;
  /**
   * Resolves after the running turn has emitted turn.completed. Must resolve within a
   * bounded time whatever the agent does: the host session is `interrupting` meanwhile.
   */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** One finished turn read back from the provider's own transcript. The first item is the user message. */
export interface HistoryTurn {
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  items: Item[];
}

/** A coding agent: turns, items and approvals as JSON. Claude and Codex. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly kind: "agent";
  /** What to call it on screen. */
  readonly label: string;
  /** Sessions can be resumed after a host restart by their providerSessionId. */
  readonly resumable?: boolean;
  /** Its sessions take messages while a turn runs (ProviderSession.steer). */
  readonly steer?: boolean;
  /** Its sessions have a real call for compaction (ProviderSession.compact),
   *  rather than a command a client has to type at the agent. */
  readonly compact?: boolean;
  probe(): Promise<ProbeResult>;
  start(options: StartOptions, sink: EventSink): Promise<ProviderSession>;
  /** Recent turns of a stored session, oldest first. */
  history?(providerSessionId: string, cwd: string): Promise<HistoryTurn[]>;
  /** Releases shared resources such as a long-lived child process. */
  dispose?(): Promise<void>;
}

export interface OpenTerminalOptions {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
}

/** A shell in a PTY: bytes in, bytes out. Nothing to resume after a restart. */
export interface TerminalProvider {
  readonly id: ProviderId;
  readonly kind: "terminal";
  readonly label: string;
  probe(): Promise<ProbeResult>;
  open(options: OpenTerminalOptions): Promise<Terminal>;
}

export type HostProvider = ProviderAdapter | TerminalProvider;
