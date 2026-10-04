// Subset of the codex app-server v2 protocol used by this adapter, copied by hand from
// `codex app-server generate-ts` output for codex-cli 0.153.4. The generated files use
// extensionless imports that do not compile under NodeNext, so they are not vendored.
// When upgrading Codex, run `npm run codex:types -w @termlink/cli` and diff.
//
// Wire format: newline-delimited JSON-RPC without a "jsonrpc" field.
//   request      {"id", "method", "params"}
//   response     {"id", "result"} or {"id", "error": {"code", "message"}}
//   notification {"method", "params"}

export type RequestId = string | number;

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type AskForApproval = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ThreadStartParams {
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}

/** Also the shape of the thread/resume response for the fields used here. */
export interface ThreadStartResponse {
  thread: { id: string };
  model: string;
  cwd: string;
}

export interface TextInput {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: TextInput[];
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface Turn {
  id: string;
  status: TurnStatus;
  error: { message: string } | null;
  /** Filled by thread/turns/list with itemsView "full". */
  items?: ThreadItem[];
}

export interface TurnStartResponse {
  turn: Turn;
}

/** Adds input to the turn in progress. Fails unless expectedTurnId is the active turn. */
export interface TurnSteerParams {
  threadId: string;
  input: TextInput[];
  expectedTurnId: string;
}

export interface TurnSteerResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";
export type ToolCallStatus = "inProgress" | "completed" | "failed";

export interface FileUpdateChange {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
  diff: string;
}

/** Item types this adapter maps. Others arrive at runtime and fall through to a generic tool item. */
export type ThreadItem =
  | { type: "userMessage"; id: string }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      /** Best-effort parse of the command; each entry carries one sub-command's text. */
      commandActions?: { type: string; command: string }[];
      status: CommandExecutionStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: PatchApplyStatus }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: ToolCallStatus;
      arguments: unknown;
      result: { content: unknown[] } | null;
      error: { message: string } | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: unknown;
      status: ToolCallStatus;
      contentItems: unknown[] | null;
    }
  | { type: "webSearch"; id: string; query: string }
  | { type: "contextCompaction"; id: string };

// Notifications

export interface TurnNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface DeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ReasoningSummaryPartAddedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  summaryIndex: number;
}

export interface FileChangePatchUpdatedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileUpdateChange[];
}

export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: { step: string; status: "pending" | "inProgress" | "completed" }[];
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown };
}

/**
 * One metered window of the signed-in account's plan. Codex reports a short
 * one and a long one — its own TUI draws them as the 5-hour and weekly limits
 * on `/status`. `resetsAt` is epoch SECONDS where the backend supplied it.
 */
export interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

export interface RateLimitSnapshot {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
}

/** The reply to `account/rateLimits/read`. */
export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
}

/**
 * `account/rateLimits/updated` — pushed as the account's usage moves.
 *
 * ACCOUNT-level, so unlike everything else here it carries no `threadId`: one
 * signed-in account is shared by every thread on this app-server connection.
 * The snapshot is sparse — a rolling update may omit fields it has nothing new
 * to say about, and omitting one does NOT mean it has gone away.
 */
export interface AccountRateLimitsUpdatedNotification {
  rateLimits: RateLimitSnapshot;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  error: { message: string };
  willRetry: boolean;
}

export interface ServerRequestResolvedNotification {
  threadId: string;
  requestId: RequestId;
}

// Server -> client requests

export interface CommandExecutionRequestApprovalParams {
  kind: "command" | "writeStdin";
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

/** Both approval kinds accept these; command approvals also accept policy amendments. */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
