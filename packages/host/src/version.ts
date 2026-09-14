import { createRequire } from "node:module";

// The package's own version, so `termlink --version` and host.ready say what npm installed.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION: string = version;
