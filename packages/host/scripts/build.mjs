// Builds the host as one JavaScript file, for running from a checkout without a build step:
//
//   npm run bundle -w @termlink/cli   dist/bundle/termlink.mjs (needs Node 22+)
//
// The PTY binary and the headless terminal stay outside the bundle: the first is a
// native module chosen per platform at install time, the second is loaded by the
// same require. Both come from node_modules next to the bundle. The npm package is
// the distribution; there is no single-executable build (it cannot carry the PTY).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "bundle", "termlink.mjs");

await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["source"],
  external: ["@lydell/node-pty", "@xterm/headless", "@xterm/addon-serialize"],
  legalComments: "none",
  logLevel: "warning",
  outfile,
  // Bundled CommonJS dependencies (ws) need a real require.
  banner: { js: 'import { createRequire as __tlCreateRequire } from "node:module"; const require = __tlCreateRequire(import.meta.url);' },
});
console.log(`bundle: ${path.relative(root, outfile)}`);
