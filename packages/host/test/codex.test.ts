import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { mapItem } from "../src/providers/codex/mapper.js";
import { MAX_LIMIT_RETRIES } from "../src/providers/codex/rate-limit.js";
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

async function openLimited(afterResetMs: number) {
  const manager = new SessionManager({ providers: [new CodexProvider({ command, limitRetryAfterResetMs: afterResetMs })] });
  const session = await manager.createAgent({ provider: "codex", cwd: tmpdir() });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec };
}

/** The user messages of a recorded run, one per turn that reached Codex. */
function userTexts(events: AgentEvent[]): string[] {
  return completed(events).flatMap((i) => (i.kind === "message" && i.role === "user" ? [i.text] : []));
}

test("a Codex turn that hits the usage limit is shown as rate_limited, then auto-resent past the reset", async () => {
  const { manager, session, rec } = await openLimited(20);
  try {
    await session.send({ text: "limit-once please" });
    const failed = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(failed.payload.status, "failed");
    assert.match(failed.payload.error ?? "", /hit your usage limit/);
    // The wait is session state, not a one-shot event: readable straight off session.info.
    assert.equal(session.info.status, "rate_limited");
    assert.match(session.info.rateLimit?.reason ?? "", /hit your usage limit/);
    assert.ok((session.info.rateLimit?.retryAt ?? 0) > Date.now());

    // The resent turn runs the fake's normal script, which stops at a command approval.
    const from = rec.items.length;
    const required = (await rec.waitFor(isType("input.required"), from)) as EventOf<"input.required">;
    assert.equal(session.info.rateLimit, undefined);
    session.respond(required.payload.request.requestId, "accept");
    const done = (await rec.waitFor(
      (e) => e.type === "turn.completed" && e.payload.status === "completed",
      from,
    )) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.equal(session.info.status, "idle");
    // One message, sent to Codex twice — the second turn opened by the host, not a person.
    assert.deepEqual(userTexts(rec.items), ["limit-once please", "limit-once please"]);
    assert.equal(rec.items.filter(isType("turn.started")).length, 2);
    for (const event of rec.items) AgentEvent.parse(event);
  } finally {
    await manager.shutdown();
  }
});

test("a Codex usage limit hit again and again stops auto-retrying at MAX_LIMIT_RETRIES", async () => {
  const { manager, session, rec } = await openLimited(5);
  try {
    await session.send({ text: "limit-always please" });
    // Each wait is the fake's own one-second reset, so the whole chain takes about MAX seconds.
    const start = Date.now();
    while (rec.items.filter(isType("turn.completed")).length < MAX_LIMIT_RETRIES + 1) {
      if (Date.now() - start > 20_000) throw new Error("timed out waiting for the retry chain to give up");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const completions = rec.items.filter(isType("turn.completed"));
    assert.equal(completions.length, MAX_LIMIT_RETRIES + 1);
    assert.ok(completions.every((e) => e.payload.status === "failed"));
    // Gave up, rather than waiting on one more reset forever.
    assert.equal(session.info.status, "idle");
    assert.equal(session.info.rateLimit, undefined);
  } finally {
    await manager.shutdown();
  }
});

test("with no usage windows reported, the sentence's own 'try again at' sets the wait", async () => {
  const { manager, session, rec } = await openLimited(5_000);
  try {
    await session.send({ text: "limit-noreset limit-once" });
    await rec.waitFor(isType("turn.completed"));
    assert.equal(session.info.status, "rate_limited");
    const retryAt = session.info.rateLimit?.retryAt ?? 0;
    // The next 6:54 PM on this machine's clock, plus the shortened margin: never in the past,
    // never more than a day away.
    assert.ok(retryAt > Date.now());
    assert.ok(retryAt <= Date.now() + 24 * 60 * 60 * 1000 + 5_000);
    const at = new Date(retryAt - 5_000);
    assert.equal(at.getHours(), 18);
    assert.equal(at.getMinutes(), 54);
  } finally {
    await manager.shutdown();
  }
});

test("a manual send while a Codex usage-limit retry is waiting cancels the wait", async () => {
  const { manager, session, rec } = await openLimited(60_000);
  try {
    await session.send({ text: "limit-once please" });
    await rec.waitFor(isType("turn.completed"));
    assert.equal(session.info.status, "rate_limited");

    await session.send({ text: "something else" });
    assert.equal(session.info.rateLimit, undefined);
    await rec.waitFor(isType("input.required"));
    assert.deepEqual(userTexts(rec.items), ["limit-once please", "something else"]);
  } finally {
    await manager.shutdown();
  }
});

test("Stop while a Codex usage-limit retry is waiting cancels it, with no turn to stop", async () => {
  const { manager, session, rec } = await openLimited(20);
  try {
    await session.send({ text: "limit-once please" });
    await rec.waitFor(isType("turn.completed"));
    assert.equal(session.info.status, "rate_limited");

    await session.interrupt();
    assert.equal(session.info.status, "idle");
    assert.equal(session.info.rateLimit, undefined);

    // Past when the (cancelled) retry would have fired.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(rec.items.filter(isType("turn.completed")).length, 1);
  } finally {
    await manager.shutdown();
  }
});

test("an unrelated Codex failure is not retried", async () => {
  const { manager, session, rec } = await openLimited(5);
  try {
    await session.send({ text: "please fail" });
    await rec.waitFor(isType("turn.completed"));
    assert.equal(session.info.status, "idle");
    assert.equal(session.info.rateLimit, undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rec.items.filter(isType("turn.completed")).length, 1);
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
