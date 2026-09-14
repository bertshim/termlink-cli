// Puts the Google OAuth desktop client into the built package, the way the Go build
// baked it into the binary: from a client_secret_*.json named by
// TERMLINK_GOOGLE_CLIENT_SECRET_FILE (or TERMLINK_GOOGLE_CLIENT_ID/_SECRET). The source
// file stays empty, so nothing is committed; only the published dist carries the values.
// Runs from prepublishOnly, after tsc. Refuses to continue without values, so a package
// whose `termlink login` cannot work is never published by accident.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist", "auth", "oauth-defaults.js");

let clientId = process.env.TERMLINK_GOOGLE_CLIENT_ID ?? "";
let clientSecret = process.env.TERMLINK_GOOGLE_CLIENT_SECRET ?? "";
const file = process.env.TERMLINK_GOOGLE_CLIENT_SECRET_FILE;
if (file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const section = parsed.installed ?? parsed.web;
  if (!section?.client_id) throw new Error(`${file} has no installed or web client`);
  clientId = section.client_id;
  clientSecret = section.client_secret ?? "";
}
if (!clientId) {
  console.error(
    "bake-oauth: no Google OAuth client. Set TERMLINK_GOOGLE_CLIENT_SECRET_FILE (a client_secret_*.json) " +
      "or TERMLINK_GOOGLE_CLIENT_ID and TERMLINK_GOOGLE_CLIENT_SECRET before publishing.",
  );
  process.exit(1);
}

const built = readFileSync(target, "utf8");
// Checked by pattern, not by comparing before and after: a dist baked by an earlier publish
// is not re-emitted by an incremental tsc, so the same values going in again is fine.
const ID = /export const DEFAULT_GOOGLE_CLIENT_ID = "[^"]*";/;
const SECRET = /export const DEFAULT_GOOGLE_CLIENT_SECRET = "[^"]*";/;
if (!ID.test(built) || !SECRET.test(built)) throw new Error(`${target} does not look like the built oauth-defaults module`);
const baked = built
  .replace(ID, `export const DEFAULT_GOOGLE_CLIENT_ID = ${JSON.stringify(clientId)};`)
  .replace(SECRET, `export const DEFAULT_GOOGLE_CLIENT_SECRET = ${JSON.stringify(clientSecret)};`);
writeFileSync(target, baked);
console.log(`bake-oauth: client ${clientId.slice(0, 12)}… baked into ${path.relative(root, target)}`);
