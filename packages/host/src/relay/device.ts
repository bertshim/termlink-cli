import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { httpBase, type Fetch } from "./api.js";

/**
 * The TermLink device credential written by `termlink login` (auth/login.ts). Field
 * names follow the Go CLI's device file, so a machine signed in with the
 * old CLI stays signed in. Unknown fields are kept when the file is rewritten.
 */
export interface DeviceCredential {
  token: string;
  id: string;
  sub: string;
  email?: string;
  name?: string;
  expires_at: string;
  master: string;
  [field: string]: unknown;
}

/** A problem only the user can fix, by signing in again. */
export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceError";
  }
}

const RENEW_WHEN_LEFT_MS = 30 * 24 * 60 * 60 * 1000;

export function defaultCredentialPath(): string {
  return path.join(os.homedir(), ".termlink", "device.json");
}

const normalize = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

export async function loadDevice(file: string, server: string, now = Date.now()): Promise<DeviceCredential> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new DeviceError(`no TermLink sign-in found at ${file}; run \`termlink login\` first`);
  }
  let credential: DeviceCredential;
  try {
    credential = JSON.parse(raw) as DeviceCredential;
  } catch {
    throw new DeviceError(`${file} is not valid JSON; run \`termlink login\` again`);
  }
  if (typeof credential.token !== "string" || !credential.token) {
    throw new DeviceError(`${file} has no device token; run \`termlink login\` again`);
  }
  if (normalize(String(credential.master ?? "")) !== normalize(server)) {
    throw new DeviceError(`the sign-in in ${file} is for ${credential.master}, not ${server}; run \`termlink login\``);
  }
  if (!(Date.parse(credential.expires_at) > now)) {
    throw new DeviceError("the TermLink sign-in on this machine has expired; run `termlink login`");
  }
  return credential;
}

/** Renews the device token when less than 30 days are left, like the Go CLI does at startup. */
export async function renewIfDue(
  file: string,
  server: string,
  credential: DeviceCredential,
  fetchFn: Fetch,
  now = Date.now(),
): Promise<DeviceCredential> {
  if (Date.parse(credential.expires_at) - now > RENEW_WHEN_LEFT_MS) return credential;
  let res: Response;
  try {
    res = await fetchFn(`${httpBase(server)}/devices/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return credential; // Offline: the current token still works; try again next start.
  }
  if (res.status === 401 || res.status === 403) {
    throw new DeviceError("this machine was signed out of TermLink; run `termlink login`");
  }
  if (!res.ok) return credential;
  const body = (await res.json()) as { device_token?: string; device_id?: string; expires_at?: string; email?: string; name?: string };
  if (!body.device_token || !body.expires_at) return credential;
  const fresh: DeviceCredential = {
    ...credential,
    token: body.device_token,
    expires_at: body.expires_at,
    ...(body.device_id ? { id: body.device_id } : {}),
    ...(body.email ? { email: body.email } : {}),
    ...(body.name ? { name: body.name } : {}),
  };
  await saveDevice(file, fresh);
  return fresh;
}

export async function saveDevice(file: string, credential: DeviceCredential): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
