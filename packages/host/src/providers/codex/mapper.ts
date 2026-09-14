import type { Decision, FileChange, Item, ItemStatus } from "@termlink/protocol";
import { displayCommand } from "../display.js";
import type { CommandExecutionStatus, FileUpdateChange, ThreadItem, ToolCallStatus } from "./protocol.js";

export type Phase = "started" | "completed";

/** Decision ids are Codex's own decision strings, so the reply needs no lookup table. */
export const APPROVAL_DECISIONS: Decision[] = [
  { id: "accept", label: "Allow", effect: "allow" },
  { id: "acceptForSession", label: "Allow for this session", effect: "allow_session" },
  { id: "decline", label: "Deny", effect: "deny" },
  { id: "cancel", label: "Deny and stop", effect: "cancel" },
];

export function mapStatus(status: CommandExecutionStatus | ToolCallStatus): ItemStatus {
  return status === "inProgress" ? "in_progress" : status;
}

function phaseStatus(phase: Phase): ItemStatus {
  return phase === "started" ? "in_progress" : "completed";
}

export function mapFileChange(change: FileUpdateChange): FileChange {
  switch (change.kind.type) {
    case "add":
      return { path: change.path, action: "add", diff: change.diff };
    case "delete":
      return { path: change.path, action: "delete", diff: change.diff };
    case "update":
      return change.kind.move_path
        ? { path: change.path, action: "rename", movePath: change.kind.move_path, diff: change.diff }
        : { path: change.path, action: "modify", diff: change.diff };
  }
}

/**
 * Maps a Codex thread item to a TermLink item. Returns null for items the host
 * already reports itself (user messages) or that have nothing to show.
 */
export function mapItem(item: ThreadItem, phase: Phase): Item | null {
  switch (item.type) {
    case "userMessage":
    case "contextCompaction":
      return null;
    case "agentMessage":
    case "plan":
      return { id: item.id, kind: "message", role: "assistant", text: item.text, status: phaseStatus(phase) };
    case "reasoning":
      return { id: item.id, kind: "reasoning", text: item.summary.join("\n\n"), status: phaseStatus(phase) };
    case "commandExecution": {
      const display = displayCommand(item.command, item.commandActions);
      return {
        id: item.id,
        kind: "command",
        command: item.command,
        ...(display ? { display } : {}),
        cwd: item.cwd,
        ...(item.aggregatedOutput === null ? {} : { output: item.aggregatedOutput }),
        exitCode: item.exitCode,
        status: mapStatus(item.status),
      };
    }
    case "fileChange":
      return { id: item.id, kind: "file_change", changes: item.changes.map(mapFileChange), status: mapStatus(item.status) };
    case "mcpToolCall":
      return {
        id: item.id,
        kind: "tool",
        name: `${item.server}/${item.tool}`,
        input: item.arguments,
        output: item.error ? { error: item.error.message } : item.result?.content,
        status: mapStatus(item.status),
      };
    case "dynamicToolCall":
      return {
        id: item.id,
        kind: "tool",
        name: item.tool,
        input: item.arguments,
        output: item.contentItems ?? undefined,
        status: mapStatus(item.status),
      };
    case "webSearch":
      return { id: item.id, kind: "tool", name: "web_search", input: { query: item.query }, status: phaseStatus(phase) };
    default: {
      // Newer or less common item types (hooks, review mode, sub-agents, ...).
      const other = item as { type: string; id: string };
      return { id: other.id, kind: "tool", name: other.type, status: phaseStatus(phase) };
    }
  }
}
