import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { mapItem } from "../src/providers/codex/mapper.js";
import type { ThreadItem } from "../src/providers/codex/protocol.js";
import { CodexProvider } from "../src/providers/codex/provider.js";
import { JsonRpcPeer, NO_RESPONSE, RpcError } from "../src/providers/codex/rpc.js";
import { SessionManager } from "../src/session/manager.js";
import { Recorder } from "./support.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.ts", import.meta.url));
const command = { file: process.execPath, args: ["--import", "tsx", fixture] };

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

async function open() {
  const manager = new SessionManager({ providers: [new CodexProvider({ command })] });
  const session = await manager.createAgent({ provider: "codex", cwd: tmpdir() });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec };
}

function completed(events: AgentEvent[]) {
  return events.filter(isType("item.completed")).map((e) => e.payload.item);
}

test("maps a Codex turn with an approved command", async () => {
  const { manager, session, rec } = await open();
  try {
    assert.match(session.info.providerSessionId ?? "", /^thr_/);
    await session.send({ text: "run the tests" });

    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    const { request } = required.payload;
    assert.equal(request.kind, "command_approval");
    assert.equal(request.command, "npm test");
    assert.equal(request.body, "needs network access");
    assert.deepEqual(request.decisions.map((d) => d.id), ["accept", "acceptForSession", "decline", "cancel"]);
    session.respond(request.requestId, "accept");

    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.deepEqual(done.payload.usage, { inputTokens: 100, outputTokens: 20 });
    for (const event of rec.items) AgentEvent.parse(event);

    const items = completed(rec.items);
    assert.deepEqual(items.map((i) => i.kind), ["message", "message", "command", "todo"]);
    const [user, reply, cmd, plan] = items;
    assert.ok(user?.kind === "message" && user.role === "user");
    assert.ok(reply?.kind === "message" && reply.text === "Running tests");
    assert.ok(cmd?.kind === "command");
    assert.equal(cmd.status, "completed");
    assert.equal(cmd.output, "ok\n");
    assert.equal(cmd.exitCode, 0);
    assert.ok(plan?.kind === "todo");
    assert.deepEqual(plan.entries, [{ text: "Run tests", done: true }]);
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("a declined Codex command is reported as declined", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    session.respond(required.payload.request.requestId, "decline");
    await rec.waitFor(isType("turn.completed"));
    assert.equal(completed(rec.items).find((i) => i.kind === "command")?.status, "declined");
  } finally {
    await manager.shutdown();
  }
});

test("interrupting during a Codex approval cancels it and ends the turn", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "run the tests" });
    await rec.waitFor(isType("input.required"));
    await session.interrupt();

    const resolved = rec.items.find(isType("input.resolved"));
    assert.equal(resolved?.payload.effect, "cancel");
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("a failed Codex turn reports the error", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "please fail" });
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "failed");
    assert.equal(done.payload.error, "model unavailable");
    assert.equal(rec.items.find(isType("error"))?.payload.message, "model unavailable");
  } finally {
    await manager.shutdown();
  }
});

test("two Codex sessions share one app-server without crossing events", async () => {
  const manager = new SessionManager({ providers: [new CodexProvider({ command })] });
  try {
    const a = await manager.createAgent({ provider: "codex", cwd: tmpdir() });
    const b = await manager.createAgent({ provider: "codex", cwd: tmpdir() });
    assert.notEqual(a.info.providerSessionId, b.info.providerSessionId);
    const recA = new Recorder();
    const recB = new Recorder();
    a.attach(recA.push);
    b.attach(recB.push);
    await a.send({ text: "run the tests" });
    await recA.waitFor(isType("input.required"));
    assert.equal(recB.items.length, 0);
  } finally {
    await manager.shutdown();
  }
});

test("probe reports codex as unavailable when it is not installed", async () => {
  const status = await new CodexProvider({ command: null }).probe();
  assert.equal(status.available, false);
  assert.match(status.detail ?? "", /not found/);
});

test("mapItem covers renames, tool calls, reasoning and unknown item types", () => {
  const rename = mapItem(
    {
      type: "fileChange",
      id: "f",
      status: "completed",
      changes: [{ path: "a.ts", kind: { type: "update", move_path: "b.ts" }, diff: "" }],
    },
    "completed",
  );
  assert.ok(rename?.kind === "file_change");
  assert.deepEqual(rename.changes[0], { path: "a.ts", action: "rename", movePath: "b.ts", diff: "" });

  const mcp = mapItem(
    {
      type: "mcpToolCall",
      id: "m",
      server: "github",
      tool: "search",
      status: "failed",
      arguments: { q: "x" },
      result: null,
      error: { message: "denied" },
    },
    "completed",
  );
  assert.deepEqual(mcp, {
    id: "m",
    kind: "tool",
    name: "github/search",
    input: { q: "x" },
    output: { error: "denied" },
    status: "failed",
  });

  const reasoning = mapItem({ type: "reasoning", id: "r", summary: ["one", "two"], content: [] }, "started");
  assert.deepEqual(reasoning, { id: "r", kind: "reasoning", text: "one\n\ntwo", status: "in_progress" });

  assert.equal(mapItem({ type: "userMessage", id: "u" }, "completed"), null);
  const unknown = mapItem({ type: "hookPrompt", id: "h" } as unknown as ThreadItem, "completed");
  assert.deepEqual(unknown, { id: "h", kind: "tool", name: "hookPrompt", status: "completed" });
});

test("JsonRpcPeer answers server requests, reports errors and can stay silent", async () => {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  const peer = new JsonRpcPeer(toPeer, fromPeer);
  const written: unknown[] = [];
  fromPeer.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) written.push(JSON.parse(line));
  });
  peer.onRequest = async (method) => {
    if (method === "ok") return { fine: true };
    if (method === "silent") return NO_RESPONSE;
    throw new RpcError(-32001, "nope");
  };

  toPeer.write(`${JSON.stringify({ id: 1, method: "ok", params: {} })}\n`);
  toPeer.write(`${JSON.stringify({ id: 2, method: "silent", params: {} })}\n`);
  toPeer.write(`${JSON.stringify({ id: 3, method: "bad", params: {} })}\n`);
  const pending = peer.request("ping", {});
  toPeer.write(`${JSON.stringify({ id: 1, error: { code: 5, message: "server said no" } })}\n`);

  await assert.rejects(pending, { message: "server said no" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, [
    { id: 1, method: "ping", params: {} },
    { id: 1, result: { fine: true } },
    { id: 3, error: { code: -32001, message: "nope" } },
  ]);

  const orphan = peer.request("never", {});
  peer.close(new Error("gone"));
  await assert.rejects(orphan, { message: "gone" });
});
