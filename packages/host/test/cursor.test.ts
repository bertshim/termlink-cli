import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentEvent, type EventOf } from "@termlink/protocol";
import { CursorProvider } from "../src/providers/cursor/provider.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { Recorder } from "./support.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cursor-acp.ts", import.meta.url));
const command = { file: process.execPath, args: ["--import", "tsx", fixture], shell: false };

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

async function open() {
  const manager = new SessionManager({ providers: [new CursorProvider({ command })] });
  const session = await manager.createAgent({ provider: "cursor", cwd: tmpdir() });
  const rec = new Recorder();
  session.attach(rec.push);
  return { manager, session, rec };
}

function completed(events: AgentEvent[]) {
  return events.filter(isType("item.completed")).map((e) => e.payload.item);
}

test("maps a Cursor turn with an approved command", async () => {
  const { manager, session, rec } = await open();
  try {
    assert.match(session.info.providerSessionId ?? "", /^ses_/);
    await session.send({ text: "run the tests" });

    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    const { request } = required.payload;
    assert.equal(request.kind, "command_approval");
    assert.equal(request.command, "npm test");
    assert.equal(request.cwd, tmpdir());
    assert.equal(request.body, "needs network access");
    assert.deepEqual(
      request.decisions.map((d) => d.id),
      ["allow-once", "allow-always", "reject-once"],
    );
    session.respond(request.requestId, "allow-once");

    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    for (const event of rec.items) AgentEvent.parse(event);

    const items = completed(rec.items);
    // [0] is the host's own item for the text sent to session.send(), not anything this
    // adapter emits. Thinking closes as soon as the reply starts; the reply closes as soon
    // as the tool call starts; the command closes on its own; the plan (touched twice,
    // "updated" both times) only ever reaches item.completed once, when the turn itself ends.
    assert.deepEqual(
      items.map((i) => i.kind),
      ["message", "reasoning", "message", "command", "todo"],
    );
    const [user, thought, reply, cmd, plan] = items;
    assert.ok(user?.kind === "message" && user.role === "user");
    assert.ok(thought?.kind === "reasoning" && thought.text === "Thinking");
    assert.ok(reply?.kind === "message" && reply.role === "assistant" && reply.text === "Running tests");
    assert.ok(cmd?.kind === "command");
    assert.equal(cmd.command, "npm test");
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

test("a rejected Cursor command still ends the turn", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    session.respond(required.payload.request.requestId, "reject-once");
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    assert.equal(completed(rec.items).find((i) => i.kind === "command")?.status, "failed");
  } finally {
    await manager.shutdown();
  }
});

test("interrupting during a Cursor approval cancels the request and ends the turn", async () => {
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

test("a failed Cursor turn reports the error", async () => {
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

test("two Cursor sessions share one acp process without crossing events", async () => {
  const manager = new SessionManager({ providers: [new CursorProvider({ command })] });
  try {
    const a = await manager.createAgent({ provider: "cursor", cwd: tmpdir() });
    const b = await manager.createAgent({ provider: "cursor", cwd: tmpdir() });
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

test("probe reports cursor as unavailable when it is not installed", async () => {
  const status = await new CursorProvider({ command: null }).probe();
  assert.equal(status.available, false);
  assert.match(status.detail ?? "", /not found/);
});

test("a Cursor session comes back after a restart, with its history, and keeps going", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-cursor-resume-"));
  const store = new SessionStore(path.join(dir, "sessions.json"));
  process.env.FAKE_CURSOR_STATE = path.join(dir, "cursor-state.json");
  try {
    const first = new SessionManager({ providers: [new CursorProvider({ command })], store });
    const original = await first.createAgent({ provider: "cursor", cwd: dir, title: "fix tests" });
    const rec = new Recorder();
    original.attach(rec.push);
    await original.send({ text: "run the tests" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    original.respond(required.payload.request.requestId, "allow-once");
    await rec.waitFor(isType("turn.completed"));
    const sessionId = original.info.providerSessionId;
    await first.shutdown();

    const saved = await store.load();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.providerSessionId, sessionId);

    // A second provider and manager: a fresh cursor-agent acp process, standing in for the
    // host itself having restarted, reading the same fixture state a real cursor-agent
    // would keep on disk.
    const second = new SessionManager({ providers: [new CursorProvider({ command })], store });
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
      assert.ok(items.at(-1)?.kind === "command" && items.at(-1)?.status === "completed");

      // The first send resumes the same underlying session rather than starting fresh.
      await restored.send({ text: "and again" });
      const required2 = (await again.waitFor(isType("input.required"))) as EventOf<"input.required">;
      restored.respond(required2.payload.request.requestId, "allow-once");
      await again.waitFor(isType("turn.completed"));
      assert.equal(again.items.filter(isType("turn.completed")).at(-1)?.payload.status, "completed");
    } finally {
      await second.shutdown();
    }
  } finally {
    delete process.env.FAKE_CURSOR_STATE;
  }
});

test("a configured model is applied to a new Cursor session with session/set_model", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-cursor-model-"));
  const statePath = path.join(dir, "cursor-state.json");
  process.env.FAKE_CURSOR_STATE = statePath;
  try {
    const manager = new SessionManager({ providers: [new CursorProvider({ command, model: "claude-haiku-4-5[thinking=true]" })] });
    try {
      const session = await manager.createAgent({ provider: "cursor", cwd: tmpdir() });
      const log = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, { modelId: string }[]>;
      assert.deepEqual(log[`__model__${session.info.providerSessionId}`], [{ modelId: "claude-haiku-4-5[thinking=true]" }]);
    } finally {
      await manager.shutdown();
    }
  } finally {
    delete process.env.FAKE_CURSOR_STATE;
  }
});

test("no model configured means no session/set_model call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-cursor-nomodel-"));
  const statePath = path.join(dir, "cursor-state.json");
  process.env.FAKE_CURSOR_STATE = statePath;
  try {
    const { manager, session } = await open();
    try {
      // The state file only exists once something writes to it; a session with no
      // model configured should never call session/set_model at all.
      let log: Record<string, unknown> = {};
      try {
        log = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      } catch {
        // Not written at all is the expected, best outcome.
      }
      assert.equal(log[`__model__${session.info.providerSessionId}`], undefined);
    } finally {
      await manager.shutdown();
    }
  } finally {
    delete process.env.FAKE_CURSOR_STATE;
  }
});

test("a configured mode is applied to a new Cursor session with session/set_mode", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-cursor-mode-"));
  const statePath = path.join(dir, "cursor-state.json");
  process.env.FAKE_CURSOR_STATE = statePath;
  try {
    const manager = new SessionManager({ providers: [new CursorProvider({ command, mode: "plan" })] });
    try {
      const session = await manager.createAgent({ provider: "cursor", cwd: tmpdir() });
      const log = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, { modeId: string }[]>;
      assert.deepEqual(log[`__mode__${session.info.providerSessionId}`], [{ modeId: "plan" }]);
    } finally {
      await manager.shutdown();
    }
  } finally {
    delete process.env.FAKE_CURSOR_STATE;
  }
});

test("a Cursor edit approval asks as file_approval, not tool_approval", async () => {
  const { manager, session, rec } = await open();
  try {
    await session.send({ text: "edit approval please" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    // The box on screen offers "Allow commands and edits" as one setting; if this ever came
    // back as tool_approval instead, autoApprove "edits" would silently never answer it (see
    // the next test) even though the label says it should.
    assert.equal(required.payload.request.kind, "file_approval");
    session.respond(required.payload.request.requestId, "allow-once");
    const done = (await rec.waitFor(isType("turn.completed"))) as EventOf<"turn.completed">;
    assert.equal(done.payload.status, "completed");
    const edit = completed(rec.items).find((i) => i.kind === "file_change");
    assert.equal(edit?.status, "completed");
    assert.ok(edit?.kind === "file_change" && edit.changes[0]?.path === "a.ts");
  } finally {
    await manager.shutdown();
  }
});

test("autoApprove \"edits\" answers a Cursor edit approval by itself", async () => {
  const manager = new SessionManager({ providers: [new CursorProvider({ command })] });
  try {
    const session = await manager.createAgent({ provider: "cursor", cwd: tmpdir(), autoApprove: "edits" });
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

test("history()/start() refuse to touch a session id that is already live on this host", async () => {
  const provider = new CursorProvider({ command });
  const manager = new SessionManager({ providers: [provider] });
  try {
    const session = await manager.createAgent({ provider: "cursor", cwd: tmpdir() });
    const sessionId = session.info.providerSessionId as string;
    // Both would otherwise register() over the live session's own entry and steal its
    // notifications — see provider.ts's own note on why that must never happen quietly.
    await assert.rejects(provider.history(sessionId, tmpdir()), /already open/);
    await assert.rejects(
      provider.start({ sessionId: "whatever", cwd: tmpdir(), resumeProviderSessionId: sessionId }, session.sink),
      /already open/,
    );
  } finally {
    await manager.shutdown();
  }
});
