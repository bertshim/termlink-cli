import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { errorMessage } from "../../errors.js";
import type { RequestId } from "./protocol.js";

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** Returned by a request handler when the request was withdrawn and must not be answered. */
export const NO_RESPONSE: unique symbol = Symbol("no-response");

export type RequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

interface Incoming {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** JSON-RPC over newline-delimited JSON, as spoken by `codex app-server`. */
export class JsonRpcPeer {
  onNotification: NotificationHandler = () => {};
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(-32601, `method not found: ${method}`);
  };
  onClose: (reason: Error) => void = () => {};

  readonly #output: Writable;
  readonly #pending = new Map<RequestId, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  #nextId = 1;
  #closed: Error | null = null;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receive(line));
    lines.on("close", () => this.close(new Error("connection closed")));
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  request<R>(method: string, params: unknown): Promise<R> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise<R>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.#closed) this.#write(params === undefined ? { method } : { method, params });
  }

  close(reason: Error): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
    this.onClose(reason);
  }

  #write(message: object): void {
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    if (!line.trim()) return;
    let message: Incoming;
    try {
      message = JSON.parse(line) as Incoming;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;

    if (typeof message.method === "string") {
      if (id === undefined) this.onNotification(message.method, message.params);
      else void this.#answer(id, message.method, message.params);
      return;
    }
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (message.error) pending.reject(new RpcError(message.error.code ?? -32000, message.error.message ?? "error"));
    else pending.resolve(message.result);
  }

  async #answer(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params, id);
      if (result === NO_RESPONSE || this.#closed) return;
      this.#write({ id, result });
    } catch (err) {
      if (this.#closed) return;
      const code = err instanceof RpcError ? err.code : -32603;
      this.#write({ id, error: { code, message: errorMessage(err) } });
    }
  }
}
