import { loadPty, type IPty } from "./pty.js";
import { Screen } from "./screen.js";
import { defaultShell } from "./shell.js";

export interface TerminalOptions {
  /** Shell executable. Defaults to the user's shell (see defaultShell). */
  shell?: string | undefined;
  /** Arguments for the shell. Defaults depend on the shell chosen. */
  args?: string[] | undefined;
  cwd: string;
  /** Added on top of the host process environment. */
  env?: Record<string, string> | undefined;
  cols: number;
  rows: number;
  /** Lines kept above the screen for reconnects. Default 5000. */
  scrollback?: number | undefined;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number | undefined;
}

export interface Terminal {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  /** Set once the shell has exited. */
  readonly exit: TerminalExit | null;
  /** Keyboard input, pasted text, control bytes such as 0x03 for Ctrl+C. */
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  /** Output as the shell wrote it. */
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exit: TerminalExit) => void): () => void;
  /** The current screen and scrollback as bytes a terminal can write after a reset. */
  snapshot(): Promise<Uint8Array>;
  /** Stops reading from the shell, so it blocks on its next write. For flow control. */
  pause(): void;
  resume(): void;
  /** Ends the shell. onExit follows. */
  kill(): void;
}

const DEFAULT_SCROLLBACK = 5000;
const encoder = new TextEncoder();

/** Starts a shell in a PTY. Throws PtyUnavailableError when this platform has no PTY binary. */
export function createTerminal(options: TerminalOptions): Terminal {
  const pty = loadPty();
  const shell = options.shell ? { file: options.shell, args: options.args ?? [] } : defaultShell();
  const args = options.args ?? shell.args;
  const child = pty.spawn(shell.file, args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnv(options.env),
  });
  return new PtyTerminal(child, options.cols, options.rows, options.scrollback ?? DEFAULT_SCROLLBACK);
}

/** What the shell inherits: the host's environment plus what a terminal expects. */
export function terminalEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "termlink";
  if (process.platform !== "win32" && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
    env.LANG = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  }
  return { ...env, ...extra };
}

class PtyTerminal implements Terminal {
  readonly pid: number;
  readonly #pty: IPty;
  readonly #screen: Screen;
  readonly #decoder = new TextDecoder("utf-8");
  readonly #dataListeners = new Set<(data: Uint8Array) => void>();
  readonly #exitListeners = new Set<(exit: TerminalExit) => void>();
  #cols: number;
  #rows: number;
  #exit: TerminalExit | null = null;

  constructor(pty: IPty, cols: number, rows: number, scrollback: number) {
    this.#pty = pty;
    this.pid = pty.pid;
    this.#cols = cols;
    this.#rows = rows;
    this.#screen = new Screen(cols, rows, scrollback);
    pty.onData((text) => {
      this.#screen.write(text);
      const bytes = encoder.encode(text);
      for (const listener of this.#dataListeners) listener(bytes);
    });
    pty.onExit((exit) => {
      this.#exit = { exitCode: exit.exitCode, signal: exit.signal };
      // On Windows the ConPTY worker stays referenced after the child exits until the
      // pty is killed, which would keep the host process alive. Harmless elsewhere.
      try {
        pty.kill();
      } catch {
        // Already released.
      }
      for (const listener of this.#exitListeners) listener(this.#exit);
      this.#exitListeners.clear();
      this.#dataListeners.clear();
      this.#screen.dispose();
    });
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  get exit(): TerminalExit | null {
    return this.#exit;
  }

  write(data: Uint8Array | string): void {
    if (this.#exit) return;
    // A multi-byte character split across two frames is joined here.
    this.#pty.write(typeof data === "string" ? data : this.#decoder.decode(data, { stream: true }));
  }

  resize(cols: number, rows: number): void {
    if (this.#exit || (cols === this.#cols && rows === this.#rows)) return;
    this.#cols = cols;
    this.#rows = rows;
    this.#pty.resize(cols, rows);
    this.#screen.resize(cols, rows);
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onExit(listener: (exit: TerminalExit) => void): () => void {
    if (this.#exit) {
      listener(this.#exit);
      return () => {};
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async snapshot(): Promise<Uint8Array> {
    if (this.#exit) return new Uint8Array();
    return encoder.encode(await this.#screen.snapshot());
  }

  pause(): void {
    if (!this.#exit) this.#pty.pause();
  }

  resume(): void {
    if (!this.#exit) this.#pty.resume();
  }

  kill(): void {
    if (this.#exit) return;
    try {
      this.#pty.kill();
    } catch {
      // Already gone.
    }
  }
}
