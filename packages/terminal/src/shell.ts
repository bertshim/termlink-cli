import { existsSync } from "node:fs";
import path from "node:path";

export interface ShellCommand {
  file: string;
  args: string[];
}

/**
 * The shell a terminal session runs when none is configured: like an ssh login, the
 * user's own shell. Windows prefers PowerShell 7 (pwsh), then Windows PowerShell,
 * then cmd. Elsewhere $SHELL, then bash, then sh, as a login shell.
 */
export function defaultShell(platform = process.platform, env: NodeJS.ProcessEnv = process.env): ShellCommand {
  if (platform === "win32") {
    const pwsh = findOnPath("pwsh.exe", env);
    if (pwsh) return { file: pwsh, args: ["-NoLogo"] };
    const system = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(powershell)) return { file: powershell, args: ["-NoLogo"] };
    return { file: path.join(system, "System32", "cmd.exe"), args: [] };
  }
  const own = env.SHELL;
  if (own && existsSync(own)) return { file: own, args: ["-l"] };
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (existsSync(candidate)) return { file: candidate, args: ["-l"] };
  }
  return { file: "sh", args: ["-l"] };
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const entries = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
