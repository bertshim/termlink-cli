import { existsSync } from "node:fs";
import path from "node:path";

/** Absolute path of `binary` in the first PATH folder that has it, or null. */
export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) return path.resolve(candidate);
  }
  return null;
}
