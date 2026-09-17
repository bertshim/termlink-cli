#!/usr/bin/env node
// The `termlink` command. It checks the Node.js version before anything else is loaded,
// so an older Node.js gets a clear message instead of failing somewhere inside the host.
// Keep this file free of other imports: they would load before the check could run.
import { nodeVersionProblem } from "./node-version.js";

const problem = nodeVersionProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}
await import("./cli.js");
