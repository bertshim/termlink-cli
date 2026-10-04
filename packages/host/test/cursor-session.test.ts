import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "@termlink/protocol";
import type { EventSink } from "../src/providers/types.js";
import { CursorAcpSession } from "../src/providers/cursor/session.js";
import type { CursorAcpServer } from "../src/providers/cursor/acp-server.js";

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

/** A fake CursorAcpServer whose session/prompt calls this test controls the timing of, and
 *  whose other requests (session/cancel is a notify, never awaited) just no-op. Only what
 *  CursorAcpSession actually touches (peer.request, peer.notify, unregister). */
function fakeServer() {
  const prompts: ReturnType<typeof deferred<{ stopReason: string; usage?: unknown }>>[] = [];
  const notified: { method: string; params: unknown }[] = [];
  const server = {
    peer: {
      request: async (method: string) => {
        assert.equal(method, "session/prompt");
        const d = deferred<{ stopReason: string }>();
        prompts.push(d);
        return d.promise;
      },
      notify: (method: string, params: unknown) => {
        notified.push({ method, params });
      },
    },
    unregister: () => {},
  } as unknown as CursorAcpServer;
  return { server, prompts, notified };
}

function fakeSink(events: AgentEvent[]): EventSink {
  return {
    emit: (type, payload) => events.push({ type, payload } as AgentEvent),
    requestInput: async () => ({ decisionId: null, effect: "cancel" }),
    setProviderSessionId: () => {},
    setModel: () => {},
    setLimits: () => {},
    messageRead: () => {},
    retryLater: () => {},
  };
}

test("a stray session/update from an interrupt() that timed out is dropped, not folded into the next turn", async () => {
  const { server, prompts } = fakeServer();
  const events: AgentEvent[] = [];
  const session = new CursorAcpSession(server, "ses_1", fakeSink(events), "/repo", { interruptTimeoutMs: 10 });

  await session.send({ text: "go" });
  assert.equal(prompts.length, 1);

  // cursor-agent never answers in time: interrupt() gives up after interruptTimeoutMs.
  await session.interrupt();
  const completed = events.filter((e) => e.type === "turn.completed");
  assert.equal(completed.length, 1);
  assert.equal((completed[0] as { payload: { status: string } }).payload.status, "interrupted");

  // The abandoned request is still "live" as far as cursor-agent is concerned, and can
  // still stream for it — this must not surface as a message on whatever turn is next.
  const before = events.length;
  session.notification("session/update", { sessionId: "ses_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } } });
  assert.equal(events.length, before, "a notification while a request is still abandoned must be dropped");

  // The abandoned request finally resolves late: this only clears the suppression, it must
  // not resurrect the already-finished turn.
  prompts[0]?.resolve({ stopReason: "end_turn" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(events.filter((e) => e.type === "turn.completed").length, 1, "the late response must not complete the turn a second time");

  // A fresh turn's own notifications are trusted again now that nothing is abandoned.
  await session.send({ text: "again" });
  const afterSend = events.length;
  session.notification("session/update", { sessionId: "ses_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "for real" } } });
  assert.ok(events.length > afterSend, "a notification for the current turn, once nothing is abandoned, must go through");
});
