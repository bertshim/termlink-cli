export { HostError, errorMessage } from "./errors.js";
export { VERSION } from "./version.js";
export { EventLog } from "./session/event-log.js";
export { AgentSession, type Attachment, type Listener } from "./session/session.js";
export {
  TerminalSession,
  type FlowControlOptions,
  type TerminalAttachment,
  type TerminalListener,
} from "./session/terminal-session.js";
export {
  SessionManager,
  type CreateSessionOptions,
  type HostSession,
  type SessionManagerOptions,
} from "./session/manager.js";
export { SessionStore, defaultStatePath, type SessionRecord } from "./session/store.js";
export { claudeHistory, type TranscriptMessage } from "./providers/claude/history.js";
export type * from "./providers/types.js";
export { ShellProvider, type ShellProviderOptions } from "./providers/terminal.js";
export { CodexProvider, type CodexProviderOptions } from "./providers/codex/provider.js";
export { resolveCodexCommand, type CodexCommand } from "./providers/codex/command.js";
export { CursorProvider, type CursorProviderOptions } from "./providers/cursor/provider.js";
export { resolveCursorCommand, type CursorCommand } from "./providers/cursor/command.js";
export { CopilotProvider, type CopilotProviderOptions } from "./providers/copilot/provider.js";
export { resolveCopilotCommand, type CopilotCommand } from "./providers/copilot/command.js";
export {
  ClaudeProvider,
  CLAUDE_PERMISSION_MODES,
  apiKeyAuth,
  bundledClaudeExecutable,
  type ClaudePermissionMode,
  type ClaudeProviderOptions,
} from "./providers/claude/provider.js";
export { ClientConnection, type ConnectionTransport } from "./server/connection.js";
export { startLocalServer, toBytes, type LocalServer, type LocalServerOptions } from "./server/local-server.js";
export { DeltaCoalescer } from "./server/coalesce.js";
export { DEFAULT_SERVER, RelayHost, defaultRelaySession, type RelayHostOptions } from "./relay/relay-host.js";
export { DeviceError, defaultCredentialPath, loadDevice, renewIfDue, type DeviceCredential } from "./relay/device.js";
export { displayCommand } from "./providers/display.js";
