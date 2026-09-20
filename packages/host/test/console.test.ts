import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { AgentEvent, SessionInfo } from "@termlink/protocol";
import { HostConsole, TICK_MS, fit, sessionEventLine, sessionSummary, statusText, type HostStatus } from "../src/ui/console.js";

const labels = { terminal: "Terminal", claude: "Claude", codex: "Codex" };

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ag_1",
    kind: "agent",
    provider: "claude",
    providerSessionId: null,
    cwd: "/home/me/work",
    title: null,
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    lastSeq: 0,
    ...over,
  };
}

const idle: HostStatus = { version: "0.1.2", relay: "online", sessions: [], stopping: false };

test("the session summary counts each kind and what is busy", () => {
  assert.equal(sessionSummary([], labels), "no sessions");
  assert.equal(sessionSummary([session()], labels), "1 session: 1 Claude");
  const busy = [
    session({ status: "running" }),
    session({ id: "tm_1", kind: "terminal", provider: "terminal", status: "running" }),
    session({ id: "ag_2", status: "waiting_input" }),
  ];
  // A terminal is always "running"; only agents count as working.
  assert.equal(sessionSummary(busy, labels), "3 sessions: 2 Claude, 1 Terminal; 1 working, 1 waiting for you");
});

test("the session summary counts a session waiting out a usage-limit auto-retry", () => {
  const waiting = [session({ status: "rate_limited" })];
  assert.equal(sessionSummary(waiting, labels), "1 session: 1 Claude; 1 rate-limited");
});

test("the status line moves its dots, says how to stop, and carries no address", () => {
  const frames = [0, 1, 2, 3].map((f) => statusText(idle, f, labels));
  assert.equal(new Set(frames).size, 4);
  assert.equal(frames[0], "termlink 0.1.2 running.   | online | no sessions | Ctrl+C to stop");
  for (const text of frames) {
    assert.equal(text.length, frames[0]?.length, "the line keeps its width while the dots move");
    assert.doesNotMatch(text, /wss?:|token|\d+\.\d+\.\d+\.\d+|:\d{4,5}\b/);
  }
  assert.match(statusText({ ...idle, stopping: true }, 0, labels), /stopping.*please wait/);
});

test("a long status line is cut to the window", () => {
  const text = "x".repeat(200);
  assert.equal(fit(text, 60).length, 59);
  assert.ok(fit(text, 60).endsWith("..."));
  assert.equal(fit("short", 60), "short");
});

test("sessions opened and closed become one line each; other events none", () => {
  const created = { type: "session.created", payload: { session: session() } } as AgentEvent;
  assert.equal(sessionEventLine(created, labels), "+ Claude session opened in work");
  const shell = session({ id: "tm_1", kind: "terminal", provider: "terminal", exitCode: 0 });
  const closed = { type: "session.closed", payload: { session: shell, reason: null } } as AgentEvent;
  assert.equal(sessionEventLine(closed, labels), "- Terminal session closed (exit 0)");
  const byClient = { type: "session.closed", payload: { session: session(), reason: "closed by client" } } as AgentEvent;
  assert.equal(sessionEventLine(byClient, labels), "- Claude session closed (closed by client)");
  assert.equal(sessionEventLine({ type: "session.updated", payload: { session: session() } } as AgentEvent, labels), null);
});

/** A stand-in for stdout that records writes and the cursor moves between them. */
function fakeOut(isTTY: boolean) {
  const writes: string[] = [];
  const out = {
    isTTY,
    columns: 120,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    cursorTo: (x: number) => {
      writes.push(`<to${x}>`);
      return true;
    },
    clearLine: (dir: number) => {
      writes.push(`<clear${dir}>`);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, writes };
}

test("off a terminal it writes plain lines with the time, and nothing moves", () => {
  const { out, writes } = fakeOut(false);
  const ui = new HostConsole({ out, labels, status: () => idle, now: () => new Date(2026, 8, 13, 9, 5, 7) });
  assert.equal(ui.live, false);
  ui.start();
  ui.print("termlink 0.1.2");
  ui.event("+ Claude session opened in work");
  ui.refresh();
  ui.stop();
  assert.deepEqual(writes, ["termlink 0.1.2\n", "09:05:07 + Claude session opened in work\n"]);
});

test("on a terminal the status line steps aside for each line and comes back under it", (t) => {
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  const { out, writes } = fakeOut(true);
  const ui = new HostConsole({ out, labels, status: () => idle, live: true, now: () => new Date(2026, 8, 13, 9, 5, 7) });
  ui.start();
  const first = statusText(idle, 0, labels);
  assert.deepEqual(writes.splice(0), ["<to0>", first, "<clear1>"]);

  ui.event("+ Claude session opened in work");
  assert.deepEqual(writes.splice(0), ["<to0>", "<clear0>", "09:05:07 + Claude session opened in work\n", "<to0>", first, "<clear1>"]);

  mock.timers.tick(TICK_MS);
  assert.deepEqual(writes.splice(0), ["<to0>", statusText(idle, 1, labels), "<clear1>"]);

  ui.stop();
  assert.deepEqual(writes.splice(0), ["<to0>", "<clear0>"]);
  mock.timers.tick(TICK_MS * 3);
  assert.deepEqual(writes, [], "nothing is drawn after stop");
});

test("a dumb terminal or CI gets plain lines", () => {
  const { out } = fakeOut(true);
  assert.equal(HostConsole.canAnimate(out, {}), true);
  assert.equal(HostConsole.canAnimate(out, { TERM: "dumb" }), false);
  assert.equal(HostConsole.canAnimate(out, { CI: "true" }), false);
  assert.equal(HostConsole.canAnimate(fakeOut(false).out, {}), false);
});
