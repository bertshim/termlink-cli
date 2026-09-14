import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentEvent, TERMINAL_FRAME_OUTPUT, decodeTerminalFrame } from "@termlink/protocol";
import type { Terminal, TerminalExit } from "@termlink/terminal";
import { TerminalSession, type TerminalListener } from "../src/session/terminal-session.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A terminal that does what it is told, so the session's own logic can be tested without a PTY. */
class StubTerminal implements Terminal {
  pid = 4242;
  cols = 80;
  rows = 24;
  exit: TerminalExit | null = null;
  written: string[] = [];
  paused = 0;
  screen = "";
  #data = new Set<(data: Uint8Array) => void>();
  #exit = new Set<(exit: TerminalExit) => void>();

  emit(text: string): void {
    const bytes = encoder.encode(text);
    this.screen += text;
    for (const l of this.#data) l(bytes);
  }
  finish(exitCode: number): void {
    this.exit = { exitCode };
    for (const l of this.#exit) l(this.exit);
  }
  write(data: Uint8Array | string): void {
    this.written.push(typeof data === "string" ? data : decoder.decode(data));
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  onData(listener: (data: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }
  onExit(listener: (exit: TerminalExit) => void): () => void {
    this.#exit.add(listener);
    return () => this.#exit.delete(listener);
  }
  async snapshot(): Promise<Uint8Array> {
    return encoder.encode(`[screen]${this.screen}`);
  }
  pause(): void {
    this.paused++;
  }
  resume(): void {
    this.paused--;
  }
  kill(): void {
    this.finish(-1);
  }
}

function open(flow?: { highWaterBytes?: number; lowWaterBytes?: number; ackTimeoutMs?: number }) {
  const lifecycle: AgentEvent[] = [];
  const now = Date.now();
  const session = new TerminalSession(
    {
      id: "tm_1",
      kind: "terminal",
      provider: "terminal",
      providerSessionId: null,
      cwd: "/tmp",
      title: null,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      cols: 80,
      rows: 24,
    },
    (e) => lifecycle.push(e),
    flow,
  );
  const terminal = new StubTerminal();
  session.bind(terminal);
  return { session, terminal, lifecycle };
}

function listener() {
  const events: AgentEvent[] = [];
  const frames: string[] = [];
  const l: TerminalListener = {
    event: (e) => events.push(e),
    bytes: (frame) => {
      const decoded = decodeTerminalFrame(frame);
      assert.ok(decoded);
      assert.equal(decoded.kind, TERMINAL_FRAME_OUTPUT);
      assert.equal(decoded.sessionId, "tm_1");
      frames.push(decoder.decode(decoded.payload));
    },
  };
  return { l, events, frames };
}

test("output is framed to listeners, input reaches the shell, resize is announced", () => {
  const { session, terminal, lifecycle } = open();
  assert.equal(session.info.status, "running");
  assert.equal(session.info.pid, 4242);
  const a = listener();
  session.attach(a.l, "c1");

  terminal.emit("hello");
  assert.deepEqual(a.frames, ["hello"]);

  session.write(encoder.encode("ls\r"));
  assert.deepEqual(terminal.written, ["ls\r"]);

  session.resize(120, 40);
  assert.equal(terminal.cols, 120);
  assert.equal(session.info.cols, 120);
  const size = a.events.find((e) => e.type === "terminal.size");
  assert.ok(size && size.type === "terminal.size");
  assert.deepEqual(size.payload, { cols: 120, rows: 40 });
  assert.ok(lifecycle.some((e) => e.type === "session.updated"));
  for (const e of a.events) AgentEvent.parse(e);
});

test("catching up sends a reset and the screen to everyone, with the shell paused meanwhile", async () => {
  const { session, terminal } = open();
  terminal.emit("before");
  const a = listener();
  const attachment = session.attach(a.l, "c1");
  assert.equal(a.frames.length, 0, "nothing until the client catches up");

  const catchUp = attachment.catchUp();
  assert.equal(terminal.paused, 1, "paused while the snapshot is taken");
  await catchUp;
  assert.equal(terminal.paused, 0);
  assert.equal(a.events[0]?.type, "terminal.reset");
  assert.deepEqual(a.frames, ["[screen]before"]);

  const b = listener();
  await session.attach(b.l, "c2").catchUp();
  // The relay cannot address one client, so the first listener saw the second reset too.
  assert.equal(a.events.filter((e) => e.type === "terminal.reset").length, 2);
  assert.deepEqual(b.frames, ["[screen]before"]);
});

test("the shell is paused when the slowest client falls behind and resumed when it acks", () => {
  const { session, terminal } = open({ highWaterBytes: 100, lowWaterBytes: 40, ackTimeoutMs: 60_000 });
  const fast = listener();
  const slow = listener();
  session.attach(fast.l, "fast");
  session.attach(slow.l, "slow");

  terminal.emit("x".repeat(80));
  assert.equal(session.paused, false);
  terminal.emit("y".repeat(40)); // 120 outstanding for both
  assert.equal(session.paused, true);
  assert.equal(terminal.paused, 1);

  session.ack("fast", 120);
  assert.equal(session.paused, true, "the slow one still owes 120");
  session.ack("slow", 70); // 50 outstanding: above the low-water mark
  assert.equal(session.paused, true);
  session.ack("slow", 90); // 30 outstanding
  assert.equal(session.paused, false);
  assert.equal(terminal.paused, 0);
});

test("a client that stops acking is dropped from flow control after the timeout", async () => {
  const { session, terminal } = open({ highWaterBytes: 10, lowWaterBytes: 5, ackTimeoutMs: 30 });
  const dead = listener();
  session.attach(dead.l, "dead");
  terminal.emit("x".repeat(20));
  assert.equal(session.paused, true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(session.paused, false, "resumed once the silent client was written off");
});

test("a late client's acks count from its own attach", () => {
  const { session, terminal } = open({ highWaterBytes: 50, lowWaterBytes: 10, ackTimeoutMs: 60_000 });
  terminal.emit("x".repeat(1000)); // Nobody attached: no flow control.
  assert.equal(session.paused, false);
  const late = listener();
  session.attach(late.l, "late");
  terminal.emit("y".repeat(30));
  assert.equal(session.paused, false);
  session.ack("late", 30);
  terminal.emit("z".repeat(60));
  assert.equal(session.paused, true);
  session.ack("late", 90);
  assert.equal(session.paused, false);
});

test("detaching a client removes it from flow control", () => {
  const { session, terminal } = open({ highWaterBytes: 10, lowWaterBytes: 5, ackTimeoutMs: 60_000 });
  const a = listener();
  const attachment = session.attach(a.l, "a");
  terminal.emit("x".repeat(20));
  assert.equal(session.paused, true);
  attachment.detach();
  assert.equal(session.paused, false);
  terminal.emit("more");
  assert.equal(a.frames.length, 1, "a detached listener hears nothing more");
});

test("the shell exiting closes the session with its exit code", async () => {
  const { session, terminal, lifecycle } = open();
  terminal.finish(7);
  await new Promise((r) => setImmediate(r));
  assert.equal(session.closed, true);
  assert.equal(session.info.exitCode, 7);
  const closed = lifecycle.find((e) => e.type === "session.closed");
  assert.ok(closed && closed.type === "session.closed");
  assert.equal(closed.payload.exitCode, 7);
  assert.throws(() => session.write(encoder.encode("x")), { code: "conflict" });
});

test("kill ends the shell", async () => {
  const { session, terminal } = open();
  session.kill();
  assert.ok(terminal.exit);
  await new Promise((r) => setImmediate(r));
  assert.equal(session.closed, true);
});
