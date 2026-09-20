import path from "node:path";
import type { AgentEvent, SessionInfo } from "@termlink/protocol";

/**
 * What `termlink start` shows while it runs.
 *
 * On a terminal: the startup summary, a line for each session opened or closed, and a
 * status line kept at the bottom (relay state, sessions, how to stop). Its dots move
 * once a second, so a person can tell a running host from a hung one; each move is one
 * short write that redraws that line in place.
 *
 * Anywhere else (a service, a pipe, a log file) there is no status line and nothing
 * moves: the same events are written as plain lines with the time in front.
 *
 * Nothing here prints addresses, ports or tokens.
 */

export type RelayState = "connecting" | "online" | "reconnecting" | "offline";

export interface HostStatus {
  version: string;
  relay: RelayState;
  sessions: readonly SessionInfo[];
  /** Ctrl+C was pressed and the host is saving sessions. */
  stopping: boolean;
}

/** Provider id to the name shown for it ("Terminal", "Claude", "Codex"). */
export type Labels = Readonly<Record<string, string>>;

/** How often the dots move. */
export const TICK_MS = 1000;
const DOTS = [".  ", ".. ", "...", "   "] as const;

const RELAY_TEXT: Record<RelayState, string> = {
  connecting: "connecting to the relay",
  online: "online",
  reconnecting: "reconnecting to the relay",
  offline: "offline",
};

const labelOf = (provider: string, labels: Labels): string => labels[provider] ?? provider;
const folderOf = (cwd: string): string => path.basename(cwd) || cwd;

/** "no sessions", or "3 sessions: 2 Claude, 1 Terminal; 1 working, 1 waiting for you". */
export function sessionSummary(sessions: readonly SessionInfo[], labels: Labels): string {
  if (sessions.length === 0) return "no sessions";
  const byLabel = new Map<string, number>();
  for (const s of sessions) {
    const label = labelOf(s.provider, labels);
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  }
  const kinds = [...byLabel].map(([label, n]) => `${n} ${label}`).join(", ");
  const working = sessions.filter((s) => s.kind === "agent" && (s.status === "running" || s.status === "interrupting")).length;
  const waiting = sessions.filter((s) => s.status === "waiting_input").length;
  const rateLimited = sessions.filter((s) => s.status === "rate_limited").length;
  const activity = [
    working > 0 ? `${working} working` : "",
    waiting > 0 ? `${waiting} waiting for you` : "",
    rateLimited > 0 ? `${rateLimited} rate-limited` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${sessions.length} session${sessions.length === 1 ? "" : "s"}: ${kinds}${activity ? `; ${activity}` : ""}`;
}

/** The status line for animation frame `frame`. */
export function statusText(status: HostStatus, frame: number, labels: Labels): string {
  const dots = DOTS[frame % DOTS.length];
  if (status.stopping) return `termlink ${status.version} stopping${dots} | saving sessions, please wait`;
  return (
    `termlink ${status.version} running${dots} | ${RELAY_TEXT[status.relay]} | ` +
    `${sessionSummary(status.sessions, labels)} | Ctrl+C to stop`
  );
}

/** `text` cut to one line of `columns`, so redrawing it in place never wraps. */
export function fit(text: string, columns: number | undefined): string {
  const width = Math.max(20, (columns ?? 80) - 1);
  return text.length <= width ? text : `${text.slice(0, width - 3)}...`;
}

/** A line for a session that was opened or closed; null for every other event. */
export function sessionEventLine(event: AgentEvent, labels: Labels): string | null {
  if (event.type === "session.created") {
    const { session } = event.payload;
    return `+ ${labelOf(session.provider, labels)} session opened in ${folderOf(session.cwd)}`;
  }
  if (event.type === "session.closed") {
    const { session, reason } = event.payload;
    const exit = session.kind === "terminal" && typeof session.exitCode === "number" ? `exit ${session.exitCode}` : "";
    const why = [reason ?? "", exit].filter(Boolean).join(", ");
    return `- ${labelOf(session.provider, labels)} session closed${why ? ` (${why})` : ""}`;
  }
  return null;
}

const clock = (now: Date): string => now.toTimeString().slice(0, 8);

export interface HostConsoleOptions {
  /** Where to write; stdout by default. */
  out?: NodeJS.WriteStream;
  /** Force the status line on or off; by default it is on when `out` is a terminal. */
  live?: boolean;
  status: () => HostStatus;
  labels: Labels;
  now?: () => Date;
}

export class HostConsole {
  /** Whether the status line is drawn (a terminal) or only plain lines are written. */
  readonly live: boolean;
  readonly #out: NodeJS.WriteStream;
  readonly #status: () => HostStatus;
  readonly #labels: Labels;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;
  #drawn = false;

  constructor(options: HostConsoleOptions) {
    this.#out = options.out ?? process.stdout;
    this.live = options.live ?? HostConsole.canAnimate(this.#out);
    this.#status = options.status;
    this.#labels = options.labels;
    this.#now = options.now ?? (() => new Date());
  }

  /** A terminal that can redraw a line in place; not a pipe, a file, a dumb terminal or CI. */
  static canAnimate(out: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
    return out.isTTY === true && typeof out.cursorTo === "function" && env.TERM !== "dumb" && !env.CI;
  }

  /** A line of the startup summary, as it is. */
  print(text = ""): void {
    this.#erase();
    this.#out.write(`${text}\n`);
    if (this.#timer) this.#draw();
  }

  /** Something that happened, with the time in front. */
  event(text: string): void {
    this.print(`${clock(this.#now())} ${text}`);
  }

  /** Starts the status line. Does nothing off a terminal. */
  start(): void {
    if (!this.live || this.#timer) return;
    this.#draw();
    this.#timer = setInterval(() => {
      this.#frame++;
      this.#draw();
    }, TICK_MS);
    // The status line never keeps the process alive on its own.
    this.#timer.unref();
  }

  /** Redraws the status line now, after something it shows has changed. */
  refresh(): void {
    if (this.#timer) this.#draw();
  }

  /** Stops the status line and takes it off the screen. */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#erase();
  }

  #draw(): void {
    const text = fit(statusText(this.#status(), this.#frame, this.#labels), this.#out.columns);
    this.#out.cursorTo(0);
    this.#out.write(text);
    this.#out.clearLine(1);
    this.#drawn = true;
  }

  #erase(): void {
    if (!this.#drawn) return;
    this.#out.cursorTo(0);
    this.#out.clearLine(0);
    this.#drawn = false;
  }
}
