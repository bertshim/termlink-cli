import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude Code's own auto-restart-at-reset behaviour is an interactive-CLI thing;
 * query() (what ClaudeSession drives) has no such option — a turn that hits the
 * plan's usage limit just ends, failed, like any other error. This module is the
 * host's own replacement: telling a genuine limit hit apart from any other
 * failure, and working out when it is safe to try the same turn again.
 */

/** 1 minute after the limit's own reset — long enough that the reset has
 *  genuinely landed server-side, short enough nobody waiting notices the gap. */
export const RETRY_AFTER_RESET_MS = 60_000;

/**
 * Whether a failed turn's own error text (or the API error code Claude Code
 * attached to it) says the plan's usage limit was actually reached — as
 * opposed to any other failure (overloaded, invalid request, a tool result
 * cut short by Stop). Either signal is enough:
 *  - the API error code held on the assistant message the CLI sent right
 *    before the failed result (ClaudeSession's #heldError) is literally
 *    'rate_limit';
 *  - the failed result's own text starts with one of the CLI's own
 *    genuinely-reached prefixes — USAGE_LIMIT_ERROR_PREFIXES, re-exported by
 *    the SDK itself, deliberately NOT the "approaching" warnings or
 *    "now using credits" transition notices next to it in the same module,
 *    which are informational only and never a hard stop.
 */
export function isUsageLimitError(errorText: string, heldErrorCode?: string): boolean {
  if (heldErrorCode === "rate_limit") return true;
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => errorText.startsWith(prefix));
}

export type RateLimitSnapshot = Pick<SDKRateLimitInfo, "status" | "resetsAt">;

/**
 * When to automatically resend a turn that failed on a genuine usage-limit
 * hit, or null if nothing reliable enough to schedule on is available (the
 * turn just stays failed, as it always has — no worse than before this
 * existed).
 *
 * Prefers the SDK's own structured signal — a rate_limit_event frame with
 * status "rejected" and a resetsAt (epoch ms, or occasionally seconds from
 * an older producer; see normalizeEpoch) — over the CLI's human sentence: the
 * event is exact, while the sentence ("resets 7:30pm (Asia/Seoul)") carries
 * no date and only a display-locale clock. The sentence is the fallback for
 * a producer that has not sent (or has not yet sent) the structured event,
 * not the primary source.
 *
 * `afterResetMs` is RETRY_AFTER_RESET_MS in production; ClaudeSessionOptions
 * lets a test shorten it the same way authRetryDelaysMs already does for the
 * login-refresh race, rather than a test waiting out a real minute.
 */
export function resolveRetryAt(args: {
  rateLimitInfo: RateLimitSnapshot | null;
  errorText: string;
  now: number;
  afterResetMs: number;
}): number | null {
  const { rateLimitInfo, errorText, now, afterResetMs } = args;
  if (rateLimitInfo?.status === "rejected" && typeof rateLimitInfo.resetsAt === "number") {
    return normalizeEpoch(rateLimitInfo.resetsAt) + afterResetMs;
  }
  const parsed = parseResetClock(errorText);
  if (!parsed) return null;
  const resetsAt = nextOccurrenceInZone(parsed.hour, parsed.minute, parsed.timeZone, now);
  if (resetsAt === null) return null;
  return resetsAt + afterResetMs;
}

/** A value too small to be a millisecond epoch any time this decade is a seconds
 *  epoch from an older producer instead — everything else the SDK stamps (ts,
 *  delayMs, …) is already milliseconds, so ms is the default assumption. */
function normalizeEpoch(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

const RESET_CLOCK = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i;

function parseResetClock(text: string): { hour: number; minute: number; timeZone: string } | null {
  const m = RESET_CLOCK.exec(text);
  if (!m) return null;
  const [, hourStr, minuteStr, ampm, timeZone] = m as unknown as [string, string, string, string, string];
  let hour = Number(hourStr) % 12;
  if (/pm/i.test(ampm)) hour += 12;
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  try {
    // Throws on a zone name Intl doesn't recognise; the only cheap validity check available.
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return null;
  }
  return { hour, minute, timeZone };
}

/**
 * The next real instant (epoch ms) `hour:minute` occurs in `timeZone` — today if
 * it has not passed yet there, tomorrow if it has. Built without a timezone
 * library: format `now` in the target zone to read its current offset from UTC,
 * then apply that same offset to the target wall-clock time. Off by the zone's
 * own DST shift on the rare reset that straddles a transition — a retry a
 * little early or late, never one that loses the turn (an early retry just
 * fails again and reschedules from the CLI's now-fresher reset text).
 */
function nextOccurrenceInZone(hour: number, minute: number, timeZone: string, now: number): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value] as const));
    const hour24 = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
    const zoneNow = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour24, Number(parts.minute), Number(parts.second));
    const offsetMs = zoneNow - now;
    let target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute, 0);
    if (target <= zoneNow) target += 24 * 60 * 60 * 1000;
    return target - offsetMs;
  } catch {
    return null;
  }
}
