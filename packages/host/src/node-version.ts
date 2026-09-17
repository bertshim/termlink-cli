/** The oldest Node.js major version termlink runs on. Keep it in step with "engines" in package.json. */
export const MIN_NODE_MAJOR = 22;

/**
 * Why this Node.js cannot run termlink, as lines to print, or null when it can.
 *
 * npm only warns (EBADENGINE) when a package asks for a newer Node.js than the one
 * installing it, and installs it anyway. Without this check an older Node.js would get
 * as far as loading the host and fail later with an error that says nothing about why.
 */
export function nodeVersionProblem(version: string = process.versions.node, execPath: string = process.execPath): string | null {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null;
  const which = process.platform === "win32" ? "where node" : "which -a node";
  return [
    `termlink needs Node.js ${MIN_NODE_MAJOR} or later, but it was started with Node.js ${version.replace(/^v/, "")}`,
    `  (${execPath}).`,
    "",
    `Install Node.js ${MIN_NODE_MAJOR} or later (the current LTS) from https://nodejs.org/, then run:`,
    "  npm install -g @termlink/cli",
    "",
    `If a newer Node.js is already installed, an older one comes first on your PATH: \`${which}\` lists them in order.`,
  ].join("\n");
}
