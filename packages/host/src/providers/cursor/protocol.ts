// Subset of the Agent Client Protocol (https://agentclientprotocol.com) that `cursor-agent acp`
// speaks, as measured against cursor-agent 2026.09.02 by hand (there is no `generate-ts` for
// this one): a live client sent initialize, authenticate, session/new, session/prompt and
// session/cancel against a real `cursor-agent acp` process and the shapes below are what came
// back. Cursor's own extension methods (cursor/ask_question, cursor/create_plan,
// cursor/update_todos, cursor/task, cursor/generate_image — see cursor.com/docs/cli/acp) are
// deliberately not modelled beyond the minimum to answer them without hanging the turn: their
// exact fields were never exercised live, and guessing a schema is worse than a provider.event
// noting that one arrived unhandled (see session.ts).
//
// Wire format: newline-delimited JSON-RPC 2.0 (see ../rpc.ts's own note on why the same
// reader/writer that speaks Codex's fieldless dialect also speaks this one unmodified).

export type RequestId = string | number;

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: { fs?: { readTextFile: boolean; writeTextFile: boolean } };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface InitializeResponse {
  protocolVersion: number;
  authMethods: AuthMethod[];
}

export interface AuthenticateParams {
  methodId: string;
}

export interface SessionNewParams {
  cwd: string;
  mcpServers: unknown[];
}

export interface SessionNewResponse {
  sessionId: string;
}

/**
 * Reconnects a session cursor-agent already knows, replaying its whole history back as
 * ordinary session/update notifications before this resolves (measured live: every replay
 * notification for a two-turn session arrived before the session/load response did, and
 * calling it twice in a row for the same sessionId replayed cleanly both times and left the
 * session just as usable afterward — see history.ts and provider.ts's own notes on what
 * that buys this adapter).
 */
export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
}

export type SessionLoadResponse = Record<string, unknown>;

/** Switches the model an existing session uses for its next prompt — live-verified: a
 *  session started on GPT-5.1 answered "which model are you" as Claude Haiku 4.5 right
 *  after this. modelId is one of session/new's own response's `models.availableModels[].modelId`. */
export interface SessionSetModelParams {
  sessionId: string;
  modelId: string;
}

/** cursor-agent's three modes, from a live session/new's own `modes.availableModes`:
 *  "agent" (full tool access), "plan" (read-only planning), "ask" (Q&A, no edits or
 *  commands). Switching mid-session live-fired a current_mode_update notification back —
 *  not modelled here since this adapter has nothing that reads it yet. */
export type CursorMode = "agent" | "plan" | "ask";

export interface SessionSetModeParams {
  sessionId: string;
  modeId: CursorMode;
}

export type ContentBlock = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

/** end_turn/cancelled are the two this adapter treats specially; anything else is still a
 *  normal end to the turn (the agent stopped talking for a reason of its own). */
export type StopReason = "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal" | (string & {});

export interface SessionPromptResponse {
  stopReason: StopReason;
}

export interface SessionCancelParams {
  sessionId: string;
}

export type ToolCallKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * A tool_call's `content` mixes two shapes measured from two different moments: a pending
 * command-approval wraps its reason in `{type:"content", content: <text block>}` (probed
 * against a live `whoami` approval); a finished "edit" call instead reports what it wrote
 * as `{type:"diff", path, oldText, newText}` (probed against a live in-place file edit —
 * `oldText` was always a string there, but the diff has to exist somehow for a brand-new
 * file, so it is left nullable rather than assumed).
 */
export type ToolCallContentItem =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

interface ToolCallBase {
  toolCallId: string;
  title: string;
  kind: ToolCallKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContentItem[];
  locations?: { path: string }[];
}

export interface ToolCallStartUpdate extends ToolCallBase {
  sessionUpdate: "tool_call";
}

/** Every field but the id is a patch: only what changed since tool_call (or the last update) is present. */
export interface ToolCallProgressUpdate extends Partial<Omit<ToolCallBase, "toolCallId">> {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
}

export interface MessageChunkUpdate {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
  content: ContentBlock;
}

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: { content: string; status: PlanEntryStatus; priority?: string }[];
}

/**
 * Session metadata this adapter has no use for. Three separate interfaces rather than one
 * with a `sessionUpdate: "a" | "b" | "c"` field: TypeScript only narrows a discriminated
 * union on a switch when every member's discriminant is a literal, and a fourth, genuinely
 * unknown `sessionUpdate` value (a future Cursor release) still reaches the switch's
 * `default` at runtime even though it has no member here to type-check against.
 */
export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  [key: string]: unknown;
}
export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  [key: string]: unknown;
}
export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  [key: string]: unknown;
}

export type SessionUpdate =
  | ToolCallStartUpdate
  | ToolCallProgressUpdate
  | MessageChunkUpdate
  | PlanUpdate
  | SessionInfoUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate;

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallBase;
  options: PermissionOption[];
}

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface RequestPermissionResponse {
  outcome: PermissionOutcome;
}
