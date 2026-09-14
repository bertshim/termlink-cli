import { performance } from "node:perf_hooks";
import type { HostMessage } from "@termlink/protocol";

type DeltaEvent = Extract<HostMessage, { kind: "evt"; type: "item.delta" }>;

/**
 * Merges item.delta events for the same item and field, so a streaming reply is not
 * one relay frame per token, without holding back the start of anything:
 * - the first delta of an item, and any delta after a quiet spell of at least the
 *   window, go out at once (leading edge);
 * - deltas that follow within the window are merged and sent when it ends.
 * Any other message flushes first, so ordering is preserved.
 */
export class DeltaCoalescer {
  readonly #send: (message: HostMessage) => void;
  readonly #windowMs: number;
  readonly #now: () => number;
  #pending: DeltaEvent | null = null;
  #pendingKey = "";
  #timer: NodeJS.Timeout | null = null;
  /** When a delta last went out, and for which item and field. */
  #lastAt = Number.NEGATIVE_INFINITY;
  #lastKey = "";

  constructor(send: (message: HostMessage) => void, windowMs = 30, now: () => number = () => performance.now()) {
    this.#send = send;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  push(message: HostMessage): void {
    if (message.kind === "evt" && message.type === "item.delta") {
      const key = `${message.sessionId ?? ""}\u0000${message.payload.itemId}\u0000${message.payload.field}`;
      const pending = this.#pending;
      if (pending && this.#pendingKey === key) {
        pending.payload = { ...pending.payload, delta: pending.payload.delta + message.payload.delta };
        return;
      }
      this.flush();
      const now = this.#now();
      if (key !== this.#lastKey || now - this.#lastAt >= this.#windowMs) {
        this.#sendDelta(message, key, now);
        return;
      }
      this.#pending = { ...message, payload: { ...message.payload } };
      this.#pendingKey = key;
      this.#timer = setTimeout(() => this.flush(), Math.max(0, this.#lastAt + this.#windowMs - now));
      return;
    }
    this.flush();
    this.#send(message);
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#sendDelta(pending, this.#pendingKey, this.#now());
  }

  /** Drops anything pending without sending it. */
  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }

  #sendDelta(message: DeltaEvent, key: string, now: number): void {
    this.#lastAt = now;
    this.#lastKey = key;
    this.#send(message);
  }
}
