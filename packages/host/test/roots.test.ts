import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";

test("sessions open only inside the allowed roots; relative paths use the first root", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "tl-roots-"));
  mkdirSync(path.join(base, "repo"));
  mkdirSync(path.join(base, "..sibling-looking"));
  const outside = mkdtempSync(path.join(tmpdir(), "tl-outside-"));
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], allowedRoots: [base] });
  try {
    assert.deepEqual(manager.roots, [path.resolve(base)]);

    const inRepo = await manager.createAgent({ provider: "fake", cwd: "repo" });
    assert.equal(inRepo.info.cwd, realpathSync(path.join(base, "repo")));

    // A folder whose name merely starts with ".." is still inside.
    await manager.createAgent({ provider: "fake", cwd: "..sibling-looking" });

    await assert.rejects(manager.createAgent({ provider: "fake", cwd: outside }), { code: "forbidden" });
    await assert.rejects(manager.createAgent({ provider: "fake", cwd: `../${path.basename(outside)}` }), {
      code: "forbidden",
    });
    await assert.rejects(manager.createAgent({ provider: "fake", cwd: "missing" }), { code: "bad_request" });
  } finally {
    await manager.shutdown();
  }
});

test("without roots any existing folder is accepted", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  try {
    assert.equal(manager.roots, undefined);
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    assert.equal(session.info.cwd, realpathSync(tmpdir()));
  } finally {
    await manager.shutdown();
  }
});
