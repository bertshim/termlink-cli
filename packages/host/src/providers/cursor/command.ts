import { findOnPath } from "../../util/which.js";

/** How to launch cursor-agent: `file [...args] acp`. */
export interface CursorCommand {
  file: string;
  args: string[];
  /**
   * The official installer puts a `.cmd`/`.ps1` launcher on PATH (which chains to
   * `powershell.exe`, which then execs the real `node.exe` on the resolved version's
   * `index.js`). Node's spawn cannot exec a `.cmd` directly, so it needs a shell — see
   * acp-server.ts, which also has to kill the whole tree rather than just this process.
   */
  shell: boolean;
}

/** Finds the `cursor-agent` the user already installed via `cursor-agent login`. */
export function resolveCursorCommand(env: NodeJS.ProcessEnv = process.env): CursorCommand | null {
  const override = env.TERMLINK_CURSOR_PATH;
  if (override) return { file: override, args: [], shell: process.platform === "win32" };
  const binary = process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
  const found = findOnPath(binary, env);
  return found ? { file: found, args: [], shell: process.platform === "win32" } : null;
}
