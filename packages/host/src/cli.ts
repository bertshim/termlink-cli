#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AutoApprove, PROTOCOL_VERSION, type HostInfo } from "@termlink/protocol";
import { listDevices, loginAndEnroll, revokeDevices } from "./auth/login.js";
import { CLAUDE_PERMISSION_MODES, ClaudeProvider } from "./providers/claude/provider.js";
import { CodexProvider } from "./providers/codex/provider.js";
import { ShellProvider } from "./providers/terminal.js";
import type { HostProvider } from "./providers/types.js";
import { RelayHttpError } from "./relay/api.js";
import { DeviceError, defaultCredentialPath, loadDevice, renewIfDue, type DeviceCredential } from "./relay/device.js";
import { DEFAULT_SERVER, RelayHost, defaultRelaySession } from "./relay/relay-host.js";
import { startLocalServer } from "./server/local-server.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore, defaultStatePath } from "./session/store.js";
import { newId } from "./util/id.js";
import { LockHeldError, acquirePidLock } from "./util/lock.js";
import { VERSION } from "./version.js";

const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const DEFAULT_PROVIDERS = "terminal,claude,codex";

const USAGE = `Usage: termlink <command> [options]

Commands:
  start                 run the host in this folder (default)
  login                 sign this machine in to TermLink with Google
  logout                sign this machine out
  whoami                show the signed-in account
  devices               list the machines signed in to this account
  devices revoke <id>   sign one machine out (or --all for every machine)
  help                  show this text

Options for start:
  --port <n>                      local WebSocket port (default 7420)
  --host <addr>                   bind address (default 127.0.0.1)
  --token <token>                 local client token (default: $TERMLINK_LOCAL_TOKEN or a random one)
  --relay-session <name>          relay session name (default: ${defaultRelaySession()})
  --allow-root <dir>              folder sessions may open in; repeatable
                                  (default: the current folder)
  --state <file>                  where agent sessions are remembered across restarts (default ${defaultStatePath()})
  --no-restore                    start without bringing back remembered agent sessions
  --auto-approve <mode>           ${AutoApprove.options.join(" | ")}: approvals new agent sessions answer by themselves (default off)
  --providers <list>              comma-separated providers to enable (default ${DEFAULT_PROVIDERS})
  --shell <path>                  shell for terminal sessions (default: the user's shell)
  --scrollback <lines>            lines kept for a terminal reconnect (default 5000)
  --claude-permission-mode <mode> ${CLAUDE_PERMISSION_MODES.join(" | ")} (default: Claude Code settings)
  --claude-model <model>          model for new Claude sessions (default: Claude Code settings)
  --codex-approval <mode>         ${APPROVAL_POLICIES.join(" | ")} (default: ~/.codex/config.toml)
  --codex-sandbox <mode>          ${SANDBOX_MODES.join(" | ")} (default: ~/.codex/config.toml)

Options for every command:
  --server <url>                  master relay (default: $TERMLINK_SERVER or ${DEFAULT_SERVER})
  -h, --help                      show this text
  -v, --version                   show the version`;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function integer(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number from ${min} to ${max}`);
  return n;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "7420" },
      host: { type: "string", default: "127.0.0.1" },
      token: { type: "string" },
      server: { type: "string" },
      "relay-session": { type: "string" },
      "allow-root": { type: "string", multiple: true },
      state: { type: "string" },
      "no-restore": { type: "boolean", default: false },
      "auto-approve": { type: "string" },
      providers: { type: "string", default: DEFAULT_PROVIDERS },
      shell: { type: "string" },
      scrollback: { type: "string" },
      "claude-permission-mode": { type: "string" },
      "claude-model": { type: "string" },
      "codex-approval": { type: "string" },
      "codex-sandbox": { type: "string" },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    console.log(`termlink ${VERSION}`);
    return;
  }
  const command = positionals[0] ?? "start";
  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }
  const server = values.server ?? process.env.TERMLINK_SERVER ?? DEFAULT_SERVER;
  const credentialPath = defaultCredentialPath();

  switch (command) {
    case "start":
      return start(values, server, credentialPath);
    case "login":
      return login(server, credentialPath);
    case "logout":
      return logout(server, credentialPath);
    case "whoami":
      return whoami(server, credentialPath);
    case "devices":
      return devices(positionals.slice(1), values.all, server, credentialPath);
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

type Values = {
  port: string;
  host: string;
  token?: string | undefined;
  "relay-session"?: string | undefined;
  "allow-root"?: string[] | undefined;
  state?: string | undefined;
  "no-restore": boolean;
  "auto-approve"?: string | undefined;
  providers: string;
  shell?: string | undefined;
  scrollback?: string | undefined;
  "claude-permission-mode"?: string | undefined;
  "claude-model"?: string | undefined;
  "codex-approval"?: string | undefined;
  "codex-sandbox"?: string | undefined;
};

async function start(values: Values, server: string, credentialPath: string): Promise<void> {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${values.port}`);
  const token = values.token ?? process.env.TERMLINK_LOCAL_TOKEN ?? randomBytes(18).toString("base64url");
  const autoApprove = oneOf(values["auto-approve"], AutoApprove.options, "--auto-approve");
  const permissionMode = oneOf(values["claude-permission-mode"], CLAUDE_PERMISSION_MODES, "--claude-permission-mode");
  const approvalPolicy = oneOf(values["codex-approval"], APPROVAL_POLICIES, "--codex-approval");
  const sandbox = oneOf(values["codex-sandbox"], SANDBOX_MODES, "--codex-sandbox");
  const scrollback = integer(values.scrollback, "--scrollback", 0, 100_000);
  // Remote clients pick the folder, so joining the relay narrows it to where the host was started.
  const allowRoots = values["allow-root"] ?? [];
  const roots = allowRoots.length > 0 ? allowRoots : [process.cwd()];

  const providers: HostProvider[] = [];
  for (const name of values.providers.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (name === "terminal") providers.push(new ShellProvider({ shell: values.shell, scrollback }));
    else if (name === "codex") providers.push(new CodexProvider({ approvalPolicy, sandbox }));
    else if (name === "claude") providers.push(new ClaudeProvider({ permissionMode, model: values["claude-model"] }));
    else throw new Error(`unknown provider: ${name}`);
  }

  const manager = new SessionManager({
    providers,
    store: new SessionStore(values.state ?? defaultStatePath()),
    allowedRoots: roots,
    ...(autoApprove ? { autoApprove } : {}),
  });
  const hostId = newId("h");
  const hostInfo = async (): Promise<HostInfo> => ({
    hostId,
    name: os.hostname(),
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    os: `${process.platform}-${process.arch}`,
    providers: await manager.providerStatuses(),
    ...(manager.roots ? { roots: manager.roots } : {}),
  });

  const restored = values["no-restore"] ? 0 : await manager.restore();
  const local = await startLocalServer({ manager, hostInfo, host: values.host, port, token });
  if (values.host !== "127.0.0.1" && values.host !== "localhost" && values.host !== "::1") {
    console.warn(`warning: the local server has no TLS and is listening on ${values.host}`);
  }
  console.log(`termlink ${VERSION} listening on ${local.url}?token=${token}`);
  for (const status of await manager.providerStatuses()) {
    const state = status.available ? "ready" : "unavailable";
    console.log(`  ${status.id}: ${state}${status.detail ? ` (${status.detail})` : ""}`);
  }
  if (manager.roots) console.log(`  sessions may open in: ${manager.roots.join(", ")}`);
  if (autoApprove && autoApprove !== "off") console.log(`  new agent sessions auto-approve: ${autoApprove}`);
  if (restored > 0) console.log(`  restored ${restored} session${restored === 1 ? "" : "s"}`);

  let relay: RelayHost | null = null;
  let releaseLock: (() => Promise<void>) | null = null;
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await relay?.close();
    await releaseLock?.();
    await manager.shutdown("host shutting down");
    await local.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  const session = values["relay-session"] ?? defaultRelaySession();
  try {
    // The relay closes the older of two hosts on one session without saying why, so both
    // reconnect and keep kicking each other off. One host per session name on a machine.
    const lockName = `relay-${session.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`;
    releaseLock = await acquirePidLock(path.join(os.homedir(), ".termlink", lockName));
    relay = await RelayHost.start({
      manager,
      hostInfo,
      server,
      session,
      name: os.hostname(),
      cwd: manager.roots?.[0] ?? process.cwd(),
      credentialPath,
      log: (line) => console.log(`${new Date().toLocaleTimeString("en-GB")} ${line}`),
      onStopped: () => void stop(),
    });
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(
        `another termlink host (pid ${err.pid}) is already on relay session ${session}; ` +
          "stop it, or start this one with --relay-session <name>",
      );
    } else {
      console.error(err instanceof DeviceError ? err.message : `could not join the relay: ${err instanceof Error ? err.message : err}`);
    }
    await stop();
    process.exitCode = 1;
  }
}

/** The stored credential when it is still good for this server; null when signed out. */
async function currentDevice(server: string, credentialPath: string): Promise<DeviceCredential | null> {
  try {
    return await loadDevice(credentialPath, server);
  } catch (err) {
    if (err instanceof DeviceError) return null;
    throw err;
  }
}

function describe(credential: DeviceCredential): string {
  const who = credential.email ?? credential.name ?? credential.sub;
  return credential.name && credential.email ? `${credential.name} <${credential.email}>` : who;
}

async function login(server: string, credentialPath: string): Promise<void> {
  const current = await currentDevice(server, credentialPath);
  if (current) {
    console.log(`Already logged in: ${describe(current)}`);
    console.log("This machine is enrolled, so signing in again is not needed.");
    console.log("To log in with a different account, run `termlink logout` first.");
    return;
  }
  const credential = await loginAndEnroll(server, credentialPath);
  console.log(`Login complete: ${describe(credential)}`);
  console.log("This machine is now enrolled; it will not ask Google again.");
  console.log("Run `termlink devices` to see or sign out the machines on this account.");
}

// Revoke on the server first: if the local file went first and the network call then
// failed, the person would be told they were logged out while a working credential was
// still enrolled, with no id left to revoke it with.
async function logout(server: string, credentialPath: string): Promise<void> {
  const current = await currentDevice(server, credentialPath);
  if (current) {
    try {
      await revokeDevices(server, current.token, { id: current.id });
    } catch (err) {
      if (!(err instanceof RelayHttpError && (err.status === 401 || err.status === 403))) {
        throw new Error(
          `could not sign this machine out on the server (${err instanceof Error ? err.message : err}); nothing was removed locally, so you can retry`,
        );
      }
      // Already revoked there: only the local file is left.
    }
  }
  await rm(credentialPath, { force: true });
  console.log(current ? `Logged out: ${describe(current)}` : "Not logged in.");
}

async function whoami(server: string, credentialPath: string): Promise<void> {
  const current = await currentDevice(server, credentialPath);
  if (!current) {
    console.log("Not logged in. Run `termlink login`.");
    process.exitCode = 1;
    return;
  }
  const fresh = await renewIfDue(credentialPath, server, current, fetch).catch(() => current);
  console.log(describe(fresh));
  console.log(`  device:  ${fresh.id}`);
  console.log(`  server:  ${fresh.master}`);
  console.log(`  expires: ${fresh.expires_at}`);
}

async function devices(args: string[], all: boolean, server: string, credentialPath: string): Promise<void> {
  const current = await currentDevice(server, credentialPath);
  if (!current) {
    console.log("Not logged in. Run `termlink login`.");
    process.exitCode = 1;
    return;
  }
  if (args[0] === "revoke") {
    const id = args[1];
    if (!id && !all) throw new Error("usage: termlink devices revoke <id> | --all");
    const count = await revokeDevices(server, current.token, all ? { all: true } : { id: id ?? "" });
    console.log(`Revoked ${count} device${count === 1 ? "" : "s"}.`);
    if (all || id === current.id) {
      await rm(credentialPath, { force: true });
      console.log("This machine is signed out too. Run `termlink login` to sign in again.");
    }
    return;
  }
  const list = await listDevices(server, current.token);
  if (list.length === 0) {
    console.log("No devices.");
    return;
  }
  for (const device of list) {
    const marker = device.id === current.id ? " (this machine)" : "";
    console.log(`${device.id}  ${device.label}${marker}`);
    console.log(`  added ${device.createdAt}, last seen ${device.lastSeen}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
