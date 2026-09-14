// HTTP calls to the TermLink master relay: the same endpoints the Go host uses.

export type Fetch = typeof fetch;

export class RelayHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayHttpError";
    this.status = status;
  }
}

/** wss://host:9000 -> https://host:9000 */
export function httpBase(server: string): string {
  return server.trim().replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
}

const trimSlash = (url: string): string => url.trim().replace(/\/+$/, "");

/** Picks the edge relay with the lowest /health latency, or the master when there are none. */
export async function pickRelay(server: string, fetchFn: Fetch): Promise<string> {
  let relays: unknown = [];
  try {
    const res = await fetchFn(`${httpBase(server)}/relays`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) relays = await res.json();
  } catch {
    // Fall back to the master.
  }
  const candidates = Array.isArray(relays)
    ? relays.filter((r): r is { url: string } => typeof r === "object" && r !== null && typeof r.url === "string")
    : [];
  if (candidates.length === 0) return trimSlash(server);

  const timed = await Promise.all(candidates.map(async (r) => ({ url: r.url, ms: await bestPing(r.url, fetchFn) })));
  const best = timed
    .filter((t): t is { url: string; ms: number } => t.ms !== null)
    .sort((a, b) => a.ms - b.ms)[0];
  return trimSlash(best?.url ?? server);
}

async function bestPing(url: string, fetchFn: Fetch): Promise<number | null> {
  let best: number | null = null;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    try {
      const res = await fetchFn(`${httpBase(url)}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) best = Math.min(best ?? Infinity, performance.now() - start);
    } catch {
      // Unreachable this time.
    }
  }
  return best;
}

/** Exchanges the device token for a host token bound to one relay session. */
export async function registerHost(server: string, deviceToken: string, session: string, fetchFn: Fetch): Promise<string> {
  const res = await fetchFn(`${httpBase(server)}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ session }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new RelayHttpError(res.status, (await res.text()).trim() || res.statusText);
  const body = (await res.json()) as { host_token?: unknown };
  if (typeof body.host_token !== "string") throw new Error("the relay returned no host token");
  return body.host_token;
}

export async function unregisterHost(server: string, hostToken: string, session: string, fetchFn: Fetch): Promise<void> {
  await fetchFn(`${httpBase(server)}/register`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
    body: JSON.stringify({ session }),
    signal: AbortSignal.timeout(3_000),
  });
}
