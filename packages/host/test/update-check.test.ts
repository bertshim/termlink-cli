import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { checkForUpdate } from "../src/update-check.js";
import type { Fetch } from "../src/relay/api.js";

function fakeFetch(version: string, ok = true): Fetch {
  return (async () =>
    ({
      ok,
      json: async () => ({ version }),
    })) as unknown as Fetch;
}

function failingFetch(): Fetch {
  return (async () => {
    throw new Error("offline");
  }) as unknown as Fetch;
}

let dir: string;
let file: string;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "termlink-update-check-"));
  file = path.join(dir, "update-check.json");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(file, { force: true });
});

test("a newer version on the registry becomes a notice naming the fix", async () => {
  const line = await checkForUpdate("0.1.4", file, fakeFetch("0.2.0"));
  assert.ok(line);
  assert.match(line, /0\.1\.4 -> 0\.2\.0/);
  assert.match(line, /npm install -g @termlink\/cli/);
});

test("already current, or ahead of the registry, is quiet", async () => {
  assert.equal(await checkForUpdate("0.2.0", file, fakeFetch("0.2.0")), null);
  assert.equal(await checkForUpdate("0.3.0", file, fakeFetch("0.2.0")), null);
});

test("a two-segment jump compares correctly, not lexically", async () => {
  // "0.2.0" < "0.10.0" numerically but would sort the other way as a plain string.
  assert.ok(await checkForUpdate("0.2.0", file, fakeFetch("0.10.0")));
  assert.equal(await checkForUpdate("0.10.0", file, fakeFetch("0.2.0")), null);
});

test("an -rc build hears about its own release and anything past it", async () => {
  assert.ok(await checkForUpdate("0.1.5-rc", file, fakeFetch("0.1.5")));
  assert.ok(await checkForUpdate("0.1.5-rc", file, fakeFetch("0.1.6")));
  assert.ok(await checkForUpdate("0.1.5-rc", file, fakeFetch("0.2.0")));
});

test("an -rc build is quiet about the release it is already ahead of", async () => {
  assert.equal(await checkForUpdate("0.1.5-rc", file, fakeFetch("0.1.4")), null);
  assert.equal(await checkForUpdate("0.1.5-rc", file, fakeFetch("0.1.5-rc")), null);
});

test("a release is never told to move to a prerelease of itself", async () => {
  assert.equal(await checkForUpdate("0.1.5", file, fakeFetch("0.1.5-rc")), null);
});

test("an unparseable version on either side is quiet, not a false notice", async () => {
  assert.equal(await checkForUpdate("0.1.4", file, fakeFetch("not-a-version")), null);
  assert.equal(await checkForUpdate("dev", file, fakeFetch("0.2.0")), null);
});

test("offline, a non-OK response, or a malformed body never throws — just no notice", async () => {
  assert.equal(await checkForUpdate("0.1.4", file, failingFetch()), null);
  assert.equal(await checkForUpdate("0.1.4", file, fakeFetch("0.2.0", false)), null);
  const malformed = (async () => ({ ok: true, json: async () => ({}) })) as unknown as Fetch;
  assert.equal(await checkForUpdate("0.1.4", file, malformed), null);
});

test("a second check within a day reuses the cached result and does not refetch", async () => {
  let calls = 0;
  const counting: Fetch = (async () => {
    calls++;
    return { ok: true, json: async () => ({ version: "0.2.0" }) };
  }) as unknown as Fetch;

  const first = await checkForUpdate("0.1.4", file, counting);
  const second = await checkForUpdate("0.1.4", file, counting);
  assert.equal(calls, 1);
  assert.equal(first, second);

  const cached = JSON.parse(await readFile(file, "utf8")) as { latest?: string };
  assert.equal(cached.latest, "0.2.0");
});

test("a prior failed check is retried, not cached as permanently unknown", async () => {
  const first = await checkForUpdate("0.1.4", file, failingFetch());
  assert.equal(first, null);

  const second = await checkForUpdate("0.1.4", file, fakeFetch("0.2.0"));
  assert.ok(second);
});
