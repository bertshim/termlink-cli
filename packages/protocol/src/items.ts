import { z } from "zod";

export const ItemStatus = z.enum(["in_progress", "completed", "failed", "declined", "interrupted"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

const itemBase = {
  id: z.string(),
  status: ItemStatus,
};

export const MessageItem = z.object({
  ...itemBase,
  kind: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /**
   * A user message sent while a turn ran (PROTOCOL.md, "Messages during a turn"): `queued` until the
   * agent has read it, then `read`; `dropped` if a Stop discarded it first. The item is
   * re-sent as item.completed at each change. Absent on every other message.
   */
  steer: z.enum(["queued", "read", "dropped"]).optional(),
});
export type MessageItem = z.infer<typeof MessageItem>;

export const ReasoningItem = z.object({
  ...itemBase,
  kind: z.literal("reasoning"),
  text: z.string(),
});
export type ReasoningItem = z.infer<typeof ReasoningItem>;

export const CommandItem = z.object({
  ...itemBase,
  kind: z.literal("command"),
  command: z.string(),
  /**
   * Short form for the timeline, e.g. without a PowerShell or `sh -lc` wrapper.
   * Absent when the command is already plain. Approvals always carry the full command.
   */
  display: z.string().optional(),
  cwd: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type CommandItem = z.infer<typeof CommandItem>;

export const FileChange = z.object({
  path: z.string(),
  action: z.enum(["add", "modify", "delete", "rename"]),
  movePath: z.string().optional(),
  /** Unified diff. Hosts compute it when the provider only reports old/new text. */
  diff: z.string().optional(),
});
export type FileChange = z.infer<typeof FileChange>;

export const FileChangeItem = z.object({
  ...itemBase,
  kind: z.literal("file_change"),
  changes: z.array(FileChange),
});
export type FileChangeItem = z.infer<typeof FileChangeItem>;

/** Any tool call that is not a shell command or a file edit (MCP, web search, ...). */
export const ToolItem = z.object({
  ...itemBase,
  kind: z.literal("tool"),
  name: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});
export type ToolItem = z.infer<typeof ToolItem>;

export const TodoItem = z.object({
  ...itemBase,
  kind: z.literal("todo"),
  entries: z.array(z.object({ text: z.string(), done: z.boolean() })),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const Item = z.discriminatedUnion("kind", [
  MessageItem,
  ReasoningItem,
  CommandItem,
  FileChangeItem,
  ToolItem,
  TodoItem,
]);
export type Item = z.infer<typeof Item>;
export type ItemKind = Item["kind"];

/** Which string field an item.delta appends to. */
export const DeltaField = z.enum(["text", "output"]);
export type DeltaField = z.infer<typeof DeltaField>;

/** Applies an item.delta to an item. Shared by host and clients so both accumulate the same way. */
export function applyDelta(item: Item, field: DeltaField, delta: string): Item {
  if (field === "text" && (item.kind === "message" || item.kind === "reasoning")) {
    return { ...item, text: item.text + delta };
  }
  if (field === "output" && item.kind === "command") {
    return { ...item, output: (item.output ?? "") + delta };
  }
  return item;
}
