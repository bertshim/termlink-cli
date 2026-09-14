import type { Item } from "@termlink/protocol";
import { stripSteerNote } from "../steer-note.js";
import type { HistoryTurn } from "../types.js";
import { completeToolItem, mapToolUse, type ToolResult } from "./mapper.js";

/** The fields of the SDK's SessionMessage this reads. */
export interface TranscriptMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> };

/**
 * Rebuilds turns from a Claude Code transcript. A user text message opens a turn;
 * tool_use blocks pair with their tool_result. Edits are diffed from the edit itself,
 * since the files have changed since.
 */
export function claudeHistory(messages: readonly TranscriptMessage[], cwd: string, maxTurns = 30): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const open = new Map<string, Item>();
  let current: HistoryTurn | null = null;

  const finish = (): void => {
    if (!current) return;
    for (const item of open.values()) current.items.push({ ...item, status: "interrupted" });
    open.clear();
  };

  for (const entry of messages) {
    if (entry.parent_tool_use_id) continue; // Sub-agent internals.
    const message = (entry.message ?? {}) as { content?: unknown };
    const blocks: Block[] = Array.isArray(message.content) ? (message.content as Block[]) : [];

    if (entry.type === "user") {
      const results = blocks.filter((b) => b.type === "tool_result") as unknown as (ToolResult & { tool_use_id: string })[];
      if (results.length > 0) {
        for (const result of results) {
          const item = open.get(result.tool_use_id);
          if (!item || !current) continue;
          open.delete(result.tool_use_id);
          current.items.push(completeToolItem(item, result, undefined, false));
        }
        continue;
      }
      const text = stripSteerNote(
        typeof message.content === "string"
          ? message.content
          : blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n"),
      );
      // Skip empty and harness-injected messages (slash command wrappers, caveats).
      if (!text.trim() || text.trimStart().startsWith("<")) continue;
      finish();
      current = {
        turnId: `hist_${entry.uuid}`,
        status: "completed",
        items: [{ id: entry.uuid, kind: "message", role: "user", text, status: "completed" }],
      };
      turns.push(current);
      continue;
    }

    if (entry.type !== "assistant" || !current) continue;
    blocks.forEach((block, index) => {
      const id = `${entry.uuid}:${index}`;
      if (block.type === "text" && block.text) {
        current?.items.push({ id, kind: "message", role: "assistant", text: block.text, status: "completed" });
      } else if (block.type === "thinking" && block.thinking) {
        current?.items.push({ id, kind: "reasoning", text: block.thinking, status: "completed" });
      } else if (block.type === "tool_use" && block.id && block.name) {
        open.set(block.id, mapToolUse(block.id, block.name, block.input ?? {}, cwd, { readFiles: false }));
      }
    });
  }
  finish();
  return turns.slice(-maxTurns);
}
