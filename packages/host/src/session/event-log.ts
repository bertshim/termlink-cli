import type { AgentEvent } from "@termlink/protocol";

export interface LogSlice {
  events: AgentEvent[];
  /** True when events after the requested seq have already been evicted. */
  gap: boolean;
  /** Seq of the oldest event still held, or 0 when the log is empty. */
  oldestSeq: number;
}

/** Bounded buffer of one session's durable events, used to replay after a reconnect. */
export class EventLog {
  readonly capacity: number;
  #events: AgentEvent[] = [];

  constructor(capacity = 2000) {
    this.capacity = capacity;
  }

  append(event: AgentEvent): void {
    if (event.seq === undefined) throw new Error(`event ${event.type} has no seq`);
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#events.shift();
  }

  since(afterSeq: number): LogSlice {
    const oldestSeq = this.#events[0]?.seq ?? 0;
    const events = this.#events.filter((e) => (e.seq ?? 0) > afterSeq);
    return { events, gap: oldestSeq > 0 && afterSeq < oldestSeq - 1, oldestSeq };
  }
}
