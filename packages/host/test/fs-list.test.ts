import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";

// listDirectory (protocol `fs.list`) lets a client browse to a session.create cwd
// instead of typing it. It shares #resolveCwd's allowed-roots check — a browsed
// path is the same remote choice, made one step earlier.

function tree(): { base: string; repo: string; other: string } {
  const base = mkdtempSync(path.join(tmpdir(), "tl-fslist-"));
  const repo = path.join(base, "repo");
  const other = path.join(base, "Other");
  mkdirSync(repo);
  mkdirSync(other);
  mkdirSync(path.join(base, ".git")); // hidden — never listed
  writeFileSync(path.join(base, "README.md"), "hi"); // a file — never listed
  mkdirSync(path.join(repo, "src"));
  return { base, repo, other };
}

test("lists a root's own subfolders: hidden folders and files left out, sorted case-insensitively", async () => {
  const { base } = tree();
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], allowedRoots: [base] });
  try {
    const listed = await manager.listDirectory();
    assert.equal(listed.path, realpathSync(base));
    assert.deepEqual(
      listed.entries.map((e) => e.name),
      ["Other", "repo"],
    );
    assert.equal(listed.entries[0]?.path, realpathSync(path.join(base, "Other")));
    // The root itself: nothing above it is this host's to show.
    assert.equal(listed.parent, null);
  } finally {
    await manager.shutdown();
  }
});

test("a subfolder's parent is the folder above it, up to but not past the root", async () => {
  const { base, repo } = tree();
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], allowedRoots: [base] });
  try {
    const listed = await manager.listDirectory(repo);
    assert.equal(listed.path, realpathSync(repo));
    assert.deepEqual(listed.entries.map((e) => e.name), ["src"]);
    assert.equal(listed.parent, realpathSync(base));

    const deeper = await manager.listDirectory(listed.entries[0]!.path);
    assert.equal(deeper.entries.length, 0);
    assert.equal(deeper.parent, realpathSync(repo));
  } finally {
    await manager.shutdown();
  }
});

test("a folder outside the allowed roots is refused, same as session.create", async () => {
  const { base } = tree();
  const outside = mkdtempSync(path.join(tmpdir(), "tl-fslist-outside-"));
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], allowedRoots: [base] });
  try {
    await assert.rejects(manager.listDirectory(outside), { code: "forbidden" });
  } finally {
    await manager.shutdown();
  }
});

test("a missing folder or a file is bad_request, not an empty listing", async () => {
  const { base, repo } = tree();
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], allowedRoots: [base] });
  try {
    await assert.rejects(manager.listDirectory(path.join(base, "missing")), { code: "bad_request" });
    await assert.rejects(manager.listDirectory(path.join(repo, "..", "README.md")), { code: "bad_request" });
  } finally {
    await manager.shutdown();
  }
});

test("without roots, no path starts at the host's home folder, and going up is allowed", async () => {
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  try {
    const listed = await manager.listDirectory();
    assert.equal(listed.path, realpathSync(os.homedir()));

    const { repo, base } = tree();
    const explicit = await manager.listDirectory(repo);
    assert.equal(explicit.path, realpathSync(repo));
    assert.equal(explicit.parent, realpathSync(base));
  } finally {
    await manager.shutdown();
  }
});
