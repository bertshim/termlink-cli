import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HostMessage, type CommandResults, type CommandType, type HostInfo } from "@termlink/protocol";
import { WebSocket } from "ws";
import { HostError } from "../src/errors.js";
import { startLocalServer } from "../src/server/local-server.js";
import { SessionManager } from "../src/session/manager.js";
import { UploadManager, cleanName } from "../src/session/uploads.js";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { Recorder } from "./support.js";

const folders: string[] = [];
async function newFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tl-upload-"));
  folders.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

function uploadsIn(dir: string, options: { maxBytes?: number; idleMs?: number } = {}): UploadManager {
  return new UploadManager({
    folderOf: (sessionId) => {
      if (sessionId !== "s1") throw new HostError("not_found", `no session ${sessionId}`);
      return dir;
    },
    ...options,
  });
}

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const uploadsDir = (dir: string) => path.join(dir, ".termlink", "uploads");

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof HostError && err.code === code);
}

test("saves a file sent in chunks, whatever order they land in", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  const body = Buffer.from("0123456789abcdef");
  const { uploadId, name } = await uploads.begin("s1", "notes.txt", body.length);
  assert.equal(name, "notes.txt");
  await Promise.all([
    uploads.chunk(uploadId, 8, b64(body.subarray(8))),
    uploads.chunk(uploadId, 0, b64(body.subarray(0, 8))),
  ]);
  const saved = await uploads.end(uploadId);
  assert.deepEqual(saved, { path: path.join(uploadsDir(dir), "notes.txt"), name: "notes.txt", size: 16 });
  assert.deepEqual(await readFile(saved.path), body);
  // The host's folder stays out of the user's git.
  assert.equal(await readFile(path.join(dir, ".termlink", ".gitignore"), "utf8"), "*\n");
});

test("an empty file needs no chunks", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  const { uploadId } = await uploads.begin("s1", "empty.txt", 0);
  const saved = await uploads.end(uploadId);
  assert.equal((await readFile(saved.path)).length, 0);
});

test("a second file of the same name is numbered, not overwritten", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  for (const text of ["first", "second"]) {
    const { uploadId } = await uploads.begin("s1", "shot.png", text.length);
    await uploads.chunk(uploadId, 0, b64(text));
    await uploads.end(uploadId);
  }
  assert.deepEqual((await readdir(uploadsDir(dir))).sort(), ["shot (1).png", "shot.png"]);
  assert.equal(await readFile(path.join(uploadsDir(dir), "shot.png"), "utf8"), "first");
});

test("only the last segment of the name is kept", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  const { uploadId, name } = await uploads.begin("s1", "../../escape.txt", 1);
  assert.equal(name, "escape.txt");
  await uploads.chunk(uploadId, 0, b64("x"));
  const saved = await uploads.end(uploadId);
  assert.equal(path.dirname(saved.path), uploadsDir(dir));

  assert.equal(cleanName("C:\\Users\\me\\Desktop\\a.png"), "a.png");
  assert.equal(cleanName(".."), "upload");
  assert.equal(cleanName('what?<now>:"|*.txt'), "what__now_____.txt");
  assert.equal(cleanName("trailing. "), "trailing");
  assert.equal(cleanName("con.txt"), "_con.txt");
  assert.equal(cleanName(`${"a".repeat(300)}.png`).length, 200);
  assert.ok(cleanName(`${"a".repeat(300)}.png`).endsWith(".png"));
});

test("refuses a file over the limit before writing anything", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir, { maxBytes: 10 });
  await rejectsWith(uploads.begin("s1", "big.bin", 11), "bad_request");
  await assert.rejects(readdir(uploadsDir(dir)));
});

test("an unknown session is not_found", async () => {
  const dir = await newFolder();
  await rejectsWith(uploadsIn(dir).begin("nope", "a.txt", 1), "not_found");
});

test("a short upload fails at end and leaves no file", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  const { uploadId } = await uploads.begin("s1", "short.txt", 10);
  await uploads.chunk(uploadId, 0, b64("abc"));
  await rejectsWith(uploads.end(uploadId), "bad_request");
  assert.deepEqual(await readdir(uploadsDir(dir)), []);
});

test("a chunk past the announced size drops the upload", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  const { uploadId } = await uploads.begin("s1", "a.txt", 2);
  await rejectsWith(uploads.chunk(uploadId, 1, b64("xy")), "bad_request");
  await rejectsWith(uploads.end(uploadId), "not_found");
  assert.deepEqual(await readdir(uploadsDir(dir)), []);
});

test("abort removes the partial file, and aborting twice is fine", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  const { uploadId } = await uploads.begin("s1", "half.txt", 4);
  await uploads.chunk(uploadId, 0, b64("ab"));
  await uploads.abort(uploadId);
  await uploads.abort(uploadId);
  assert.deepEqual(await readdir(uploadsDir(dir)), []);
  await rejectsWith(uploads.chunk(uploadId, 2, b64("cd")), "not_found");
});

test("an upload left idle is dropped", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir, { idleMs: 20 });
  const { uploadId } = await uploads.begin("s1", "left.txt", 4);
  await sleep(120);
  await rejectsWith(uploads.chunk(uploadId, 0, b64("abcd")), "not_found");
  assert.deepEqual(await readdir(uploadsDir(dir)), []);
  await uploads.dispose();
});

test("dispose drops whatever is still in progress", async () => {
  const dir = await newFolder();
  const uploads = uploadsIn(dir);
  await uploads.begin("s1", "one.txt", 4);
  await uploads.begin("s1", "two.txt", 4);
  await uploads.dispose();
  assert.deepEqual(await readdir(uploadsDir(dir)), []);
});

test("over the wire: into the session's folder, answered with the path", async () => {
  const dir = await newFolder();
  const manager = new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })] });
  const hostInfo = async (): Promise<HostInfo> => ({
    hostId: "h_test",
    name: "test",
    version: "0.0.0",
    protocol: 1,
    os: "test",
    providers: await manager.providerStatuses(),
  });
  const server = await startLocalServer({ manager, hostInfo, token: "t", port: 0 });
  const ws = new WebSocket(`${server.url}?token=t`);
  const rec = new Recorder<HostMessage>();
  ws.on("message", (data) => {
    const parsed = HostMessage.safeParse(JSON.parse(data.toString()));
    if (parsed.success) rec.push(parsed.data);
  });
  await once(ws, "open");
  let next = 0;
  const request = async <T extends CommandType>(type: T, payload: unknown): Promise<CommandResults[T]> => {
    const reqId = `r${++next}`;
    ws.send(JSON.stringify({ v: 1, kind: "cmd", reqId, type, payload }));
    const res = await rec.waitFor((m) => m.kind === "res" && m.reqId === reqId);
    assert.ok(res.kind === "res");
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res.result as CommandResults[T];
  };

  try {
    const { session } = await request("session.create", { provider: "fake", cwd: dir });
    const body = Buffer.from("a picture, as far as this test cares");
    const { uploadId } = await request("upload.begin", { sessionId: session.id, name: "pic.png", size: body.length });
    const half = 10;
    await Promise.all([
      request("upload.chunk", { uploadId, offset: half, data: b64(body.subarray(half)) }),
      request("upload.chunk", { uploadId, offset: 0, data: b64(body.subarray(0, half)) }),
    ]);
    const saved = await request("upload.end", { uploadId });
    // The session's cwd is the real path of the folder.
    assert.equal(path.basename(saved.path), "pic.png");
    assert.equal(path.basename(path.dirname(saved.path)), "uploads");
    assert.equal(saved.path.startsWith(session.cwd), true);
    assert.deepEqual(await readFile(saved.path), body);

    await assert.rejects(request("upload.chunk", { uploadId: "up_x", offset: 0, data: "" }), /not_found/);
    await assert.rejects(
      request("upload.begin", { sessionId: session.id, name: "huge.bin", size: 26 * 1024 * 1024 }),
      /bad_request/,
    );
  } finally {
    ws.close();
    await manager.closeAll();
    await server.close();
  }
});
