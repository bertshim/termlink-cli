import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { VERSION } from "../../version.js";
import type { CodexCommand } from "./command.js";
import type { InitializeParams, InitializeResponse, RequestId } from "./protocol.js";
import { JsonRpcPeer, RpcError } from "./rpc.js";

/** Receives the notifications and server requests that belong to one thread. */
export interface ThreadHandler {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown, id: RequestId): Promise<unknown>;
  /** The app-server went away. */
  closed(reason: Error): void;
}

/**
 * One long-lived `codex app-server` process shared by every Codex session on this host.
 * Routes notifications and server requests to threads by their threadId.
 */
export class CodexAppServer {
  readonly peer: JsonRpcPeer;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #threads = new Map<string, ThreadHandler>();
  readonly #stderrTail: string[] = [];
  #onExit: (reason: Error) => void = () => {};

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.peer = new JsonRpcPeer(child.stdout, child.stdin);
    this.peer.onNotification = (method, params) => this.#threadFor(params)?.notification(method, params);
    this.peer.onRequest = async (method, params, id) => {
      const thread = this.#threadFor(params);
      if (!thread) throw new RpcError(-32601, `${method} has no thread on this client`);
      return thread.request(method, params, id);
    };
    this.peer.onClose = (reason) => {
      for (const thread of this.#threads.values()) thread.closed(reason);
      this.#threads.clear();
      this.#onExit(reason);
    };

    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
      this.#stderrTail.splice(0, Math.max(0, this.#stderrTail.length - 20));
    });
    child.on("error", (err) => this.peer.close(err));
    child.on("exit", (code, signal) => {
      const tail = this.#stderrTail.at(-1);
      this.peer.close(new Error(`codex app-server exited (${signal ?? code})${tail ? `: ${tail}` : ""}`));
    });
  }

  static async start(command: CodexCommand, onExit: (reason: Error) => void): Promise<CodexAppServer> {
    const child = spawn(command.file, [...command.args, "app-server"], { stdio: "pipe", windowsHide: true });
    const server = new CodexAppServer(child);
    server.#onExit = onExit;
    try {
      const params: InitializeParams = {
        clientInfo: { name: "termlink_host", title: "TermLink", version: VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      };
      await server.peer.request<InitializeResponse>("initialize", params);
      server.peer.notify("initialized");
    } catch (err) {
      server.close();
      throw err;
    }
    return server;
  }

  register(threadId: string, handler: ThreadHandler): void {
    this.#threads.set(threadId, handler);
  }

  unregister(threadId: string): void {
    this.#threads.delete(threadId);
  }

  close(): void {
    this.#onExit = () => {};
    this.peer.close(new Error("codex app-server closed by host"));
    this.#child.stdin.end();
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #threadFor(params: unknown): ThreadHandler | undefined {
    if (typeof params !== "object" || params === null || !("threadId" in params)) return undefined;
    return typeof params.threadId === "string" ? this.#threads.get(params.threadId) : undefined;
  }
}
