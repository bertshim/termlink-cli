import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CopilotCommand } from "./command.js";
import type { AuthenticateParams, InitializeParams, InitializeResponse, RequestId } from "./protocol.js";
import { JsonRpcPeer, RpcError } from "../rpc.js";

/** Receives the notifications and server requests that belong to one ACP session. */
export interface AcpSessionHandler {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown, id: RequestId): Promise<unknown>;
  /** The copilot process went away. */
  closed(reason: Error): void;
}

/** The only auth method `copilot --acp` has ever advertised, live-measured — it maps to
 *  whatever `copilot login` already stored (system credential store, or env token). */
const AUTH_METHOD = "copilot-login";

/**
 * One long-lived `copilot --acp` process shared by every Copilot session on this host, the
 * same sharing cursor/acp-server.ts's own CursorAcpServer does for `cursor-agent acp`.
 * Routes session/update notifications and session/request_permission to sessions by the
 * sessionId ACP itself puts in `params`.
 */
export class CopilotAcpServer {
  readonly peer: JsonRpcPeer;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #sessions = new Map<string, AcpSessionHandler>();
  readonly #stderrTail: string[] = [];
  #onExit: (reason: Error) => void = () => {};

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.peer = new JsonRpcPeer(child.stdout, child.stdin);
    this.peer.onNotification = (method, params) => this.#sessionFor(params)?.notification(method, params);
    this.peer.onRequest = async (method, params, id) => {
      const session = this.#sessionFor(params);
      if (!session) throw new RpcError(-32601, `${method} has no session on this client`);
      return session.request(method, params, id);
    };
    this.peer.onClose = (reason) => {
      for (const session of this.#sessions.values()) session.closed(reason);
      this.#sessions.clear();
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
      this.peer.close(new Error(`copilot --acp exited (${signal ?? code})${tail ? `: ${tail}` : ""}`));
    });
  }

  static async start(command: CopilotCommand, onExit: (reason: Error) => void): Promise<CopilotAcpServer> {
    const child = spawn(command.file, [...command.args, "--acp"], {
      stdio: "pipe",
      windowsHide: true,
      shell: command.shell,
    });
    const server = new CopilotAcpServer(child as ChildProcessWithoutNullStreams);
    server.#onExit = onExit;
    try {
      const params: InitializeParams = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } };
      const init = await server.peer.request<InitializeResponse>("initialize", params);
      if (!init.authMethods.some((m) => m.id === AUTH_METHOD)) {
        throw new Error(`copilot --acp offered no "${AUTH_METHOD}" auth method (has it been updated?)`);
      }
      await server.peer.request("authenticate", { methodId: AUTH_METHOD } satisfies AuthenticateParams);
    } catch (err) {
      server.close();
      throw err;
    }
    return server;
  }

  register(sessionId: string, handler: AcpSessionHandler): void {
    this.#sessions.set(sessionId, handler);
  }

  unregister(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** True while a live session (or history()'s own throwaway collector) already owns this
   *  id's notifications — register() would silently steal them out from under it otherwise. */
  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  close(): void {
    this.#onExit = () => {};
    this.peer.close(new Error("copilot --acp closed by host"));
    this.#child.stdin.end();
    if (this.#child.exitCode !== null) return;
    const pid = this.#child.pid;
    // The installed `copilot` on PATH is npm's own launcher shim (cmd -> node on Windows;
    // command.ts's own comment), spawned with a shell to run it at all. Killing just that
    // top process can leave the real node.exe running: the whole tree has to go.
    if (process.platform === "win32" && pid !== undefined) {
      execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => {});
    } else {
      this.#child.kill();
    }
  }

  #sessionFor(params: unknown): AcpSessionHandler | undefined {
    if (typeof params !== "object" || params === null || !("sessionId" in params)) return undefined;
    return typeof params.sessionId === "string" ? this.#sessions.get(params.sessionId) : undefined;
  }
}
