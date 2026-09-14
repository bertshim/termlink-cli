import {
  PROTOCOL_VERSION,
  TERMINAL_FRAME_OUTPUT,
  encodeTerminalFrames,
  type AgentEvent,
  type EventPayload,
  type EventType,
  type SessionInfo,
} from "@termlink/protocol";
import type { Terminal } from "@termlink/terminal";
import { HostError } from "../errors.js";
import type { Listener } from "./session.js";

export interface TerminalListener {
  /** JSON events for this session: terminal.size, terminal.reset. */
  event: Listener;
  /** Output bytes, already framed. */
  bytes: (frame: Uint8Array) => void;
}

export interface TerminalAttachment {
  detach: () => void;
  /** Sends terminal.reset and the current screen to everyone attached. Call after the attach reply. */
  catchUp: () => Promise<void>;
}

export interface FlowControlOptions {
  /** Unacknowledged output that pauses the shell. */
  highWaterBytes?: number | undefined;
  /** Unacknowledged output below which a paused shell resumes. */
  lowWaterBytes?: number | undefined;
  /** A client that owes an ack for this long is treated as gone. */
  ackTimeoutMs?: number | undefined;
}

const DEFAULT_FLOW = { highWaterBytes: 512 * 1024, lowWaterBytes: 128 * 1024, ackTimeoutMs: 5_000 };

interface FlowClient {
  /** Output sent before this client attached; its acks count from here. */
  base: number;
  acked: number;
  lastAckAt: number;
}

/**
 * One terminal session: a shell in a PTY and the connections watching it. Output is
 * broadcast as binary frames; there is no replay log, a late client gets the screen.
 *
 * Flow control: clients say how much output they have drawn (terminal.ack). When the
 * slowest one falls too far behind, the shell is paused, so a slow link is not dropped
 * by the relay for failing to keep up. A client that stops acking is dropped from the
 * calculation after a timeout, so one dead browser tab cannot freeze the shell.
 */
export class TerminalSession {
  readonly id: string;
  readonly #info: SessionInfo;
  readonly #onLifecycle: Listener;
  readonly #listeners = new Set<TerminalListener>();
  readonly #clients = new Map<string, FlowClient>();
  readonly #flow: Required<FlowControlOptions>;
  #terminal: Terminal | null = null;
  #sent = 0;
  #pausedForFlow = false;
  #pausedForCatchUp = 0;
  #flowTimer: NodeJS.Timeout | null = null;

  constructor(info: SessionInfo, onLifecycle: Listener, flow: FlowControlOptions = {}) {
    this.id = info.id;
    this.#info = info;
    this.#onLifecycle = onLifecycle;
    this.#flow = {
      highWaterBytes: flow.highWaterBytes ?? DEFAULT_FLOW.highWaterBytes,
      lowWaterBytes: flow.lowWaterBytes ?? DEFAULT_FLOW.lowWaterBytes,
      ackTimeoutMs: flow.ackTimeoutMs ?? DEFAULT_FLOW.ackTimeoutMs,
    };
  }

  get info(): SessionInfo {
    return { ...this.#info };
  }

  get closed(): boolean {
    return this.#info.status === "closed";
  }

  /** Bytes of output sent so far. For tests. */
  get sentBytes(): number {
    return this.#sent;
  }

  get paused(): boolean {
    return this.#pausedForFlow;
  }

  announce(): void {
    this.#onLifecycle(this.#event("session.created", { session: this.info }));
  }

  bind(terminal: Terminal): void {
    this.#terminal = terminal;
    this.#info.pid = terminal.pid;
    this.#info.cols = terminal.cols;
    this.#info.rows = terminal.rows;
    terminal.onData((data) => this.#output(data));
    terminal.onExit((exit) => void this.close("the shell exited", exit.exitCode));
    this.#setStatus("running");
  }

  attach(listener: TerminalListener, clientId?: string): TerminalAttachment {
    if (this.closed) throw new HostError("conflict", "session is closed");
    this.#listeners.add(listener);
    if (clientId) this.#clients.set(clientId, { base: this.#sent, acked: 0, lastAckAt: Date.now() });
    return {
      detach: () => {
        this.#listeners.delete(listener);
        if (clientId) this.forgetClient(clientId);
      },
      catchUp: () => this.#catchUp(),
    };
  }

  /** A client left without detaching its attachment (session.detach with a clientId). */
  forgetClient(clientId: string): void {
    if (this.#clients.delete(clientId)) this.#applyFlow();
  }

  write(data: Uint8Array): void {
    if (this.closed) throw new HostError("conflict", "session is closed");
    this.#terminal?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.closed) throw new HostError("conflict", "session is closed");
    if (!this.#terminal) throw new HostError("conflict", "session is still starting");
    this.#terminal.resize(cols, rows);
    this.#info.cols = cols;
    this.#info.rows = rows;
    this.#emit("terminal.size", { cols, rows });
    this.#announce();
  }

  ack(clientId: string, bytes: number): void {
    const client = this.#clients.get(clientId);
    if (!client) return; // Attached without a clientId, or already dropped: not part of flow control.
    client.acked = Math.max(client.acked, bytes);
    client.lastAckAt = Date.now();
    this.#applyFlow();
  }

  kill(): void {
    if (this.closed) throw new HostError("conflict", "session is closed");
    this.#terminal?.kill();
  }

  async close(reason: string | null, exitCode: number | null = null): Promise<void> {
    if (this.closed) return;
    if (this.#flowTimer) clearTimeout(this.#flowTimer);
    this.#flowTimer = null;
    const terminal = this.#terminal;
    this.#terminal = null;
    if (terminal && !terminal.exit) terminal.kill();
    this.#info.status = "closed";
    this.#info.exitCode = exitCode;
    this.#info.updatedAt = Date.now();
    this.#onLifecycle(this.#event("session.closed", { session: this.info, reason, exitCode }));
    this.#listeners.clear();
    this.#clients.clear();
  }

  async #catchUp(): Promise<void> {
    const terminal = this.#terminal;
    if (!terminal || this.closed) return;
    // Nothing new arrives while the snapshot is taken, so the screen and what follows
    // it never overlap.
    this.#pausedForCatchUp++;
    terminal.pause();
    try {
      this.#emit("terminal.reset", { cols: terminal.cols, rows: terminal.rows });
      const snapshot = await terminal.snapshot();
      if (snapshot.length > 0) this.#output(snapshot);
    } finally {
      this.#pausedForCatchUp--;
      if (this.#pausedForCatchUp === 0 && !this.#pausedForFlow) terminal.resume();
    }
  }

  #output(data: Uint8Array): void {
    if (this.closed) return;
    this.#sent += data.length;
    const frames = encodeTerminalFrames(TERMINAL_FRAME_OUTPUT, this.id, data);
    for (const listener of this.#listeners) for (const frame of frames) listener.bytes(frame);
    this.#applyFlow();
  }

  #applyFlow(): void {
    const terminal = this.#terminal;
    if (!terminal) return;
    const now = Date.now();
    let worstLag = 0;
    for (const [clientId, client] of this.#clients) {
      const lag = this.#sent - client.base - client.acked;
      if (lag > 0 && now - client.lastAckAt > this.#flow.ackTimeoutMs) {
        this.#clients.delete(clientId); // Gone, or too slow to matter: the relay has dropped it by now.
        continue;
      }
      worstLag = Math.max(worstLag, lag);
    }
    const shouldPause = this.#pausedForFlow ? worstLag > this.#flow.lowWaterBytes : worstLag > this.#flow.highWaterBytes;
    if (shouldPause !== this.#pausedForFlow) {
      this.#pausedForFlow = shouldPause;
      if (this.#pausedForCatchUp === 0) {
        if (shouldPause) terminal.pause();
        else terminal.resume();
      }
    }
    // A paused shell with a silent client would wait forever; look again after the timeout.
    if (this.#flowTimer) clearTimeout(this.#flowTimer);
    this.#flowTimer = null;
    if (shouldPause) {
      this.#flowTimer = setTimeout(() => this.#applyFlow(), this.#flow.ackTimeoutMs + 50);
      this.#flowTimer.unref();
    }
  }

  #event<T extends EventType>(type: T, payload: EventPayload<T>): AgentEvent {
    return { v: PROTOCOL_VERSION, kind: "evt", type, ts: Date.now(), sessionId: this.id, payload } as AgentEvent;
  }

  #emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    if (this.closed) return;
    const event = this.#event(type, payload);
    for (const listener of this.#listeners) listener.event(event);
  }

  #setStatus(status: SessionInfo["status"]): void {
    if (this.closed || this.#info.status === status) return;
    this.#info.status = status;
    this.#announce();
  }

  #announce(): void {
    this.#info.updatedAt = Date.now();
    this.#onLifecycle(this.#event("session.updated", { session: this.info }));
  }
}
