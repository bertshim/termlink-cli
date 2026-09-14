// A loopback-only host with the real Claude provider and TERMLINK_TRACE on, for
// measuring a web client against it.
// Joins no relay, keeps no session store, allows any folder.
//
//   node --conditions=source --import tsx scripts/trace-host.ts [port] [token]
import os from "node:os";
import { PROTOCOL_VERSION, type HostInfo } from "@termlink/protocol";

process.env.TERMLINK_TRACE ??= "1";
const { SessionManager } = await import("../src/session/manager.js");
const { startLocalServer } = await import("../src/server/local-server.js");
const { ClaudeProvider } = await import("../src/providers/claude/provider.js");

const port = Number(process.argv[2] ?? 7433);
const token = process.argv[3] ?? "trace";
const manager = new SessionManager({ providers: [new ClaudeProvider()] });
const hostInfo = async (): Promise<HostInfo> => ({
  hostId: "h_trace",
  name: os.hostname(),
  version: "trace",
  protocol: PROTOCOL_VERSION,
  os: `${process.platform}-${process.arch}`,
  providers: await manager.providerStatuses(),
});
const local = await startLocalServer({ manager, hostInfo, port, token });
console.log(`listening on ${local.url}?token=${token}`);
const stop = (): void => void manager.shutdown("trace host stopping").finally(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
