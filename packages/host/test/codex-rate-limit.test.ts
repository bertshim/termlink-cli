import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsageLimitError, resolveRetryAt } from "../src/providers/codex/rate-limit.js";

const SENTENCE =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:54 PM.";

test("isUsageLimitError: Codex's own sentence counts, with either apostrophe", () => {
  assert.equal(isUsageLimitError(SENTENCE), true);
  assert.equal(isUsageLimitError("You’ve hit your usage limit. Try again at 6:54 PM."), true);
  assert.equal(isUsageLimitError("You've reached your usage limit."), true);
});

test("isUsageLimitError: an unrelated failure, or one that only quotes the words, is not a limit hit", () => {
  assert.equal(isUsageLimitError("model unavailable"), false);
  assert.equal(isUsageLimitError("stream disconnected, retrying"), false);
  assert.equal(isUsageLimitError("well, You've hit your usage limit apparently"), false);
});

// Local-time dates throughout: the sentence is written in this machine's own clock.
const now = new Date(2026, 9, 6, 18, 14, 0).getTime(); // Oct 6 2026, 6:14 PM local

test("resolveRetryAt: a window at 100% with a reset wins over the sentence", () => {
  const resetsAt = now + 5_000;
  const retryAt = resolveRetryAt({
    limits: { primary: { usedPercent: 100, resetsAt }, secondary: { usedPercent: 40, resetsAt: now + 99_000_000 } },
    errorText: SENTENCE,
    now,
    afterResetMs: 60_000,
  });
  assert.equal(retryAt, resetsAt + 60_000);
});

test("resolveRetryAt: with both windows full, waits for the later reset", () => {
  const retryAt = resolveRetryAt({
    limits: { primary: { usedPercent: 100, resetsAt: now + 1_000 }, secondary: { usedPercent: 100, resetsAt: now + 9_000 } },
    errorText: SENTENCE,
    now,
    afterResetMs: 0,
  });
  assert.equal(retryAt, now + 9_000);
});

test("resolveRetryAt: a window that is not full is ignored", () => {
  const retryAt = resolveRetryAt({
    limits: { primary: { usedPercent: 97, resetsAt: now + 5_000 } },
    errorText: SENTENCE,
    now,
    afterResetMs: 0,
  });
  assert.equal(retryAt, new Date(2026, 9, 6, 18, 54, 0).getTime());
});

test("resolveRetryAt: a reset already in the past is a stale snapshot, so the sentence is read instead", () => {
  const retryAt = resolveRetryAt({
    limits: { primary: { usedPercent: 100, resetsAt: now - 60_000 } },
    errorText: SENTENCE,
    now,
    afterResetMs: 0,
  });
  assert.equal(retryAt, new Date(2026, 9, 6, 18, 54, 0).getTime());
});

test("resolveRetryAt: a bare clock is today's, and tomorrow's once it has passed", () => {
  const later = resolveRetryAt({ limits: null, errorText: "try again at 6:54 PM.", now, afterResetMs: 60_000 });
  assert.equal(later, new Date(2026, 9, 6, 18, 54, 0).getTime() + 60_000);
  const passed = resolveRetryAt({ limits: null, errorText: "try again at 9:05 AM.", now, afterResetMs: 0 });
  assert.equal(passed, new Date(2026, 9, 7, 9, 5, 0).getTime());
});

test("resolveRetryAt: 12 AM and 12 PM are midnight and noon", () => {
  assert.equal(
    resolveRetryAt({ limits: null, errorText: "try again at 12:00 AM", now, afterResetMs: 0 }),
    new Date(2026, 9, 7, 0, 0, 0).getTime(),
  );
  assert.equal(
    resolveRetryAt({ limits: null, errorText: "try again at 12:30 PM", now: new Date(2026, 9, 6, 9, 0, 0).getTime(), afterResetMs: 0 }),
    new Date(2026, 9, 6, 12, 30, 0).getTime(),
  );
});

test("resolveRetryAt: a dated reset, for a limit further out, is that date", () => {
  assert.equal(
    resolveRetryAt({ limits: null, errorText: "or try again at Oct 9th, 2026 6:54 PM.", now, afterResetMs: 0 }),
    new Date(2026, 9, 9, 18, 54, 0).getTime(),
  );
  // No year: this one if it is still ahead, the next if not.
  assert.equal(
    resolveRetryAt({ limits: null, errorText: "try again at Nov 2nd 8:00 AM", now, afterResetMs: 0 }),
    new Date(2026, 10, 2, 8, 0, 0).getTime(),
  );
  assert.equal(
    resolveRetryAt({ limits: null, errorText: "try again at Jan 5th 8:00 AM", now, afterResetMs: 0 }),
    new Date(2027, 0, 5, 8, 0, 0).getTime(),
  );
});

test("resolveRetryAt: nothing to go on at all is null, not a guess", () => {
  assert.equal(resolveRetryAt({ limits: {}, errorText: "You've hit your usage limit.", now, afterResetMs: 0 }), null);
  assert.equal(resolveRetryAt({ limits: null, errorText: "try again later", now, afterResetMs: 0 }), null);
});
