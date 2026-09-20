import type { Decision, DecisionEffect, FileChange, Item, ItemStatus, Usage } from "@termlink/protocol";
import { displayPath, unifiedDiff } from "../diff.js";
import type { ContentBlock, PermissionOption, TokenUsage, ToolCallContentItem, ToolCallKind, ToolCallStatus } from "./protocol.js";

/** Only text blocks render; everything else (image, resource, ...) contributes nothing yet. */
export function blockText(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export function mapToolStatus(status: ToolCallStatus | undefined): ItemStatus {
  if (status === "pending") return "in_progress";
  return status ?? "in_progress";
}

/** allow_once/allow_always both let the call through; only "always" also skips asking again this session. */
function mapEffect(kind: PermissionOption["kind"]): DecisionEffect {
  return kind === "allow_always" ? "allow_session" : kind === "allow_once" ? "allow" : "deny";
}

export function mapDecisions(options: readonly PermissionOption[]): Decision[] {
  return options.map((o) => ({ id: o.optionId, label: o.name, effect: mapEffect(o.kind) }));
}

/** The reason text on a pending approval's own toolCall.content — the "content"-wrapped
 *  variant only (see protocol.ts's own note on the two shapes this field can hold). */
export function approvalBody(content: readonly ToolCallContentItem[] | undefined): string {
  return blockText((content ?? []).filter((c): c is { type: "content"; content: ContentBlock } => c.type === "content").map((c) => c.content));
}

/** The diff entries a finished "edit" tool_call reports, turned into TermLink's own
 *  FileChange — which wants a real unified diff, not raw before/after text. copilot reports
 *  `path` as an absolute path, same as Cursor's own "edit" tool_call; cwd turns it into the
 *  repo-relative form Claude's own file changes already use. */
function changesFromContent(content: readonly ToolCallContentItem[] | undefined, cwd: string): FileChange[] {
  return (content ?? [])
    .filter((c): c is { type: "diff"; path: string; oldText: string | null; newText: string } => c.type === "diff")
    .map((d) => {
      const name = displayPath(d.path, cwd);
      return {
        path: name,
        action: d.oldText === null ? "add" : "modify",
        diff: unifiedDiff(name, d.oldText ?? "", d.newText),
      };
    });
}

/** A shell command gets the CommandItem termlink already has a timeline row for, and an edit
 *  gets the FileChangeItem (diff and all); everything else (read, search, an MCP call, ...)
 *  is a generic tool call named after its kind. */
export function isCommandKind(kind: ToolCallKind): boolean {
  return kind === "execute";
}

export function isEditKind(kind: ToolCallKind): boolean {
  return kind === "edit";
}

/** copilot renders an execute call's title as a natural-language description ("Show current
 *  shell user"), not the command itself the way cursor-agent's backtick-quoted title does —
 *  so there is nothing to unquote here, just a title to keep as `display` whenever it
 *  differs from the parsed command, which for Copilot it always does. */
function unquoteTitle(title: string): string {
  return title.replace(/^`(.*)`$/s, "$1");
}

export function commandOf(rawInput: unknown, title: string): string {
  if (rawInput && typeof rawInput === "object" && typeof (rawInput as { command?: unknown }).command === "string") {
    return (rawInput as { command: string }).command;
  }
  return unquoteTitle(title);
}

function outputOf(rawOutput: unknown): { output?: string; exitCode?: number | null } {
  if (!rawOutput || typeof rawOutput !== "object") return {};
  const o = rawOutput as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; content?: unknown; message?: unknown };
  if (typeof o.exitCode === "number" || o.stdout !== undefined || o.stderr !== undefined) {
    const text = [o.stdout, o.stderr].filter((s): s is string => typeof s === "string" && s.length > 0).join("");
    return { output: text, exitCode: typeof o.exitCode === "number" ? o.exitCode : null };
  }
  if (typeof o.content === "string") return { output: o.content };
  // A rejected tool_call's own shape ({message, code}) has no exitCode and no stdout: the
  // message is the only human-readable part, e.g. "The user rejected this tool call."
  if (typeof o.message === "string") return { output: o.message };
  return {};
}

interface ToolCallStartParams {
  toolCallId: string;
  title: string;
  kind: ToolCallKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContentItem[];
}

interface ToolCallUpdateParams {
  title?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContentItem[];
}

/** A fresh item for a tool_call notification. */
export function mapToolCallStart(params: ToolCallStartParams, cwd: string): Item {
  const status = mapToolStatus(params.status);
  if (isCommandKind(params.kind)) {
    const command = commandOf(params.rawInput, params.title);
    return {
      id: params.toolCallId,
      kind: "command",
      command,
      ...(unquoteTitle(params.title).trim() !== command.trim() ? { display: params.title } : {}),
      status,
      ...outputOf(params.rawOutput),
    };
  }
  if (isEditKind(params.kind)) {
    return { id: params.toolCallId, kind: "file_change", changes: changesFromContent(params.content, cwd), status };
  }
  return {
    id: params.toolCallId,
    kind: "tool",
    name: params.kind,
    input: params.rawInput,
    output: params.rawOutput,
    status,
  };
}

/** Folds a tool_call_update patch into the item tool_call started. */
export function mapToolCallUpdate(item: Item, patch: ToolCallUpdateParams, cwd: string): Item {
  const status = patch.status === undefined ? item.status : mapToolStatus(patch.status);
  if (item.kind === "command") {
    const command = patch.rawInput === undefined ? item.command : commandOf(patch.rawInput, patch.title ?? item.command);
    // A patch can bring rawInput after the title already showed (mapToolCallStart's own
    // note on why) — command above already accounts for that, but display was left as
    // whatever mapToolCallStart happened to compute against the old command, so it must be
    // recomputed the same way here rather than carried over from item unexamined. The title
    // to compare against is this patch's own if it has one, else the last one known: item's
    // own display when there was one, item's own command when there wasn't (that is what
    // "no display" already meant).
    const { display: _display, ...rest } = item;
    const title = patch.title ?? item.display ?? item.command;
    const differs = unquoteTitle(title).trim() !== command.trim();
    return { ...rest, command, ...(differs ? { display: title } : {}), status, ...outputOf(patch.rawOutput) };
  }
  if (item.kind === "file_change") {
    const changes = patch.content === undefined ? item.changes : changesFromContent(patch.content, cwd);
    return { ...item, changes, status };
  }
  if (item.kind === "tool") {
    return {
      ...item,
      status,
      input: patch.rawInput === undefined ? item.input : patch.rawInput,
      output: patch.rawOutput === undefined ? item.output : patch.rawOutput,
    };
  }
  return item;
}

/** Copilot's own per-turn token counts, straight onto TermLink's Usage — a field Cursor's
 *  ACP implementation never sends at all (see cursor/provider.ts's own history on that). */
export function mapUsage(usage: TokenUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}
