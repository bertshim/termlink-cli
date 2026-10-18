/**
 * Codex's counterpart of claude/rate-limit.ts: a turn that fails on the plan's usage
 * limit just ends, failed, over the app-server protocol — the interactive CLI's own
 * wait-and-continue is not part of it. The host supplies that instead: telling a genuine
 * limit hit apart from any other failure, and working out when the same turn can be
 * sent again.
 */

/** 1 minute after the limit's own reset, as for Claude: long enough that the reset has
 *  landed server-side, short enough nobody waiting notices the gap. */
export const RETRY_AFTER_RESET_MS = 60_000;

/**
 * How many turns in one run of limit hits are resent automatically. A backstop against a
 * runaway loop if the reset time were ever misjudged — a real reset clears the limit the
 * first time. The same figure as Claude's.
 */
export const MAX_LIMIT_RETRIES = 5;

/** Windows of the plan's usage as the session holds them, `resetsAt` in epoch ms. */
export interface LimitWindows {
  primary?: { usedPercent: number; resetsAt?: number | null } | null | undefined;
  secondary?: { usedPercent: number; resetsAt?: number | null } | null | undefined;
}

// The CLI's own sentence: "You've hit your usage limit. Upgrade to Pro (...), visit ... to
// purchase more credits or try again at 6:54 PM." Anchored at the start — a turn that
// merely quotes the words, or a tool failing for another reason, is not a limit hit.
const USAGE_LIMIT = /^\s*you(?:'|’)ve\s+(?:hit|reached)\s+your\s+(?:[\w-]+\s+)?usage\s+limit/i;

/** Whether a failed turn's own error text says the plan's usage limit was reached. */
export function isUsageLimitError(errorText: string): boolean {
  return USAGE_LIMIT.test(errorText);
}

/**
 * When to resend a turn that failed on a genuine usage-limit hit, or null when nothing
 * reliable enough to schedule on is available (the turn just stays failed, as before).
 *
 * The structured windows win over the sentence: a window at 100% with a reset time is
 * exact, while "try again at 6:54 PM" carries no zone and, for a limit more than a day
 * out, a date written for a person. The sentence is the fallback for a snapshot that
 * has not arrived. When both windows are full the LATER reset is the one to wait for —
 * resending at the earlier one would only fail again.
 */
export function resolveRetryAt(args: {
  limits: LimitWindows | null | undefined;
  errorText: string;
  now: number;
  afterResetMs: number;
}): number | null {
  const { limits, errorText, now, afterResetMs } = args;
  const full = [limits?.primary, limits?.secondary]
    .filter((w): w is { usedPercent: number; resetsAt: number } => !!w && w.usedPercent >= 100 && typeof w.resetsAt === "number")
    // A reset already behind us is a snapshot older than the window it describes, not a
    // reason to resend at once.
    .map((w) => w.resetsAt)
    .filter((at) => at > now);
  if (full.length > 0) return Math.max(...full) + afterResetMs;
  const parsed = parseTryAgainAt(errorText, now);
  return parsed === null ? null : parsed + afterResetMs;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CLOCK = "(\\d{1,2}):(\\d{2})\\s*(am|pm)";
const TRY_AGAIN_CLOCK = new RegExp(`try again at\\s+${CLOCK}`, "i");
const TRY_AGAIN_DATE = new RegExp(`try again at\\s+([a-z]{3})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:(\\d{4})\\s+)?${CLOCK}`, "i");

function to24(hour: number, ampm: string): number {
  return (hour % 12) + (/pm/i.test(ampm) ? 12 : 0);
}

/**
 * The instant named by "try again at ...", read in THIS machine's time zone — the
 * sentence is written by Codex running here, in the local clock, and gives no zone.
 * A bare clock is its next occurrence (today, or tomorrow once it has passed); a dated
 * one ("Oct 9th, 2026 6:54 PM", for a limit further out) is that date, the year being
 * this one — or next, if that date has already gone by — when it is left out.
 */
function parseTryAgainAt(text: string, now: number): number | null {
  const dated = TRY_AGAIN_DATE.exec(text);
  if (dated) {
    const [, mon, day, year, h, m, ampm] = dated as unknown as [string, string, string, string | undefined, string, string, string];
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return null;
    const at = (y: number) => new Date(y, month, Number(day), to24(Number(h), ampm), Number(m), 0, 0).getTime();
    const thisYear = new Date(now).getFullYear();
    const when = year ? at(Number(year)) : at(thisYear) > now ? at(thisYear) : at(thisYear + 1);
    return Number.isFinite(when) ? when : null;
  }
  const clock = TRY_AGAIN_CLOCK.exec(text);
  if (!clock) return null;
  const [, h, m, ampm] = clock as unknown as [string, string, string, string];
  const today = new Date(now);
  today.setHours(to24(Number(h), ampm), Number(m), 0, 0);
  const at = today.getTime();
  if (!Number.isFinite(at)) return null;
  if (at > now) return at;
  today.setDate(today.getDate() + 1);
  return today.getTime();
}
