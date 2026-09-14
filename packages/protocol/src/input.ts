import { z } from "zod";
import { FileChange } from "./items.js";

/** What a decision does. The host maps it back to the provider's own vocabulary. */
export const DecisionEffect = z.enum(["allow", "allow_session", "deny", "cancel"]);
export type DecisionEffect = z.infer<typeof DecisionEffect>;

export const Decision = z.object({
  id: z.string(),
  label: z.string(),
  effect: DecisionEffect,
});
export type Decision = z.infer<typeof Decision>;

export const Question = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof Question>;

export const InputKind = z.enum([
  "command_approval",
  "file_approval",
  "tool_approval",
  "question",
  "plan_approval",
]);
export type InputKind = z.infer<typeof InputKind>;

/**
 * Anything that blocks a turn until a person answers. The host decides which
 * decisions exist; clients render them and reply with a decisionId.
 */
export const InputRequest = z.object({
  requestId: z.string(),
  kind: InputKind,
  /** The item this request is about, when there is one. */
  itemId: z.string().optional(),
  title: z.string(),
  body: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  changes: z.array(FileChange).optional(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  questions: z.array(Question).optional(),
  decisions: z.array(Decision).min(1),
});
export type InputRequest = z.infer<typeof InputRequest>;
