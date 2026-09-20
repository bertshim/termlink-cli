import { applyDelta, type Item } from "@termlink/protocol";
import type { HistoryTurn } from "../types.js";
import { mapToolCallStart, mapToolCallUpdate } from "./mapper.js";
import type { ContentBlock, SessionUpdate } from "./protocol.js";

type TextSlotKind = "user" | "agent" | "thought";

/**
 * Turns cursor-agent's own replay of a session — the session/update notifications
 * session/load fires before it resolves, see protocol.ts's own note on that — into
 * TermLink's HistoryTurn[], the same shape Codex's history() reads back from
 * thread/turns/list.
 *
 * Live-verified only for plain-text turns (measured against a real two-turn session,
 * reconnected with a fresh process). A replayed tool call is assumed to repeat the exact
 * tool_call/tool_call_update pair a live turn gets, correlated the same way by toolCallId —
 * the only sane reading of "replay" — but that assumption has not been checked against a
 * real tool-using turn's replay, only inferred from how the live path behaves.
 *
 * cursor-agent reports no per-turn outcome in the replay itself (no equivalent of Codex's
 * turn.status), so every historical turn is marked "completed" here even if the original
 * was interrupted or failed — a cosmetic gap: the transcript text is still right, just not
 * whether it stopped early. The "plan" update (a todo list) is not carried into history
 * either; it is transient chrome for a turn in progress, not something worth restoring
 * after the fact.
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
      // A user message closes the turn before it (a fresh prompt); an agent message or
      // thought only closes whichever of the other two was open, same as the live session.
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
        break; // session_info_update, available_commands_update, current_mode_update, plan
    }
  }
  flushTurn();
  return turns;
}

function textOf(content: ContentBlock): string {
  return content.type === "text" && typeof (content as { text?: unknown }).text === "string" ? (content as { text: string }).text : "";
}
