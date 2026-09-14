import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentEvent, EventOf } from "@termlink/protocol";
import { ClaudeProvider } from "../src/providers/claude/provider.js";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createFakeQuery } from "./fixtures/fake-claude.js";
import { Recorder } from "./support.js";

const isType =
  <T extends AgentEvent["type"]>(type: T) =>
  (e: AgentEvent): e is EventOf<T> =>
    e.type === type;

function fakeManager(autoApprove?: "off" | "edits" | "all") {
  return new SessionManager({ providers: [new FakeProvider({ stepDelayMs: 0 })], ...(autoApprove ? { autoApprove } : {}) });
}

test("all: command approvals are answered by the policy and still recorded", async () => {
  const manager = fakeManager("all");
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir() });
    assert.equal(session.info.autoApprove, "all");
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "fix it" });
    await rec.waitFor(isType("turn.completed"));

    const required = rec.items.find(isType("input.required"));
    const resolved = rec.items.find(isType("input.resolved"));
    assert.ok(required && resolved);
    assert.equal(resolved.payload.requestId, required.payload.request.requestId);
    assert.equal(resolved.payload.by, "policy");
    assert.equal(resolved.payload.decisionId, "allow", "plain allow, never allow_session");
    assert.equal(rec.items.indexOf(resolved), rec.items.indexOf(required) + 1);
    const command = rec.items.filter(isType("item.completed")).find((e) => e.payload.item.kind === "command");
    assert.equal(command?.payload.item.status, "completed");
  } finally {
    await manager.shutdown();
  }
});

test("edits leaves commands waiting; switching to all answers the one already waiting", async () => {
  const manager = fakeManager();
  try {
    const session = await manager.createAgent({ provider: "fake", cwd: tmpdir(), autoApprove: "edits" });
    const rec = new Recorder();
    session.attach(rec.push);
    const host = new Recorder();
    manager.onHostEvent(host.push);
    await session.send({ text: "fix it" });
    await rec.waitFor(isType("input.required"));
    assert.equal(session.info.status, "waiting_input");

    session.configure({ autoApprove: "all" });
    await rec.waitFor(isType("turn.completed"));
    assert.equal(rec.items.find(isType("input.resolved"))?.payload.by, "policy");
    const updated = host.items.filter(isType("session.updated")).find((e) => e.payload.session.autoApprove === "all");
    assert.ok(updated, "the new mode is announced to every connection");
  } finally {
    await manager.shutdown();
  }
});

test("questions always wait for a person, even under all", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-policy-"));
  const file = path.join(dir, "src.ts");
  writeFileSync(file, "x\n");
  const fake = createFakeQuery(file);
  const manager = new SessionManager({ providers: [new ClaudeProvider({ queryFn: fake.queryFn, historyFn: async () => [] })], autoApprove: "all" });
  try {
    const session = await manager.createAgent({ provider: "claude", cwd: dir });
    const rec = new Recorder();
    session.attach(rec.push);
    await session.send({ text: "ask me" });
    const required = (await rec.waitFor(isType("input.required"))) as EventOf<"input.required">;
    assert.equal(required.payload.request.kind, "question");
    assert.equal(rec.items.filter(isType("input.resolved")).length, 0);
    session.respond(required.payload.request.requestId, "submit", { "0": "SQLite" });
    await rec.waitFor(isType("turn.completed"));
  } finally {
    await manager.shutdown();
  }
});

test("autoApprove is remembered across a restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-policy-"));
  const file = path.join(dir, "src.ts");
  writeFileSync(file, "export const x = 1;\n");
  const store = new SessionStore(path.join(dir, "sessions.json"));
  const fake = createFakeQuery(file);
  const provider = () => new ClaudeProvider({ queryFn: fake.queryFn, historyFn: async () => [] });

  const first = new SessionManager({ providers: [provider()], store });
  const session = await first.createAgent({ provider: "claude", cwd: dir, autoApprove: "edits" });
  const rec = new Recorder();
  session.attach(rec.push);
  await session.send({ text: "please fail" });
  await rec.waitFor(isType("turn.completed"));
  await first.shutdown();

  const second = new SessionManager({ providers: [provider()], store });
  try {
    await second.restore();
    assert.equal(second.get(session.id).info.autoApprove, "edits");
  } finally {
    await second.shutdown();
  }
});
