import { z } from "zod";
import { HostInfo, PROTOCOL_VERSION, SessionInfo, TerminalSize } from "./common.js";
import { DecisionEffect, InputRequest } from "./input.js";
import { DeltaField, Item } from "./items.js";

const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("evt"),
    type: z.literal(type),
    ts: z.number(),
    sessionId: z.string().optional(),
    /** Present only on durable session events; increases by one per session. */
    seq: z.number().int().positive().optional(),
    payload,
  });

export const Usage = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

// Host channel: delivered to every connection, never sequenced.
export const HostReadyEvent = event("host.ready", HostInfo);
export const SessionCreatedEvent = event("session.created", z.object({ session: SessionInfo }));
export const SessionUpdatedEvent = event("session.updated", z.object({ session: SessionInfo }));
export const SessionClosedEvent = event(
  "session.closed",
  z.object({
    session: SessionInfo,
    reason: z.string().nullable(),
    /** Terminal sessions: how the shell exited. Null when it was killed. */
    exitCode: z.number().int().nullable().optional(),
  }),
);

// Session channel: delivered to connections attached to the session.
export const TurnStartedEvent = event(
  "turn.started",
  z.object({
    turnId: z.string(),
    /** The user message item that opened this turn. It arrives just before, with turnId null. */
    userItemId: z.string().optional(),
  }),
);
export const TurnCompletedEvent = event(
  "turn.completed",
  z.object({
    turnId: z.string(),
    status: z.enum(["completed", "interrupted", "failed"]),
    usage: Usage.optional(),
    error: z.string().optional(),
  }),
);
export const ItemStartedEvent = event(
  "item.started",
  z.object({ turnId: z.string().nullable(), item: Item }),
);
export const ItemDeltaEvent = event(
  "item.delta",
  z.object({ itemId: z.string(), field: DeltaField, delta: z.string() }),
);
/** Full snapshot of an item still in progress. Used for catch-up after attach. */
export const ItemUpdatedEvent = event("item.updated", z.object({ item: Item }));
/** Final, authoritative state of an item. May arrive without a matching item.started. */
export const ItemCompletedEvent = event(
  "item.completed",
  z.object({ turnId: z.string().nullable(), item: Item }),
);
export const InputRequiredEvent = event("input.required", z.object({ request: InputRequest }));
export const InputResolvedEvent = event(
  "input.resolved",
  z.object({
    requestId: z.string(),
    decisionId: z.string().nullable(),
    effect: DecisionEffect,
    by: z.enum(["user", "policy", "host"]),
  }),
);
export const ErrorEvent = event("error", z.object({ code: z.string(), message: z.string() }));
/** Provider-specific data with no common shape yet. Clients may ignore it. */
export const ProviderEvent = event("provider.event", z.object({ name: z.string(), data: z.unknown() }));

// Terminal channel: delivered to connections attached to a terminal session. Never sequenced.
/** The PTY size changed. */
export const TerminalSizeEvent = event("terminal.size", TerminalSize);
/**
 * Clear your terminal: the whole screen follows as output bytes. Sent to everyone
 * attached when a client attaches, since the relay cannot address one client.
 */
export const TerminalResetEvent = event("terminal.reset", TerminalSize);

export const AgentEvent = z.discriminatedUnion("type", [
  HostReadyEvent,
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionClosedEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  ItemStartedEvent,
  ItemDeltaEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  InputRequiredEvent,
  InputResolvedEvent,
  ErrorEvent,
  ProviderEvent,
  TerminalSizeEvent,
  TerminalResetEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type EventType = AgentEvent["type"];
export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;
export type EventPayload<T extends EventType> = EventOf<T>["payload"];

/** Session events that get a seq and are kept for replay. Everything else is ephemeral. */
export const DURABLE_EVENT_TYPES = [
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "input.required",
  "input.resolved",
  "error",
] as const satisfies readonly EventType[];

const durable = new Set<string>(DURABLE_EVENT_TYPES);

export function isDurableEvent(type: EventType): boolean {
  return durable.has(type);
}
