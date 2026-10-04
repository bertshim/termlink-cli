import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

/**
 * What a session carries. A terminal is a byte stream to a shell; an agent session is
 * turns, items and approval requests in JSON.
 */
export const SessionKind = z.enum(["terminal", "agent"]);
export type SessionKind = z.infer<typeof SessionKind>;

/**
 * Provider ids are open strings: a host lists the ones it has in host.ready, with a
 * kind and a label, so clients need not know them ahead of time.
 */
export const ProviderId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/, "provider ids are lowercase letters, digits, _ and -");
export type ProviderId = z.infer<typeof ProviderId>;

export const TERMINAL_PROVIDER = "terminal" as const;

/**
 * `interrupting`: Stop was pressed and the turn has not ended yet (agent sessions).
 * `rate_limited`: a turn failed on the plan's own usage limit and the host is waiting
 * out `SessionInfo.rateLimit.retryAt` before trying it again on its own (agent
 * sessions, Claude only for now — see PROTOCOL.md "Rate limits").
 */
export const SessionStatus = z.enum(["starting", "idle", "running", "waiting_input", "interrupting", "rate_limited", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * How an agent session answers approvals by itself. A convenience, not a security boundary:
 * the boundary stays the OS account and the agent's own sandbox.
 *   off    ask for everything
 *   edits  allow file changes
 *   all    allow commands, file changes and other tools
 * Questions and plan approvals always wait for a person.
 */
export const AutoApprove = z.enum(["off", "edits", "all"]);
export type AutoApprove = z.infer<typeof AutoApprove>;

export const TerminalSize = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalSize = z.infer<typeof TerminalSize>;

/**
 * One metered window of the plan an agent session runs on: how much of it is
 * spent, and when it starts again.
 *
 * `resetsAt` is epoch MILLISECONDS, like every other time in this protocol —
 * a provider reporting seconds converts on the way in.
 */
export const UsageWindow = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable().optional(),
  /** How long the window is, where the provider says — 300 for a 5-hour one. */
  windowMinutes: z.number().nullable().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * The plan limits behind an agent session, where its provider reports them.
 *
 * Two windows rather than named ones ("5-hour", "weekly") because the names
 * are the provider's business and change with the plan: `primary` is the short
 * window and `secondary` the long one, which is the shape Codex reports and
 * the order any client should draw them in.
 */
export const UsageLimits = z.object({
  primary: UsageWindow.nullable().optional(),
  secondary: UsageWindow.nullable().optional(),
  /** The plan's own name, where given — "plus", "pro", "team". */
  plan: z.string().nullable().optional(),
});
export type UsageLimits = z.infer<typeof UsageLimits>;

export const SessionInfo = z.object({
  id: z.string(),
  kind: SessionKind,
  provider: ProviderId,
  /** Claude session id or Codex thread id, once the provider has assigned one. Null for terminals. */
  providerSessionId: z.string().nullable(),
  cwd: z.string(),
  title: z.string().nullable(),
  status: SessionStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Highest seq emitted on this session so far. Always 0 for terminals, which have no replay log. */
  lastSeq: z.number().int(),
  /**
   * Agent sessions: the model this session actually runs on, once its provider
   * has said so — Codex reports it in the reply that opens the thread.
   *
   * State, not an event, for the same reason rateLimit below is: it holds for
   * the life of the session, so a client that connects later still needs it.
   * Absent where the provider never reports one; a client that wants a model
   * name from such a provider has to ask the agent itself (Claude Code answers
   * `/model`, which is what the TermLink web client does there).
   */
  model: z.string().optional(),
  /**
   * Agent sessions: how much of the account's plan this session's provider says
   * is spent, and when it resets. State for the same reason `model` is — it is
   * true of the account for as long as the session lives, and a client that
   * connects later still needs it.
   *
   * Codex reports it (`account/rateLimits/read`, then pushes as it moves).
   * Absent where the provider does not; Claude answers `/usage` instead, which
   * is a question a client has to ask rather than state the host can carry.
   */
  limits: UsageLimits.optional(),
  /** Agent sessions only. */
  autoApprove: AutoApprove.optional(),
  /** Agent sessions: messages sent during the running turn that the agent has not read yet. */
  queued: z.number().int().optional(),
  /** Terminal sessions only. */
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
  pid: z.number().int().optional(),
  /** Terminal sessions only, once the shell has exited. */
  exitCode: z.number().int().nullable().optional(),
  /**
   * Set while status is `rate_limited`: the failed turn's own error text, and when
   * the host will resend it (a minute past the plan's own reset — PROTOCOL.md "Rate
   * limits"). Session-level, not an event, precisely because the wait can span
   * hours: a client that was not even connected when the limit hit still sees it,
   * on session.list or its next attach, the same as any other status.
   */
  rateLimit: z.object({ reason: z.string(), retryAt: z.number() }).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ProviderStatus = z.object({
  id: ProviderId,
  kind: SessionKind,
  /** What to call it on screen: "Terminal", "Claude", "Codex". */
  label: z.string(),
  available: z.boolean(),
  version: z.string().nullable(),
  detail: z.string().nullable(),
  /**
   * Its agent sessions take session.send while a turn runs: the message joins that
   * turn instead of waiting for it to end. Absent means they refuse with conflict.
   */
  steer: z.boolean().optional(),
  /**
   * A closed session of this provider can be reopened with session.create's own
   * `resume` (its providerSessionId), landing back in the same transcript instead of
   * empty. Absent means the provider can't — a client should not offer it.
   */
  resumable: z.boolean().optional(),
  /**
   * Its agent sessions can be compacted with `session.compact` — the agent
   * summarises what it has so far and carries on from the summary.
   *
   * Absent means it has no such call, and a client that wants the behaviour
   * has to type the provider's own command at it as a message (Claude Code
   * answers "/compact"). It must NOT do that blindly: a provider without a
   * command by that name reads it as ordinary text and replies in prose.
   */
  compact: z.boolean().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const HostInfo = z.object({
  hostId: z.string(),
  name: z.string(),
  version: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  os: z.string(),
  providers: z.array(ProviderStatus),
  /**
   * Folders sessions may be opened in. A relative session.create cwd resolves
   * against the first one. Absent means the host does not restrict cwd.
   */
  roots: z.array(z.string()).optional(),
});
export type HostInfo = z.infer<typeof HostInfo>;
