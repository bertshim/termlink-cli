import { applyDelta, type Item } from "@termlink/protocol";
import type { HistoryTurn } from "../types.js";
import { mapToolCallStart, mapToolCallUpdate } from "./mapper.js";
import type { ContentBlock, SessionUpdate } from "./protocol.js";

type TextSlotKind = "user" | "agent" | "thought";

/**
 * Turns Copilot's own replay of a session — the session/update notifications session/load
 * fires before it resolves, the same trick cursor/history.ts's own note measured against
 * cursor-agent and this adapter re-measured against Copilot with the same result (a
 * two-turn session, reconnected from a fresh process, replayed user_message_chunk and
 * agent_message_chunk in full before the session/load response arrived) — into TermLink's
 * HistoryTurn[].
 *
 * Live-verified only for plain-text turns, same caveat as Cursor's: a replayed tool call is
 * assumed to repeat the exact tool_call/tool_call_update pair a live turn gets, correlated
 * by toolCallId, but that assumption itself was not checked against a real tool-using
 * turn's replay.
 */
export function buildHistoryTurns(updates: readonly SessionUpdate[], cwd: string): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let items: Item[] = [];
  let slot: { kind: TextSlotKind; item: Item } | null = null;
  const openTools = new Map<string, Item>();
  let counter = 0;

  const flushSlot = (): void => {
    if (slot) items.push(slot.item);
    slot = null;
  };
  const flushTools = (): void => {
    for (const item of openTools.values()) items.push(item);
    openTools.clear();
  };
  const flushTurn = (): void => {
    flushSlot();
    flushTools();
    if (items.length > 0) turns.push({ turnId: `hist_${++counter}`, status: "completed", items });
    items = [];
  };
  const appendText = (kind: TextSlotKind, item: Item, text: string): void => {
    if (slot?.kind !== kind) {
      if (kind === "user") flushTurn();
      else flushSlot();
      slot = { kind, item };
    }
    slot.item = applyDelta(slot.item, "text", text);
  };

  for (const update of updates) {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        appendText("user", { id: `hist_user_${++counter}`, kind: "message", role: "user", text: "", status: "completed" }, textOf(update.content));
        break;
      case "agent_message_chunk":
        appendText("agent", { id: `hist_msg_${++counter}`, kind: "message", role: "assistant", text: "", status: "completed" }, textOf(update.content));
        break;
      case "agent_thought_chunk":
        appendText("thought", { id: `hist_think_${++counter}`, kind: "reasoning", text: "", status: "completed" }, textOf(update.content));
        break;
      case "tool_call":
        flushSlot();
        openTools.set(update.toolCallId, mapToolCallStart(update, cwd));
        break;
      case "tool_call_update": {
        const existing = openTools.get(update.toolCallId);
        if (!existing) break;
        const updated = mapToolCallUpdate(existing, update, cwd);
        if (update.status === "completed" || update.status === "failed") {
          openTools.delete(update.toolCallId);
          items.push(updated);
        } else {
          openTools.set(update.toolCallId, updated);
        }
        break;
      }
      default:
        break; // session_info_update, available_commands_update, current_mode_update, usage_update, config_option_update, plan
    }
  }
  flushTurn();
  return turns;
}

function textOf(content: ContentBlock): string {
  return content.type === "text" && typeof (content as { text?: unknown }).text === "string" ? (content as { text: string }).text : "";
}
