import type { Item } from "@termlink/protocol";
import { stripSteerNote } from "../steer-note.js";
import type { HistoryTurn } from "../types.js";
import type { CodexAppServer } from "./app-server.js";
import { mapItem } from "./mapper.js";
import type { ThreadItem, Turn } from "./protocol.js";

/** Recent finished turns of a stored thread, oldest first, read with thread/turns/list. */
export async function codexHistory(server: CodexAppServer, threadId: string, maxTurns = 30): Promise<HistoryTurn[]> {
  const { data } = await server.peer.request<{ data: Turn[] }>("thread/turns/list", {
    threadId,
    sortDirection: "desc",
    itemsView: "full",
    limit: maxTurns,
  });
  const turns: HistoryTurn[] = [];
  for (const turn of [...data].reverse()) {
    if (turn.status === "inProgress") continue;
    const items = (turn.items ?? []).flatMap((item): Item[] => {
      if (item.type === "userMessage") {
        const text = userText(item);
        return text ? [{ id: item.id, kind: "message", role: "user", text, status: "completed" }] : [];
      }
      const mapped = mapItem(item, "completed");
      return mapped ? [mapped] : [];
    });
    turns.push({ turnId: turn.id, status: turn.status, items });
  }
  return turns;
}

export function userText(item: ThreadItem): string {
  const content = (item as { content?: { type?: string; text?: string }[] }).content ?? [];
  return stripSteerNote(
    content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n"),
  );
}
