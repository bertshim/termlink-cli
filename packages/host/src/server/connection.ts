import {
  Command,
  PROTOCOL_VERSION,
  TERMINAL_FRAME_INPUT,
  decodeTerminalFrame,
  type CommandResults,
  type CommandType,
  type ErrorCode,
  type HostInfo,
  type HostMessage,
} from "@termlink/protocol";
import { HostError, errorMessage } from "../errors.js";
import type { SessionManager } from "../session/manager.js";
import type { AgentSession } from "../session/session.js";
import { TerminalSession } from "../session/terminal-session.js";
import { UploadManager } from "../session/uploads.js";
import { TRACE, traceMark, traceTurnBegin } from "../util/trace.js";

type Send = (message: HostMessage) => void;

/** How messages reach the client. Binary frames carry terminal bytes; a transport without them has no terminals. */
export interface ConnectionTransport {
  send: Send;
  sendBinary?: ((frame: Uint8Array) => void) | undefined;
}

/**
 * One client's view of the host, independent of transport. The local WebSocket
 * server and the relay link both use it.
 */
export class ClientConnection {
  readonly #manager: SessionManager;
  readonly #send: Send;
  readonly #sendBinary: (frame: Uint8Array) => void;
  readonly #hostInfo: () => Promise<HostInfo>;
  readonly #attachments = new Map<string, () => void>();
  /** Files this connection is sending into session folders. */
  readonly #uploads: UploadManager;
  #unsubscribeHost: (() => void) | null = null;
  #disposed = false;

  constructor(manager: SessionManager, transport: Send | ConnectionTransport, hostInfo: () => Promise<HostInfo>) {
    this.#manager = manager;
    this.#uploads = new UploadManager({ folderOf: (sessionId) => manager.get(sessionId).info.cwd });
    const t = typeof transport === "function" ? { send: transport } : transport;
    this.#send = t.send;
    this.#sendBinary = t.sendBinary ?? (() => {});
    this.#hostInfo = hostInfo;
  }

  async open(): Promise<void> {
    this.#unsubscribeHost = this.#manager.onHostEvent((event) => {
      if (event.type === "session.closed" && event.sessionId) this.#attachments.delete(event.sessionId);
      this.#send(event);
    });
    await this.announce();
  }

  /** Sends host.ready. The relay transport repeats it when a new client joins. */
  async announce(): Promise<void> {
    const payload = await this.#hostInfo();
    if (this.#disposed) return;
    this.#send({ v: PROTOCOL_VERSION, kind: "evt", type: "host.ready", ts: Date.now(), payload });
  }

  async handle(raw: string): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.#fail("", "bad_request", "message is not valid JSON");
      return;
    }
    await this.handleMessage(data);
  }

  /**
   * Handles an already parsed message, such as one reassembled from chunks.
   * `receivedAt` (performance.now() when its frame arrived) is only used for tracing.
   */
  async handleMessage(data: unknown, receivedAt?: number): Promise<void> {
    const parsed = Command.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      this.#fail(reqIdOf(data), "bad_request", issues.join("; "));
      return;
    }
    if (TRACE && parsed.data.type === "session.send") traceTurnBegin(parsed.data.payload.sessionId, receivedAt);
    try {
      await this.#dispatch(parsed.data);
    } catch (err) {
      if (err instanceof HostError) this.#fail(parsed.data.reqId, err.code, err.message);
      else this.#fail(parsed.data.reqId, "internal", errorMessage(err));
    }
  }

  /**
   * Terminal input from a binary frame. Only for sessions this connection is attached
   * to; anything else is dropped without a reply, since frames carry no reqId.
   */
  handleBinary(data: Uint8Array): void {
    const frame = decodeTerminalFrame(data);
    if (!frame || frame.kind !== TERMINAL_FRAME_INPUT || !this.#attachments.has(frame.sessionId)) return;
    const session = this.#manager.get(frame.sessionId);
    if (session instanceof TerminalSession && !session.closed) session.write(frame.payload);
  }

  dispose(): void {
    this.#disposed = true;
    for (const detach of this.#attachments.values()) detach();
    this.#attachments.clear();
    this.#unsubscribeHost?.();
    void this.#uploads.dispose();
  }

  // Each case replies itself. Attaching, replying and replaying happen in one
  // synchronous block so no live event can slip in between them.
  async #dispatch(command: Command): Promise<void> {
    const { reqId } = command;
    switch (command.type) {
      case "host.info":
        return this.#ok(reqId, command.type, await this.#hostInfo());
      case "session.list":
        return this.#ok(reqId, command.type, { sessions: this.#manager.list() });
      case "session.create": {
        const session = await this.#manager.create(command.payload);
        if (session instanceof TerminalSession) {
          const attachment = this.#subscribeTerminal(session, command.payload.clientId);
          this.#ok(reqId, command.type, { session: session.info });
          return attachment.catchUp();
        }
        const { replay } = this.#subscribeAgent(session, 0);
        this.#ok(reqId, command.type, { session: session.info });
        return replay.forEach(this.#send);
      }
      case "session.attach": {
        const session = this.#manager.get(command.payload.sessionId);
        if (session instanceof TerminalSession) {
          const attachment = this.#subscribeTerminal(session, command.payload.clientId);
          this.#ok(reqId, command.type, { session: session.info, gap: false, oldestSeq: 0, replayed: 0 });
          return attachment.catchUp();
        }
        const { replay, gap, oldestSeq } = this.#subscribeAgent(session, command.payload.afterSeq ?? 0);
        this.#ok(reqId, command.type, { session: session.info, gap, oldestSeq, replayed: replay.length });
        return replay.forEach(this.#send);
      }
      case "session.detach":
        this.#detach(command.payload.sessionId);
        return this.#ok(reqId, command.type, {});
      case "session.send":
        await this.#manager.agent(command.payload.sessionId).send(command.payload.input);
        this.#ok(reqId, command.type, {});
        if (TRACE) traceMark(command.payload.sessionId, "ack");
        return;
      case "session.interrupt":
        await this.#manager.agent(command.payload.sessionId).interrupt();
        return this.#ok(reqId, command.type, {});
      case "session.close":
        await this.#manager.close(command.payload.sessionId, "closed by client");
        return this.#ok(reqId, command.type, {});
      case "session.configure": {
        const { sessionId, ...settings } = command.payload;
        const session = this.#manager.agent(sessionId);
        session.configure(settings);
        return this.#ok(reqId, command.type, { session: session.info });
      }
      case "input.respond": {
        const { sessionId, requestId, decisionId, answers } = command.payload;
        this.#manager.agent(sessionId).respond(requestId, decisionId, answers);
        return this.#ok(reqId, command.type, {});
      }
      case "terminal.resize": {
        const session = this.#manager.terminal(command.payload.sessionId);
        session.resize(command.payload.cols, command.payload.rows);
        return this.#ok(reqId, command.type, { session: session.info });
      }
      case "terminal.ack":
        this.#manager.terminal(command.payload.sessionId).ack(command.payload.clientId, command.payload.bytes);
        return this.#ok(reqId, command.type, {});
      case "terminal.kill":
        this.#manager.terminal(command.payload.sessionId).kill();
        return this.#ok(reqId, command.type, {});
      case "upload.begin": {
        const { sessionId, name, size } = command.payload;
        return this.#ok(reqId, command.type, await this.#uploads.begin(sessionId, name, size));
      }
      case "upload.chunk": {
        const { uploadId, offset, data } = command.payload;
        return this.#ok(reqId, command.type, await this.#uploads.chunk(uploadId, offset, data));
      }
      case "upload.end":
        return this.#ok(reqId, command.type, await this.#uploads.end(command.payload.uploadId));
      case "upload.abort":
        await this.#uploads.abort(command.payload.uploadId);
        return this.#ok(reqId, command.type, {});
      case "fs.list":
        return this.#ok(reqId, command.type, await this.#manager.listDirectory(command.payload.path));
    }
  }

  #subscribeAgent(session: AgentSession, afterSeq: number) {
    this.#detach(session.id);
    const attachment = session.attach(this.#send, afterSeq);
    this.#attachments.set(session.id, attachment.detach);
    return attachment;
  }

  #subscribeTerminal(session: TerminalSession, clientId: string | undefined) {
    this.#detach(session.id);
    const attachment = session.attach({ event: this.#send, bytes: this.#sendBinary }, clientId);
    this.#attachments.set(session.id, attachment.detach);
    return attachment;
  }

  #detach(sessionId: string): void {
    this.#attachments.get(sessionId)?.();
    this.#attachments.delete(sessionId);
  }

  #ok<T extends CommandType>(reqId: string, _type: T, result: CommandResults[T]): void {
    this.#send({ v: PROTOCOL_VERSION, kind: "res", reqId, ok: true, result });
  }

  #fail(reqId: string, code: ErrorCode, message: string): void {
    this.#send({ v: PROTOCOL_VERSION, kind: "res", reqId, ok: false, error: { code, message } });
  }
}

function reqIdOf(data: unknown): string {
  if (typeof data === "object" && data !== null && "reqId" in data && typeof data.reqId === "string") {
    return data.reqId.slice(0, 64);
  }
  return "";
}
