import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LockHeldError, acquirePidLock } from "../src/util/lock.js";

test("a lock held by a live process is refused until it is released", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tl-lock-")), "relay-x.lock");
  const release = await acquirePidLock(file);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));

  // Another host asking while this process is alive.
  await assert.rejects(acquirePidLock(file, process.pid + 1), (err: unknown) => {
    assert.ok(err instanceof LockHeldError);
    assert.equal(err.pid, process.pid);
    return true;
  });

  await release();
  assert.equal(existsSync(file), false);
  const again = await acquirePidLock(file, process.pid + 1);
  await again();
});

test("a lock left by a process that is gone is taken over", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tl-lock-")), "relay-x.lock");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(gone);
  writeFileSync(file, `${gone}\n`);

  const release = await acquirePidLock(file);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
  await release();
});

test("release leaves a lock that another process has since taken", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tl-lock-")), "relay-x.lock");
  const release = await acquirePidLock(file);
  writeFileSync(file, `${process.pid + 1}\n`);

  await release();
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid + 1));
});
