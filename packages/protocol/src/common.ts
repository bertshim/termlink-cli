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

/** `interrupting`: Stop was pressed and the turn has not ended yet (agent sessions). */
export const SessionStatus = z.enum(["starting", "idle", "running", "waiting_input", "interrupting", "closed"]);
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
