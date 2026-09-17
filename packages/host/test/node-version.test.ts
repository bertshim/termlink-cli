import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { MIN_NODE_MAJOR, nodeVersionProblem } from "../src/node-version.js";
import { VERSION } from "../src/version.js";

test("an older Node.js is refused with what was found and how to fix it", () => {
  const problem = nodeVersionProblem("20.19.5", "C:\\old\\node.exe");
  assert.ok(problem);
  assert.match(problem, new RegExp(`needs Node\\.js ${MIN_NODE_MAJOR} or later`));
  assert.match(problem, /Node\.js 20\.19\.5/);
  assert.match(problem, /C:\\old\\node\.exe/);
  assert.match(problem, /https:\/\/nodejs\.org\//);
  assert.match(problem, /npm install -g @termlink\/cli/);
  assert.match(problem, /where node|which -a node/);
  assert.match(nodeVersionProblem("v18.0.0", "/usr/bin/node") ?? "", /Node\.js 18\.0\.0/);
});

test("Node.js 22 and later pass", () => {
  assert.equal(nodeVersionProblem("22.0.0"), null);
  assert.equal(nodeVersionProblem("24.18.1"), null);
  assert.equal(nodeVersionProblem(`v${MIN_NODE_MAJOR}.1.0`), null);
});

test("the termlink command checks the version and then runs the CLI", () => {
  const run = spawnSync(process.execPath, ["--conditions=source", "--import", "tsx", "src/bin.ts", "--version"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `termlink ${VERSION}`);
});
