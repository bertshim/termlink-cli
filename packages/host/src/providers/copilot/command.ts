import { findOnPath } from "../../util/which.js";

/** How to launch copilot: `file [...args] --acp`. */
export interface CopilotCommand {
  file: string;
  args: string[];
  /** npm's own global-install shim is a `.cmd` on Windows (a plain `node ... npm-loader.js`
   *  chain, one hop shorter than cursor-agent's own cmd->powershell->node — see that
   *  command.ts's comment), which Node's spawn cannot exec directly without a shell. */
  shell: boolean;
}

/** Finds the `copilot` the user already installed and logged in with (`copilot login`). */
export function resolveCopilotCommand(env: NodeJS.ProcessEnv = process.env): CopilotCommand | null {
  const override = env.TERMLINK_COPILOT_PATH;
  if (override) return { file: override, args: [], shell: process.platform === "win32" };
  const binary = process.platform === "win32" ? "copilot.cmd" : "copilot";
  const found = findOnPath(binary, env);
  return found ? { file: found, args: [], shell: process.platform === "win32" } : null;
}
