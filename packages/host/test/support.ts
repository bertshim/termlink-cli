import type { AgentEvent, HostMessage } from "@termlink/protocol";

type Waiter<T> = { predicate: (value: T) => boolean; resolve: (value: T) => void };

/** Collects messages and lets a test wait for one that matches, including ones already received. */
export class Recorder<T = AgentEvent> {
  readonly items: T[] = [];
  #waiters: Waiter<T>[] = [];

  readonly push = (value: T): void => {
    this.items.push(value);
    this.#waiters = this.#waiters.filter((w) => {
      if (!w.predicate(value)) return true;
      w.resolve(value);
      return false;
    });
  };

  /** Resolves with the first match at or after index `from`. */
  waitFor(predicate: (value: T) => boolean, from = 0, timeoutMs = 3000): Promise<T> {
    const seen = this.items.slice(from).find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a matching message")), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }
}

export function seqs(messages: readonly (AgentEvent | HostMessage)[]): number[] {
  return messages.flatMap((m) => (m.kind === "evt" && m.seq !== undefined ? [m.seq] : []));
}
