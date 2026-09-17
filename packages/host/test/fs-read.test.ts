import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FS_READ_MAX_BYTES } from "@termlink/protocol";
import { SessionManager } from "../src/session/manager.js";
import { FakeProvider } from "./fixtures/fake-provider.js";

// readFile (protocol `fs.read`) lets a client preview a file an agent mentioned, such as a
// screenshot it saved. It makes the same allowed-folder check as fs.list and session.create.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tree(): { base: string; shot: string; notes: string; blob: string; folder: string } {
  const base = mkdtempSync(path.join(tmpdir(), "tl-fsread-"));
  const folder = path.join(base, "out");
  mkdirSync(folder);
  const shot = path.join(folder, "shot.png");
  const notes = path.join(base, "notes.md");
  const blob = path.join(base, "data.bin");
  writeFileSync(shot, PNG);
  writeFileSync(notes, "# Notes\n");
  writeFileSync(blob, Buffer.from([1, 2, 3]));
  return { base, shot, notes, blob, folder };
}

const open = (roots?: string[]) =>
  new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], ...(roots ? { allowedRoots: roots } : {}) });

test("a file inside the allowed folders comes back whole, typed by its extension", async () => {
  const { base, shot, notes, blob } = tree();
  const manager = open([base]);
  try {
    const read = await manager.readFile(shot);
    assert.equal(read.path, realpathSync(shot));
    assert.equal(read.mimeType, "image/png");
    assert.equal(read.size, PNG.length);
    assert.deepEqual(Buffer.from(read.dataBase64, "base64"), PNG);
    assert.equal((await manager.readFile(notes)).mimeType, "text/markdown");
    // Anything unrecognised is offered as a download, not rendered.
    assert.equal((await manager.readFile(blob)).mimeType, "application/octet-stream");
  } finally {
    await manager.shutdown();
  }
});

test("a relative path is taken from the first allowed folder", async () => {
  const { base, notes } = tree();
  const manager = open([base]);
  try {
    const read = await manager.readFile("notes.md");
    assert.equal(read.path, realpathSync(notes));
    assert.equal(Buffer.from(read.dataBase64, "base64").toString("utf8"), "# Notes\n");
  } finally {
    await manager.shutdown();
  }
});

test("a file outside the allowed folders is refused", async () => {
  const { base } = tree();
  const outside = path.join(mkdtempSync(path.join(tmpdir(), "tl-fsread-outside-")), "secret.txt");
  writeFileSync(outside, "no");
  const manager = open([base]);
  try {
    await assert.rejects(manager.readFile(outside), { code: "forbidden" });
    // Climbing out with .. is the same path, and the same answer.
    await assert.rejects(manager.readFile(path.join(base, "..", path.basename(path.dirname(outside)), "secret.txt")), {
      code: "forbidden",
    });
  } finally {
    await manager.shutdown();
  }
});

test("a folder or a missing path is bad_request", async () => {
  const { base, folder } = tree();
  const manager = open([base]);
  try {
    await assert.rejects(manager.readFile(folder), { code: "bad_request" });
    await assert.rejects(manager.readFile(path.join(base, "missing.txt")), { code: "bad_request" });
  } finally {
    await manager.shutdown();
  }
});

test("a file over the preview limit is refused without reading it", async () => {
  const { base } = tree();
  const big = path.join(base, "big.log");
  writeFileSync(big, Buffer.alloc(FS_READ_MAX_BYTES + 1));
  const manager = open([base]);
  try {
    await assert.rejects(manager.readFile(big), { code: "bad_request", message: /preview limit/ });
  } finally {
    await manager.shutdown();
  }
});
