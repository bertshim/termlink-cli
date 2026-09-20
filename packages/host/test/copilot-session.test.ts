import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "@termlink/protocol";
import type { EventSink } from "../src/providers/types.js";
import { CopilotAcpSession } from "../src/providers/copilot/session.js";
import type { CopilotAcpServer } from "../src/providers/copilot/acp-server.js";

/** A session/prompt this test resolves by hand, to drive interrupt()'s own timeout without
 *  waiting out a real one. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake CopilotAcpServer whose session/prompt calls this test controls the timing of. Only
 *  what CopilotAcpSession actually touches (peer.request, peer.notify, unregister). */
function fakeServer() {
  const prompts: ReturnType<typeof deferred<{ stopReason: string; usage?: unknown }>>[] = [];
  const server = {
    peer: {
      request: async (method: string) => {
        assert.equal(method, "session/prompt");
        const d = deferred<{ stopReason: string }>();
        prompts.push(d);
        return d.promise;
      },
      notify: () => {},
    },
    unregister: () => {},
  } as unknown as CopilotAcpServer;
  return { server, prompts };
}

function fakeSink(events: AgentEvent[]): EventSink {
  return {
    emit: (type, payload) => events.push({ type, payload } as AgentEvent),
    requestInput: async () => ({ decisionId: null, effect: "cancel" }),
    setProviderSessionId: () => {},
    messageRead: () => {},
    retryLater: () => {},
  };
}

test("a stray session/update from an interrupt() that timed out is dropped, not folded into the next turn", async () => {
  const { server, prompts } = fakeServer();
  const events: AgentEvent[] = [];
  const session = new CopilotAcpSession(server, "ses_1", fakeSink(events), "/repo", { interruptTimeoutMs: 10 });

  await session.send({ text: "go" });
  assert.equal(prompts.length, 1);

  // copilot never answers in time: interrupt() gives up after interruptTimeoutMs. Unlike
  // Cursor, stopReason would never say "cancelled" here even if it did answer (session.ts's
  // own note) — irrelevant to this test since it never gets the chance to answer at all.
  await session.interrupt();
  const completed = events.filter((e) => e.type === "turn.completed");
  assert.equal(completed.length, 1);
  assert.equal((completed[0] as { payload: { status: string } }).payload.status, "interrupted");

  const before = events.length;
  session.notification("session/update", { sessionId: "ses_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } } });
  assert.equal(events.length, before, "a notification while a request is still abandoned must be dropped");

  prompts[0]?.resolve({ stopReason: "end_turn" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(events.filter((e) => e.type === "turn.completed").length, 1, "the late response must not complete the turn a second time");

  await session.send({ text: "again" });
  const afterSend = events.length;
  session.notification("session/update", { sessionId: "ses_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "for real" } } });
  assert.ok(events.length > afterSend, "a notification for the current turn, once nothing is abandoned, must go through");
});
