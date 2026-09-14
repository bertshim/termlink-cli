import { createRequire } from "node:module";
import type * as NodePty from "@lydell/node-pty";

export type PtyModule = typeof NodePty;
export type { IPty } from "@lydell/node-pty";

/** The PTY binary for this platform is missing. The host runs without terminals then. */
export class PtyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtyUnavailableError";
  }
}

const require = createRequire(import.meta.url);
let loaded: { module: PtyModule } | { error: string } | null = null;

/**
 * Loads @lydell/node-pty once. It ships a prebuilt binary per platform as an optional
 * dependency, so nothing is compiled on the user's machine; on an unsupported platform
 * (or an install that skipped optional dependencies) the require fails and the error
 * says so.
 */
export function loadPty(): PtyModule {
  loaded ??= tryLoad();
  if ("error" in loaded) throw new PtyUnavailableError(loaded.error);
  return loaded.module;
}

export function ptyStatus(): { available: boolean; detail: string | null } {
  loaded ??= tryLoad();
  return "error" in loaded ? { available: false, detail: loaded.error } : { available: true, detail: null };
}

function tryLoad(): { module: PtyModule } | { error: string } {
  try {
    return { module: require("@lydell/node-pty") as PtyModule };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
    return { error: `terminal support is not available on ${process.platform}-${process.arch}: ${message}` };
  }
}
