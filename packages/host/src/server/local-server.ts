import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FrameAssembler, type HostInfo } from "@termlink/protocol";
import { WebSocketServer, type RawData } from "ws";
import type { SessionManager } from "../session/manager.js";
import { TRACE, traceNow, traceSent } from "../util/trace.js";
import { ClientConnection } from "./connection.js";

export interface LocalServerOptions {
  manager: SessionManager;
  hostInfo: () => Promise<HostInfo>;
  token: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** A client that falls this far behind is disconnected rather than buffered without bound. */
  maxBufferedBytes?: number;
}

export interface LocalServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Direct WebSocket endpoint for development and for clients on the same machine.
 * Clients authenticate with ?token=. There is no TLS, so keep it on loopback.
 * Accepts chunked messages like the relay transport, so one client works with both.
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const host = options.host ?? "127.0.0.1";
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;

  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !tokenMatches(url.searchParams.get("token"), options.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const guard = (): boolean => {
        if (ws.readyState !== ws.OPEN) return false;
        if (ws.bufferedAmount > maxBufferedBytes) {
          ws.close(1013, "client is not keeping up");
          return false;
        }
        return true;
      };
      const connection = new ClientConnection(
        options.manager,
        {
          send: (message) => {
            if (!guard()) return;
            ws.send(JSON.stringify(message));
            if (TRACE) traceSent(message);
          },
          sendBinary: (frame) => {
            if (guard()) ws.send(frame, { binary: true });
          },
        },
        options.hostInfo,
      );
      const assembler = new FrameAssembler();
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          connection.handleBinary(toBytes(data));
          return;
        }
        const receivedAt = TRACE ? traceNow() : undefined;
        const text = data.toString();
        let message: unknown;
        try {
          message = assembler.push(text);
        } catch (err) {
          // Not JSON: let the connection answer bad_request. Too large: drop the client.
          if (err instanceof SyntaxError) void connection.handle(text);
          else ws.close(1009, "message too large");
          return;
        }
        if (message !== undefined) void connection.handleMessage(message, receivedAt);
      });
      ws.on("close", () => connection.dispose());
      void connection.open();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 7420, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;

  return {
    url: `ws://${host}:${port}/ws`,
    port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** ws hands binary messages over as a Buffer, an array of them, or an ArrayBuffer. */
export function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
