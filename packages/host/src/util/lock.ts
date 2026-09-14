import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Another live process holds the lock. */
export class LockHeldError extends Error {
  readonly pid: number;

  constructor(file: string, pid: number) {
    super(`${file} is held by process ${pid}`);
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function holder(file: string): Promise<number | null> {
  const pid = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Takes a lock file holding this process's pid. A lock left behind by a process that is
 * gone (killed, crashed) is taken over. Returns a release that removes the file only while
 * it is still ours.
 */
export async function acquirePidLock(file: string, pid = process.pid): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return async () => {
        if ((await holder(file)) === pid) await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const current = await holder(file);
      if (current !== null && current !== pid && alive(current)) throw new LockHeldError(file, current);
      await rm(file, { force: true });
    }
  }
  throw new Error(`could not take the lock ${file}`);
}
