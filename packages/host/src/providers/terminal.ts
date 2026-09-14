import { TERMINAL_PROVIDER } from "@termlink/protocol";
import { createTerminal, defaultShell, ptyStatus, type Terminal } from "@termlink/terminal";
import type { OpenTerminalOptions, ProbeResult, TerminalProvider } from "./types.js";

export interface ShellProviderOptions {
  /** Shell executable. Defaults to the user's shell. */
  shell?: string | undefined;
  /** Arguments for the shell, when `shell` is set. */
  args?: string[] | undefined;
  /** Lines kept above the screen for reconnects. */
  scrollback?: number | undefined;
}

/**
 * The terminal provider: opens the user's shell in a PTY, like an ssh login. Its
 * availability is whether this platform has a PTY binary; nothing else to check.
 */
export class ShellProvider implements TerminalProvider {
  readonly id = TERMINAL_PROVIDER;
  readonly kind = "terminal" as const;
  readonly label = "Terminal";
  readonly #options: ShellProviderOptions;

  constructor(options: ShellProviderOptions = {}) {
    this.#options = options;
  }

  async probe(): Promise<ProbeResult> {
    const status = ptyStatus();
    if (!status.available) return { available: false, version: null, detail: status.detail };
    const shell = this.#options.shell ?? defaultShell().file;
    return { available: true, version: null, detail: shell };
  }

  async open(options: OpenTerminalOptions): Promise<Terminal> {
    return createTerminal({
      shell: this.#options.shell,
      args: this.#options.args,
      scrollback: this.#options.scrollback,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
    });
  }
}
