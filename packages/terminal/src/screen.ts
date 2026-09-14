import { createRequire } from "node:module";

// Both are CommonJS bundles; a plain require works everywhere the ESM named-export
// detection might not.
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

/**
 * A headless copy of what the user's terminal shows. Every byte the shell writes goes
 * through here too, so a client that attaches later can be given the current screen
 * and scrollback instead of nothing. Pure JavaScript; the same on every platform.
 */
export class Screen {
  readonly #terminal: InstanceType<typeof HeadlessTerminal>;
  readonly #serializer: InstanceType<typeof SerializeAddon>;
  readonly #scrollback: number;

  constructor(cols: number, rows: number, scrollback: number) {
    this.#scrollback = scrollback;
    this.#terminal = new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer);
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  write(data: string): void {
    this.#terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
  }

  /** Waits for everything written so far to be parsed. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.#terminal.write("", resolve));
  }

  /**
   * The screen and scrollback as bytes a terminal can write after a reset to look the
   * same: text, colors, cursor position.
   */
  async snapshot(): Promise<string> {
    await this.flush();
    return this.#serializer.serialize({ scrollback: this.#scrollback });
  }

  dispose(): void {
    this.#terminal.dispose();
  }
}
