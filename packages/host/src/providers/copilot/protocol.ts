// Subset of the Agent Client Protocol (https://agentclientprotocol.com) that `copilot --acp`
// speaks, measured by hand against GitHub Copilot CLI 1.0.86 the same way cursor/protocol.ts
// was measured against cursor-agent — there is no `generate-ts` for this one either. Copilot
// and Cursor implement the same open protocol, and most of what was measured for one reads
// on the other unchanged (tool_call's diff content shape, the three permission option kinds,
// rawInput.command): where this file and cursor/protocol.ts differ, it is because Copilot's
// own agent genuinely answers differently, not because the protocol does.
//
// The one measured, load-bearing difference: cancelling a turn (session/cancel) resolves
// Copilot's session/prompt with `stopReason: "end_turn"`, never `"cancelled"` — unlike
// Cursor, which reports "cancelled" faithfully. session.ts's own interrupt() does not trust
// stopReason at all because of this; see its own note.
//
// Wire format: newline-delimited JSON-RPC 2.0.

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

export type ContentBlock = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

/** Copilot's own stopReason is close to useless for telling a cancel from a natural end —
 *  see this file's own header note — so nothing here treats any particular value specially. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | (string & {});

export interface SessionPromptResponse {
  stopReason: StopReason;
  /** Absent from Cursor's own response entirely; Copilot reports real billed usage per
   *  turn, mapped straight onto TermLink's own Usage type (mapper.ts's mapUsage). */
  usage?: TokenUsage;
}

export interface SessionCancelParams {
  sessionId: string;
}

export type ToolCallKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Same two shapes cursor/protocol.ts's own ToolCallContentItem documents — measured
 *  separately against Copilot and found identical: `{type:"content", content}` wraps a
 *  reason or a tool's own text result, `{type:"diff", path, oldText, newText}` is what a
 *  finished "edit" call reports. */
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

/** Session metadata this adapter has no use for — see cursor/protocol.ts's own note on why
 *  three interfaces rather than one `sessionUpdate: "a" | "b" | "c"` field. Copilot adds
 *  usage_update and config_option_update beyond what Cursor sends; both land here too. */
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
export interface UsageUpdate {
  sessionUpdate: "usage_update";
  [key: string]: unknown;
}
export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  [key: string]: unknown;
}

export type SessionUpdate =
  | ToolCallStartUpdate
  | ToolCallProgressUpdate
  | MessageChunkUpdate
  | PlanUpdate
  | SessionInfoUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | UsageUpdate
  | ConfigOptionUpdate;

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

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
}

export type SessionLoadResponse = Record<string, unknown>;
