import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Fetch } from "./relay/api.js";

const REGISTRY_URL = "https://registry.npmjs.org/@termlink/cli/latest";
// A courtesy notice, not a gate: once a day is plenty, and it keeps a normal `termlink start`
// from ever waiting on the network for this.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;

export function defaultUpdateCheckPath(): string {
  return path.join(os.homedir(), ".termlink", "update-check.json");
}

interface CheckState {
  lastCheckedAt: number;
  latest?: string;
}

interface Parsed {
  core: number[];
  pre?: string;
}

/** "0.1.5-rc" -> { core: [0, 1, 5], pre: "rc" }; null for anything that is not x.y.z[-pre]. */
function parse(v: string): Parsed | null {
  const dash = v.indexOf("-");
  const coreText = dash === -1 ? v : v.slice(0, dash);
  const core = coreText.split(".").map(Number);
  if (core.length === 0 || core.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return dash === -1 ? { core } : { core, pre: v.slice(dash + 1) };
}

/**
 * true if `a` is newer than `b`. Handles the -rc builds this repo tests before a release: a
 * release outranks its own prerelease (0.1.5 > 0.1.5-rc), and a prerelease is still older
 * than the next release up (0.1.5-rc < 0.1.6). Anything unparseable compares as not newer.
 */
function isNewer(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (pa.pre === undefined) return pb.pre !== undefined;
  if (pb.pre === undefined) return false;
  return pa.pre > pb.pre;
}

/**
 * Whether a newer @termlink/cli is on npm, as a line to print, or null when there is none (or
 * the check could not run). Never installs anything itself — same philosophy as the Node.js
 * version check in node-version.ts: detect, name the one command that fixes it, stop there. `npm
 * install -g` runs on its own schedule; publishing a fix does nothing for someone already running
 * an older version until they hear about it, which is what this is for.
 *
 * Never throws: offline, a slow or unreachable registry, a malformed response, or a read-only
 * home directory all just mean no notice this run. Cached for a day (state, not failures — a
 * check that came back empty is retried next time) so this never adds network latency to an
 * ordinary start.
 */
export async function checkForUpdate(
  currentVersion: string,
  statePath: string = defaultUpdateCheckPath(),
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  try {
    const cached = await readState(statePath);
    const fresh = cached?.latest !== undefined && Date.now() - cached.lastCheckedAt < CHECK_INTERVAL_MS;
    const latest = fresh ? cached.latest : await fetchLatest(fetchImpl);
    if (!fresh) await writeState(statePath, { lastCheckedAt: Date.now(), latest });
    if (!latest || !isNewer(latest, currentVersion)) return null;
    return `A newer termlink is out: ${currentVersion} -> ${latest}. Update with: npm install -g @termlink/cli`;
  } catch {
    return null;
  }
}

async function fetchLatest(fetchImpl: Fetch): Promise<string | undefined> {
  const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return undefined;
  const body: unknown = await res.json();
  const version = (body as { version?: unknown } | null)?.version;
  return typeof version === "string" ? version : undefined;
}

async function readState(file: string): Promise<CheckState | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("lastCheckedAt" in parsed)) return null;
    return parsed as CheckState;
  } catch {
    return null;
  }
}

async function writeState(file: string, state: CheckState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state), "utf8");
}
