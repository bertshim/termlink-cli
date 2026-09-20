import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsageLimitError, resolveRetryAt } from "../src/providers/claude/rate-limit.js";

test("isUsageLimitError: a CLI sentence starting with a genuinely-reached prefix counts", () => {
  assert.equal(isUsageLimitError("You've hit your session limit · resets 7:30pm (Asia/Seoul)"), true);
  assert.equal(isUsageLimitError("You've reached your weekly limit"), true);
});

test("isUsageLimitError: the API error code alone is enough, whatever the text says", () => {
  assert.equal(isUsageLimitError("something unrelated broke", "rate_limit"), true);
});

test("isUsageLimitError: an unrelated failure is not a usage-limit hit", () => {
  assert.equal(isUsageLimitError("overloaded, try again"), false);
  assert.equal(isUsageLimitError("something unrelated broke", "overloaded"), false);
});

test("isUsageLimitError: mentioning the words without starting with the prefix does not count", () => {
  assert.equal(isUsageLimitError("well, You've hit your session limit apparently"), false);
});

const now = Date.UTC(2026, 8, 18, 10, 0, 0);

test("resolveRetryAt: prefers the SDK's own resetsAt when the info says the limit is actually rejected", () => {
  const resetsAt = now + 5_000;
  const retryAt = resolveRetryAt({
    rateLimitInfo: { status: "rejected", resetsAt },
    errorText: "You've hit your session limit · resets 7:30pm (Asia/Seoul)",
    now,
    afterResetMs: 60_000,
  });
  assert.equal(retryAt, resetsAt + 60_000);
});

test("resolveRetryAt: a resetsAt small enough to be seconds, not milliseconds, is normalized", () => {
  const resetsSeconds = Math.floor((now + 5_000) / 1000);
  const retryAt = resolveRetryAt({
    rateLimitInfo: { status: "rejected", resetsAt: resetsSeconds },
    errorText: "You've hit your session limit",
    now,
    afterResetMs: 60_000,
  });
  assert.equal(retryAt, resetsSeconds * 1000 + 60_000);
});

test("resolveRetryAt: info that isn't actually a rejection is ignored, even with a resetsAt on it", () => {
  // "allowed_warning" (approaching the limit) is not a hit; falls back to the text, which has none here.
  const retryAt = resolveRetryAt({
    rateLimitInfo: { status: "allowed_warning", resetsAt: now + 5_000 },
    errorText: "no reset sentence here",
    now,
    afterResetMs: 60_000,
  });
  assert.equal(retryAt, null);
});

test("resolveRetryAt: falls back to parsing the CLI's own reset sentence when there is no structured info", () => {
  const retryAt = resolveRetryAt({
    rateLimitInfo: null,
    errorText: "You've hit your session limit · resets 7:30pm (Asia/Seoul)",
    now,
    afterResetMs: 60_000,
  });
  assert.notEqual(retryAt, null);
  const resetsAt = retryAt! - 60_000;
  assert.ok(resetsAt > now, "the resolved reset is in the future");
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(
    resetsAt,
  );
  assert.equal(clock, "19:30");
});

test("resolveRetryAt: a reset clock already past today resolves to tomorrow, not a negative wait", () => {
  // "now" is 2026-09-18 10:00 UTC = 19:00 in Asia/Seoul; 7:30pm Seoul has not passed
  // yet today, so pick a clock that already has (7:00am Seoul).
  const retryAt = resolveRetryAt({
    rateLimitInfo: null,
    errorText: "You've hit your session limit · resets 7:00am (Asia/Seoul)",
    now,
    afterResetMs: 0,
  });
  assert.notEqual(retryAt, null);
  const hoursOut = (retryAt! - now) / (60 * 60 * 1000);
  assert.ok(hoursOut > 0 && hoursOut < 24, `expected within the next day, got ${hoursOut}h`);
});

test("resolveRetryAt: an unrecognised time zone name does not throw, just gives up", () => {
  const retryAt = resolveRetryAt({
    rateLimitInfo: null,
    errorText: "You've hit your session limit · resets 7:30pm (Nowhere/Fake)",
    now,
    afterResetMs: 60_000,
  });
  assert.equal(retryAt, null);
});

test("resolveRetryAt: nothing to go on at all is null, not a guess", () => {
  assert.equal(resolveRetryAt({ rateLimitInfo: null, errorText: "something else entirely broke", now, afterResetMs: 60_000 }), null);
});
