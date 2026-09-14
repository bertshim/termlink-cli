// Minimal stand-in for the TermLink relay: the HTTP
// endpoints a host uses, and a /ws that merges clients into the host socket and
// broadcasts host frames, with the same 64 KB frame limit.
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

export const DEVICE_TOKEN = "tld1.test";

export interface FakeRelay {
  url: string;
  registrations: string[];
  unregistrations: number;
  renewals: number;
  hostQueries: URLSearchParams[];
  /** Kicks the host off, as a relay restart would; clients are dropped too. */
  kickHost(): void;
  revokeHostTokens(): void;
  terminate(reason: string): void;
  client(): Promise<WebSocket>;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text;
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": typeof value === "string" ? "text/plain" : "application/json" });
  res.end(typeof value === "string" ? value : JSON.stringify(value));
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const issued = new Set<string>();
  let tokenCount = 0;
  let host: WebSocket | null = null;
  const clients = new Set<WebSocket>();
  const state = {
    registrations: [] as string[],
    unregistrations: 0,
    renewals: 0,
    hostQueries: [] as URLSearchParams[],
  };

  const http = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? "";
      if (req.url === "/relays") return reply(res, 200, []);
      if (req.url === "/health") return reply(res, 200, "ok\n");
      if (req.url === "/devices/renew" && req.method === "POST") {
        if (auth !== `Bearer ${DEVICE_TOKEN}`) return reply(res, 401, "bad credential");
        state.renewals++;
        return reply(res, 200, {
          device_token: "tld1.renewed",
          device_id: "dev1",
          expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        });
      }
      if (req.url === "/register" && req.method === "POST") {
        if (!auth.startsWith("Bearer tld1.")) return reply(res, 401, "bad credential");
        const { session } = JSON.parse(await body(req)) as { session: string };
        state.registrations.push(session);
        const token = `tlh1.${++tokenCount}`;
        issued.add(token);
        return reply(res, 200, { host_token: token });
      }
      if (req.url === "/register" && req.method === "DELETE") {
        state.unregistrations++;
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    })();
  });

  const sendClients = (): void => {
    if (host?.readyState !== WebSocket.OPEN) return;
    const list = [...clients].map(() => ({ ip: "127.0.0.1" }));
    host.send(JSON.stringify(list.length ? { type: "clients", clients: list } : { type: "clients" }));
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const role = url.searchParams.get("role");
    if (role === "host" && !issued.has(url.searchParams.get("token") ?? "")) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === "host") {
        state.hostQueries.push(url.searchParams);
        host?.close();
        host = ws;
        sendClients();
        ws.on("message", (data, isBinary) => {
          for (const client of clients) client.send(data, { binary: isBinary });
        });
        ws.on("close", () => {
          if (host !== ws) return;
          host = null;
          for (const client of clients) client.close();
        });
        return;
      }
      clients.add(ws);
      sendClients();
      ws.on("message", (data, isBinary) => host?.send(data, { binary: isBinary }));
      ws.on("close", () => {
        clients.delete(ws);
        sendClients();
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;

  return {
    url,
    get registrations() {
      return state.registrations;
    },
    get unregistrations() {
      return state.unregistrations;
    },
    get renewals() {
      return state.renewals;
    },
    get hostQueries() {
      return state.hostQueries;
    },
    kickHost: () => host?.terminate(),
    revokeHostTokens: () => issued.clear(),
    terminate: (reason) => host?.send(JSON.stringify({ type: "terminated", reason })),
    client: async () => {
      const ws = new WebSocket(`${url}/ws?session=s&role=client&token=tlc1.test`);
      await once(ws, "open");
      return ws;
    },
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
