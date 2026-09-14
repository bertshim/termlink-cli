import { setTimeout as sleep } from "node:timers/promises";
import { applyDelta, type DeltaField, type EventPayload, type Item } from "@termlink/protocol";
import { HostError, errorMessage } from "../../src/errors.js";
import { newId } from "../../src/util/id.js";
import type { EventSink, ProbeResult, ProviderAdapter, ProviderSession, StartOptions, UserInput } from "../../src/providers/types.js";

export interface FakeProviderOptions {
  /** Delay between scripted steps. Tests use 0. */
  stepDelayMs?: number;
  /** Take messages while a turn runs (default). Each is answered "Noted: <text>" before the turn ends. */
  steer?: boolean;
  /** How long interrupt() takes to stop the turn, for tests of what happens meanwhile. */
  interruptDelayMs?: number;
}

/**
 * Scripted provider for building the protocol and the UI without a real agent.
 * "/echo <text>" replies with the text. Anything else plays a fix-the-failing-test turn
 * that asks to run a command, streams its output and edits a file.
 */
export class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  readonly kind = "agent" as const;
  readonly label = "Fake agent";
  readonly steer: boolean;
  readonly #stepDelayMs: number;
  readonly #interruptDelayMs: number;

  constructor(options: FakeProviderOptions = {}) {
    this.#stepDelayMs = options.stepDelayMs ?? 40;
    this.#interruptDelayMs = options.interruptDelayMs ?? 0;
    this.steer = options.steer ?? true;
  }

  async probe(): Promise<ProbeResult> {
    return { available: true, version: "0", detail: "scripted provider for development" };
  }

  async start(options: StartOptions, sink: EventSink): Promise<ProviderSession> {
    sink.setProviderSessionId(newId("fake"));
    const session = new FakeSession(options.cwd, sink, this.#stepDelayMs, this.#interruptDelayMs);
    if (this.steer) return session;
    return { send: (input) => session.send(input), interrupt: () => session.interrupt(), close: () => session.close() };
  }
}

const TEST_OUTPUT = [
  "> test\n",
  "> node --test\n\n",
  "ok 1 - login\n",
  "not ok 2 - refresh token expires\n",
  "\n1 failing\n",
];

const AUTH_DIFF = [
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -12,3 +12,3 @@ export function isExpired(token: Token, now = Date.now()) {",
  "-  return token.expiresAt < now / 1000;",
  "+  return token.expiresAt * 1000 <= now;",
  " }",
].join("\n");

class FakeSession implements ProviderSession {
  readonly #cwd: string;
  readonly #sink: EventSink;
  readonly #delayMs: number;
  readonly #interruptDelayMs: number;
  #turnCount = 0;
  #current: { turn: Turn; abort: AbortController; done: Promise<void> } | null = null;
  #commandsAllowed = false;

  constructor(cwd: string, sink: EventSink, delayMs: number, interruptDelayMs = 0) {
    this.#cwd = cwd;
    this.#sink = sink;
    this.#delayMs = delayMs;
    this.#interruptDelayMs = interruptDelayMs;
  }

  async send(input: UserInput): Promise<void> {
    if (this.#current) throw new HostError("conflict", "a turn is already running");
    const abort = new AbortController();
    const turn = new Turn(`turn_${++this.#turnCount}`, this.#sink, abort.signal, this.#delayMs);
    this.#sink.emit("turn.started", { turnId: turn.id });
    const done = this.#play(turn, input.text);
    this.#current = { turn, abort, done };
  }

  async steer(input: UserInput, itemId: string): Promise<void> {
    const current = this.#current;
    if (!current) return this.send(input);
    current.turn.notes.push({ text: input.text, itemId });
  }

  async interrupt(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    if (this.#interruptDelayMs > 0) await sleep(this.#interruptDelayMs);
    current.abort.abort();
    await current.done;
  }

  async close(): Promise<void> {
    await this.interrupt();
  }

  async #play(turn: Turn, text: string): Promise<void> {
    try {
      if (text.startsWith("/echo ")) await turn.say(text.slice("/echo ".length));
      else await this.#fixFailingTest(turn);
      // Messages sent while it worked, read before the turn ends.
      for (let note = turn.notes.shift(); note !== undefined; note = turn.notes.shift()) {
        this.#sink.messageRead(note.itemId);
        await turn.say(`Noted: ${note.text}`);
      }
      this.#finish(turn, { turnId: turn.id, status: "completed", usage: { inputTokens: 1200, outputTokens: 180 } });
    } catch (err) {
      turn.abandonOpenItems();
      this.#finish(
        turn,
        turn.signal.aborted
          ? { turnId: turn.id, status: "interrupted" }
          : { turnId: turn.id, status: "failed", error: errorMessage(err) },
      );
    }
  }

  // Clear the running turn before announcing completion, so a client that sends the
  // next message as soon as it sees turn.completed is not rejected.
  #finish(turn: Turn, payload: EventPayload<"turn.completed">): void {
    if (this.#current?.turn === turn) this.#current = null;
    this.#sink.emit("turn.completed", payload);
  }

  async #fixFailingTest(turn: Turn): Promise<void> {
    await turn.say("I'll run the test suite first to see what is failing.");
    await turn.pause();

    const command = turn.start({
      id: newId("it"),
      kind: "command",
      command: "npm test",
      cwd: this.#cwd,
      status: "in_progress",
    });
    if (!this.#commandsAllowed) {
      const answer = await this.#sink.requestInput(
        {
          kind: "command_approval",
          itemId: command.id,
          title: "Run npm test?",
          command: "npm test",
          cwd: this.#cwd,
          decisions: [
            { id: "allow", label: "Allow", effect: "allow" },
            { id: "allow_session", label: "Allow for this session", effect: "allow_session" },
            { id: "deny", label: "Deny", effect: "deny" },
          ],
        },
        turn.signal,
      );
      if (answer.effect === "allow_session") this.#commandsAllowed = true;
      if (answer.effect !== "allow" && answer.effect !== "allow_session") {
        turn.complete({ ...command, status: "declined" });
        await turn.say("Okay, I won't run it. Tell me how you'd like to go on.");
        return;
      }
    }
    for (const chunk of TEST_OUTPUT) {
      await turn.pause();
      turn.delta(command.id, "output", chunk);
    }
    turn.complete({ ...command, output: TEST_OUTPUT.join(""), exitCode: 1, status: "completed" });

    await turn.say("The refresh token test fails because expiresAt is in seconds. Fixing the comparison.");
    await turn.pause();
    const edit = turn.start({
      id: newId("it"),
      kind: "file_change",
      changes: [{ path: "src/auth.ts", action: "modify", diff: AUTH_DIFF }],
      status: "in_progress",
    });
    await turn.pause();
    turn.complete({ ...edit, status: "completed" });

    await turn.say("Fixed the expiry check in src/auth.ts.");
  }
}

/** One scripted turn. Tracks open items so an interrupt can close them out. */
class Turn {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Messages steered into this turn, not yet answered. */
  readonly notes: { text: string; itemId: string }[] = [];
  readonly #sink: EventSink;
  readonly #delayMs: number;
  readonly #open = new Map<string, Item>();

  constructor(id: string, sink: EventSink, signal: AbortSignal, delayMs: number) {
    this.id = id;
    this.#sink = sink;
    this.signal = signal;
    this.#delayMs = delayMs;
  }

  async pause(): Promise<void> {
    await sleep(this.#delayMs, undefined, { signal: this.signal });
  }

  start<I extends Item>(item: I): I {
    this.#open.set(item.id, item);
    this.#sink.emit("item.started", { turnId: this.id, item });
    return item;
  }

  delta(itemId: string, field: DeltaField, delta: string): void {
    const item = this.#open.get(itemId);
    if (item) this.#open.set(itemId, applyDelta(item, field, delta));
    this.#sink.emit("item.delta", { itemId, field, delta });
  }

  complete(item: Item): void {
    this.#open.delete(item.id);
    this.#sink.emit("item.completed", { turnId: this.id, item });
  }

  async say(text: string): Promise<void> {
    const item = this.start({ id: newId("it"), kind: "message", role: "assistant", text: "", status: "in_progress" });
    const words = text.split(" ");
    for (const [i, word] of words.entries()) {
      await this.pause();
      this.delta(item.id, "text", i === 0 ? word : ` ${word}`);
    }
    this.complete({ ...item, text, status: "completed" });
  }

  abandonOpenItems(): void {
    for (const item of [...this.#open.values()]) this.complete({ ...item, status: "interrupted" });
  }
}
