/** Push-driven async iterable: the SDK reads user messages from it for the life of the session. */
export class InputQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #wake: (() => void) | null = null;
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    this.#items.push(item);
    this.#notify();
  }

  end(): void {
    this.#ended = true;
    this.#notify();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
