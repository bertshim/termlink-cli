// `termlink login`: a Google sign-in in the browser, traded at the master relay for a
// device credential that the host uses from then on. Google is never asked again until
// the person signs out; the device token renews itself (relay/device.ts).
//
// The same flow as the Go CLI this replaces: PKCE, a loopback
// redirect, the scopes openid email profile, and the same ~/.termlink/device.json.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { httpBase, RelayHttpError, type Fetch } from "../relay/api.js";
import { DeviceError, saveDevice, type DeviceCredential } from "../relay/device.js";
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_SECRET } from "./oauth-defaults.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "openid email profile";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** Fixed redirect for web-type clients. Empty picks a random loopback port. */
  redirectUri: string;
}

export interface Identity {
  sub: string;
  email?: string | undefined;
  name?: string | undefined;
}

/**
 * Which Google OAuth client to use, in order: a client_secret_*.json named by
 * TERMLINK_GOOGLE_CLIENT_SECRET_FILE, then TERMLINK_GOOGLE_CLIENT_ID/_SECRET, then the
 * values built into this package.
 */
export async function resolveOAuthClient(env: NodeJS.ProcessEnv = process.env): Promise<OAuthClient> {
  const file = env.TERMLINK_GOOGLE_CLIENT_SECRET_FILE;
  if (file) return loadClientSecretFile(file, env.TERMLINK_GOOGLE_REDIRECT_URI);
  const clientId = env.TERMLINK_GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret = env.TERMLINK_GOOGLE_CLIENT_SECRET || DEFAULT_GOOGLE_CLIENT_SECRET;
  if (!clientId) {
    throw new DeviceError(
      "no Google OAuth client is configured; set TERMLINK_GOOGLE_CLIENT_SECRET_FILE or TERMLINK_GOOGLE_CLIENT_ID",
    );
  }
  return { clientId, clientSecret, redirectUri: env.TERMLINK_GOOGLE_REDIRECT_URI ?? "" };
}

async function loadClientSecretFile(file: string, redirectOverride: string | undefined): Promise<OAuthClient> {
  let parsed: { web?: ClientSection; installed?: ClientSection };
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
  } catch (err) {
    throw new DeviceError(`could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  const section = parsed.web ?? parsed.installed;
  if (!section?.client_id) throw new DeviceError(`${file} has no web or installed client`);
  // Desktop clients use a random loopback port; only web clients need their registered URI.
  const redirect = parsed.web ? (section.redirect_uris?.[0] ?? "") : "";
  return { clientId: section.client_id, clientSecret: section.client_secret ?? "", redirectUri: redirectOverride ?? redirect };
}

interface ClientSection {
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
}

export interface LoginOptions {
  client: OAuthClient;
  fetch?: Fetch;
  /** Called with the URL to open. Defaults to opening the system browser. */
  openBrowser?: (url: string) => void;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/** Runs the browser sign-in and returns Google's ID token for the account. */
export async function googleLogin(options: LoginOptions): Promise<{ idToken: string; identity: Identity }> {
  const fetchFn = options.fetch ?? fetch;
  const { client } = options;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  const server = createServer();
  let callbackPath = "/callback";
  let listenHost = "127.0.0.1";
  let listenPort = 0;
  if (client.redirectUri) {
    const url = new URL(client.redirectUri);
    listenHost = url.hostname;
    listenPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    callbackPath = url.pathname || "/";
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = client.redirectUri || `http://127.0.0.1:${port}${callbackPath}`;

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeviceError("login timed out")), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(`Login failed: ${error}. You can close this tab.`));
        clearTimeout(timer);
        reject(new DeviceError(`authorization denied: ${error}`));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("state mismatch");
        return;
      }
      const value = url.searchParams.get("code");
      if (!value) {
        res.writeHead(400).end("missing code");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Login complete. You can close this tab and return to the terminal."));
      clearTimeout(timer);
      resolve(value);
    });
  });

  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  }).toString();

  const log = options.log ?? ((line: string) => console.error(line));
  log("Complete the Google login in your browser. If it does not open, use this link:");
  log(`  ${authUrl}`);
  (options.openBrowser ?? openBrowser)(authUrl.toString());

  try {
    const authCode = await code;
    const form = new URLSearchParams({
      code: authCode,
      client_id: client.clientId,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new DeviceError(`token exchange failed: ${(await res.text()).trim() || res.statusText}`);
    const body = (await res.json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string") throw new DeviceError("Google returned no id_token; check that the openid scope is allowed");
    return { idToken: body.id_token, identity: decodeIdentity(body.id_token) };
  } finally {
    server.close();
  }
}

/** Trades a Google ID token for a device credential on the master relay. */
export async function enrollDevice(server: string, idToken: string, label: string, fetchFn: Fetch = fetch): Promise<DeviceCredential> {
  const res = await fetchFn(`${httpBase(server)}/devices`, {
    method: "POST",
    headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
    body: JSON.stringify({ label }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new RelayHttpError(res.status, (await res.text()).trim() || res.statusText);
  const body = (await res.json()) as { device_token?: string; device_id?: string; expires_at?: string; email?: string; name?: string };
  if (!body.device_token || !body.device_id || !body.expires_at) throw new DeviceError("the service did not issue a device credential");
  const { sub } = decodeIdentity(idToken);
  return {
    token: body.device_token,
    id: body.device_id,
    sub,
    ...(body.email ? { email: body.email } : {}),
    ...(body.name ? { name: body.name } : {}),
    expires_at: body.expires_at,
    master: server,
  };
}

/** Signs in and enrolls this machine. The credential is written to `file`. */
export async function loginAndEnroll(
  server: string,
  file: string,
  options: Omit<LoginOptions, "client"> & { client?: OAuthClient } = {},
): Promise<DeviceCredential> {
  const client = options.client ?? (await resolveOAuthClient());
  const { idToken } = await googleLogin({ ...options, client });
  const credential = await enrollDevice(server, idToken, deviceLabel(), options.fetch);
  await saveDevice(file, credential);
  return credential;
}

export interface DeviceInfo {
  id: string;
  label: string;
  createdAt: string;
  lastSeen: string;
}

export async function listDevices(server: string, credential: string, fetchFn: Fetch = fetch): Promise<DeviceInfo[]> {
  const res = await fetchFn(`${httpBase(server)}/devices`, {
    headers: { authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new RelayHttpError(res.status, (await res.text()).trim() || res.statusText);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as DeviceInfo[]) : [];
}

/** Revokes one device (or every device of the account with `all`). Returns how many. */
export async function revokeDevices(
  server: string,
  credential: string,
  target: { id: string } | { all: true },
  fetchFn: Fetch = fetch,
): Promise<number> {
  const query = "all" in target ? "all=1" : `id=${encodeURIComponent(target.id)}`;
  const res = await fetchFn(`${httpBase(server)}/devices?${query}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 && "id" in target) return 0; // Already gone: what logout wanted anyway.
  if (!res.ok) throw new RelayHttpError(res.status, (await res.text()).trim() || res.statusText);
  if (res.status === 204) return 1;
  const body = (await res.json().catch(() => ({}))) as { revoked?: number };
  return body.revoked ?? 1;
}

/** How this machine appears in the account's device list, like the Go CLI named it. */
export function deviceLabel(): string {
  return `${os.hostname() || "unknown host"} (${process.platform})`;
}

export function decodeIdentity(idToken: string): Identity {
  const payload = idToken.split(".")[1];
  if (!payload) throw new DeviceError("malformed id_token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub?: unknown;
    email?: unknown;
    name?: unknown;
  };
  if (typeof claims.sub !== "string") throw new DeviceError("id_token has no subject");
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  try {
    spawn(command.file, command.args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The link is printed as well.
  }
}

function page(text: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>TermLink</h2><p>${text}</p></body></html>`;
}
