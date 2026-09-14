/**
 * Short form of a shell command for the timeline: the inner command of a
 * PowerShell `-Command '...'` or `sh -lc '...'` wrapper, or the single parsed
 * action when the provider supplies one. Undefined when there is nothing shorter.
 */
export function displayCommand(command: string, actions?: readonly { command: string }[]): string | undefined {
  const single = actions?.length === 1 ? actions[0]?.command : undefined;
  const shown = single ?? unwrapShell(command);
  return shown && shown.trim() !== command.trim() ? shown : undefined;
}

const POWERSHELL = /^(?:"[^"]*\\?(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+)*?-Command\s+(['"])([\s\S]*)\1\s*$/i;
const POSIX_SHELL = /^\S*\/?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/;

function unwrapShell(command: string): string | undefined {
  const match = POWERSHELL.exec(command) ?? POSIX_SHELL.exec(command);
  if (!match) return undefined;
  const [, quote, inner = ""] = match;
  // Inside single quotes PowerShell doubles a quote to escape it.
  return quote === "'" && POWERSHELL.test(command) ? inner.replaceAll("''", "'") : inner;
}
