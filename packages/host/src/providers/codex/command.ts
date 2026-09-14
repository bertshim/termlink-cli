import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** How to launch codex: `file ...args <subcommand>`. */
export interface CodexCommand {
  file: string;
  args: string[];
}

const TARGET_TRIPLES: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

/**
 * Finds the codex the user already installed. Inside an npm install it returns the native
 * binary rather than the codex.js launcher: on Windows, killing the launcher would leave the
 * native process running.
 */
export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): CodexCommand | null {
  const override = env.TERMLINK_CODEX_PATH;
  if (override) {
    return override.endsWith(".js") ? { file: process.execPath, args: [override] } : { file: override, args: [] };
  }
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const native = nativeBinaryNear(dir);
    if (native) return { file: native, args: [] };
    const direct = path.join(dir, exe);
    if (existsSync(direct)) return { file: direct, args: [] };
  }
  return null;
}

// npm puts global packages in <prefix>/node_modules on Windows and <prefix>/lib/node_modules
// elsewhere, with the shims in <prefix> and <prefix>/bin respectively.
function nativeBinaryNear(dir: string): string | null {
  const triple = TARGET_TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) return null;
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  const candidates = [
    path.join(dir, "node_modules", "@openai", "codex", "package.json"),
    path.join(dir, "..", "lib", "node_modules", "@openai", "codex", "package.json"),
  ];
  for (const codexPackageJson of candidates) {
    if (!existsSync(codexPackageJson)) continue;
    try {
      const platformPackageJson = createRequire(codexPackageJson).resolve(`${platformPackage}/package.json`);
      const binary = path.join(
        path.dirname(platformPackageJson),
        "vendor",
        triple,
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex",
      );
      if (existsSync(binary)) return binary;
    } catch {
      // Platform package missing; fall back to whatever is on PATH.
    }
  }
  return null;
}
