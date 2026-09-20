import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { CopilotProvider } from "../src/providers/copilot/provider.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { Recorder } from "./support.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-copilot-acp.ts", import.meta.url));
const command = { file: process.execPath, args: ["--import", "tsx", fixture], shell: false };

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

async function open() {
  const manager = new SessionManager({ providers: [new CopilotProvider({ command })] });
  const session = await manager.createAgent({ provider: "copilot", cwd: tmpdir() });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec };
}

function completed(events: AgentEvent[]) {
  return events.filter(isType("item.completed")).map((e) => e.payload.item);
}

test("maps a Copilot turn with an approved command, and its usage", async () => {
  const { manager, session, rec } = await open();
  try {
    assert.match(session.info.providerSessionId ?? "", /^ses_/);
    await session.send({ text: "run the tests" });

    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    const { request } = required.payload;
    assert.equal(request.kind, "command_approval");
    assert.equal(request.command, "npm test");
    assert.equal(request.cwd, tmpdir());
    session.respond(required.payload.request.requestId, "allow_once");

    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    // Real usage, unlike Cursor's ACP, which never sends any (cursor/provider.ts's own note).
    assert.deepEqual(done.payload.usage, { inputTokens: 100, outputTokens: 20 });
    for (const event of rec.items) AgentEvent.parse(event);

    const items = completed(rec.items);
    assert.deepEqual(
      items.map((i) => i.kind),
      ["message", "reasoning", "message", "command", "todo"],
    );
    const cmd = items[3];
    assert.ok(cmd?.kind === "command");
    assert.equal(cmd.command, "npm test");
    assert.equal(cmd.status, "completed");
    assert.equal(cmd.output, "ok\n");
    assert.equal(cmd.exitCode, 0);
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("a rejected Copilot command reports the CLI's own rejection message as output", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    session.respond(required.payload.request.requestId, "reject_once");
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    const cmd = completed(rec.items).find((i) => i.kind === "command");
    assert.equal(cmd?.status, "failed");
    assert.ok(cmd?.kind === "command" && cmd.output === "The user rejected this tool call.");
  } finally {
    await manager.shutdown();
  }
});

test("interrupting a Copilot approval reports interrupted even though the CLI's own stopReason says end_turn", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "run the tests" });
    await rec.waitFor(isType("input.required"));
    await session.interrupt();

    const resolved = rec.items.find(isType("input.resolved"));
    assert.equal(resolved?.payload.effect, "cancel");
    // The critical assertion: fake-copilot-acp.ts always answers stopReason "end_turn", the
    // same as a real copilot --acp does on a cancel (protocol.ts's own note) — so this only
    // reads "interrupted" if CopilotAcpSession tracks its own interrupt() call instead of
    // trusting stopReason, which is exactly the bug this fixture exists to catch a regression on.
    assert.equal(rec.items.find(isType("turn.completed"))?.payload.status, "interrupted");
    assert.equal(session.info.status, "idle");
  } finally {
    await manager.shutdown();
  }
});

test("a failed Copilot turn reports the error", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "please fail" });
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "failed");
    assert.equal(done.payload.error, "agent unavailable");
  } finally {
    await manager.shutdown();
  }
});

test("two Copilot sessions share one acp process without crossing events", async () => {
  const manager = new SessionManager({ providers: [new CopilotProvider({ command })] });
  try {
    const a = await manager.createAgent({ provider: "copilot", cwd: tmpdir() });
    const b = await manager.createAgent({ provider: "copilot", cwd: tmpdir() });
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

test("probe reports copilot as unavailable when it is not installed", async () => {
  const status = await new CopilotProvider({ command: null }).probe();
  assert.equal(status.available, false);
  assert.match(status.detail ?? "", /not found/);
});

test("a Copilot edit approval asks as file_approval, not tool_approval", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "edit approval please" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    assert.equal(required.payload.request.kind, "file_approval");
    session.respond(required.payload.request.requestId, "allow_once");
    await rec.waitFor(isType("turn.completed"));
    const edit = completed(rec.items).find((i) => i.kind === "file_change");
    assert.ok(edit?.kind === "file_change" && edit.changes[0]?.path === "a.ts");
  } finally {
    await manager.shutdown();
  }
});

test("autoApprove \"edits\" answers a Copilot edit approval by itself", async () => {
  const manager = new SessionManager({ providers: [new CopilotProvider({ command })] });
  try {
    const session = await manager.createAgent({ provider: "copilot", cwd: tmpdir(), autoApprove: "edits" });
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "edit approval please" });
    const resolved = (await rec.waitFor(isType("input.resolved"))) as EventOf<"input.resolved">;
    assert.equal(resolved.payload.by, "policy");
    assert.equal(resolved.payload.effect, "allow");
    await rec.waitFor(isType("turn.completed"));
  } finally {
    await manager.shutdown();
  }
});

test("a Copilot session comes back after a restart, with its history, and keeps going", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-copilot-resume-"));
  const store = new SessionStore(path.join(dir, "sessions.json"));
  process.env.FAKE_COPILOT_STATE = path.join(dir, "copilot-state.json");
  try {
    const first = new SessionManager({ providers: [new CopilotProvider({ command })], store });
    const original = await first.createAgent({ provider: "copilot", cwd: dir, title: "fix tests" });
    const rec = new Recorder();
    original.attach(rec.push);
    await original.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    original.respond(required.payload.request.requestId, "allow_once");
    await rec.waitFor(isType("turn.completed"));
    const sessionId = original.info.providerSessionId;
    await first.shutdown();

    const saved = await store.load();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.providerSessionId, sessionId);

    const second = new SessionManager({ providers: [new CopilotProvider({ command })], store });
    try {
      assert.equal(await second.restore(), 1);
      const restored = second.agent(original.id);
      assert.equal(restored.info.status, "idle");
      assert.equal(restored.info.providerSessionId, sessionId);

      const again = new Recorder();
      const { replay } = restored.attach(again.push, 0);
      const items = replay.filter(isType("item.completed")).map((e) => e.payload.item);
      assert.deepEqual(
        items.map((i) => i.kind),
        ["message", "reasoning", "message", "command"],
      );
      assert.ok(items[0]?.kind === "message" && items[0].role === "user" && items[0].text === "run the tests");

      await restored.send({ text: "and again" });
      const required2 = (await again.waitFor(isType("input.required"))) as EventOf<"input.required">;
      restored.respond(required2.payload.request.requestId, "allow_once");
      await again.waitFor(isType("turn.completed"));
      assert.equal(again.items.filter(isType("turn.completed")).at(-1)?.payload.status, "completed");
    } finally {
      await second.shutdown();
    }
  } finally {
    delete process.env.FAKE_COPILOT_STATE;
  }
});

test("history()/start() refuse to touch a session id that is already live on this host", async () => {
  const provider = new CopilotProvider({ command });
  const manager = new SessionManager({ providers: [provider] });
  try {
    const session = await manager.createAgent({ provider: "copilot", cwd: tmpdir() });
    const sessionId = session.info.providerSessionId as string;
    await assert.rejects(provider.history(sessionId, tmpdir()), /already open/);
    await assert.rejects(
      provider.start({ sessionId: "whatever", cwd: tmpdir(), resumeProviderSessionId: sessionId }, session.sink),
      /already open/,
    );
  } finally {
    await manager.shutdown();
  }
});
