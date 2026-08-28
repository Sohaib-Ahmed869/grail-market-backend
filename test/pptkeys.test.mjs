// The key pool decides what we spend and when we stop. Its failure modes are
// quiet ones — a key locked that shouldn't be, a budget summed from allowances
// nobody has observed — so they are pinned here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import {
  configuredKeys, pickKey, lockKey, lockedFor, readState, poolStatus,
} from "../src/scans/pptkeys.js";

const KEYS = "key-alpha,key-bravo,key-charlie";

beforeEach(() => {
  process.env.PPT_API_KEY = KEYS;
  db.exec("DELETE FROM kv WHERE key LIKE 'ppt:key:%'");
});

const idOf = (n) => configuredKeys()[n].id;

// A fake response carrying only the rate-limit headers we read.
const headers = (remaining, limit = 100) => ({
  headers: new Headers({
    "x-ratelimit-daily-limit": String(limit),
    "x-ratelimit-daily-remaining": String(remaining),
    "x-ratelimit-total-remaining": String(remaining),
  }),
});

test("keys parse from one env var, and one key still behaves like one key", () => {
  assert.equal(configuredKeys().length, 3);
  process.env.PPT_API_KEY = "solo";
  assert.equal(configuredKeys().length, 1);
  process.env.PPT_API_KEY = "";
  assert.deepEqual(configuredKeys(), []);
});

test("the same key listed twice is one key, not two budgets", () => {
  process.env.PPT_API_KEY = "key-alpha,key-bravo,key-alpha";
  const ids = configuredKeys().map((k) => k.id);
  assert.equal(ids.length, 2, "the duplicate is collapsed");
  assert.equal(new Set(ids).size, 2);
  // left in, a duplicate would be summed twice and the budget would claim
  // headroom that does not exist
});

test("a key's identity survives reordering, so state follows the key", () => {
  const before = configuredKeys().find((k) => k.key === "key-bravo").id;
  process.env.PPT_API_KEY = "key-charlie,key-bravo,key-alpha";
  const after = configuredKeys().find((k) => k.key === "key-bravo").id;
  assert.equal(before, after, "id is derived from the key, not its position");
});

test("the key material never becomes the id", () => {
  for (const k of configuredKeys()) {
    assert.ok(!k.id.includes(k.key), "an id must not embed the secret");
    assert.match(k.id, /^[0-9a-f]{8}$/);
  }
});

test("locking one key does not disable the others", async () => {
  const { recordKeyQuota } = await import("../src/scans/pptkeys.js");
  for (const k of configuredKeys()) recordKeyQuota(k.id, headers(100));
  lockKey(idOf(0), Date.now() + 60_000);

  assert.ok(lockedFor(idOf(0)) > 0, "the exhausted key is locked");
  assert.equal(lockedFor(idOf(1)), 0, "its neighbour is untouched");

  const chosen = pickKey(6);
  assert.ok(chosen, "the pool still has room");
  assert.notEqual(chosen.id, idOf(0), "and does not hand back the locked key");
});

test("every key locked means no key, not a locked one", () => {
  for (const k of configuredKeys()) lockKey(k.id, Date.now() + 60_000);
  assert.equal(pickKey(6), null);
  assert.equal(poolStatus().allLockedOut, true);
});

test("an expired lock is spendable again without intervention", () => {
  for (const k of configuredKeys()) lockKey(k.id, Date.now() - 1);
  assert.ok(pickKey(6), "a lock in the past does not hold");
  assert.equal(poolStatus().allLockedOut, false);
});

test("the fullest key is drained first, not round-robin", async () => {
  const { recordKeyQuota } = await import("../src/scans/pptkeys.js");
  recordKeyQuota(idOf(0), headers(10));
  recordKeyQuota(idOf(1), headers(90));
  recordKeyQuota(idOf(2), headers(50));
  // round-robin would land every key near empty at the same moment, so nothing
  // is left anywhere and everything waits for the same reset
  assert.equal(pickKey(6).id, idOf(1));
});

test("a key too poor to cover the lookup is skipped, not attempted", async () => {
  const { recordKeyQuota } = await import("../src/scans/pptkeys.js");
  recordKeyQuota(idOf(0), headers(2));
  recordKeyQuota(idOf(1), headers(2));
  recordKeyQuota(idOf(2), headers(2));
  assert.equal(pickKey(6), null, "2 credits cannot pay for a 6-credit lookup");
  assert.ok(pickKey(2), "but it can pay for a 2-credit one");
});

test("a key we have never called sorts first — using it is how we learn", async () => {
  const { recordKeyQuota } = await import("../src/scans/pptkeys.js");
  recordKeyQuota(idOf(0), headers(90));
  recordKeyQuota(idOf(2), headers(80));
  assert.equal(pickKey(6).id, idOf(1), "the unobserved key goes first");
});

test("the pool reports only credits it has actually seen", async () => {
  const { recordKeyQuota } = await import("../src/scans/pptkeys.js");
  assert.equal(poolStatus().totalRemaining, null, "nothing observed, nothing claimed");
  recordKeyQuota(idOf(0), headers(40));
  recordKeyQuota(idOf(1), headers(60));
  // the third key is real but never called: it must not contribute an assumed
  // allowance, or the budget display starts inventing credits
  assert.equal(poolStatus().totalRemaining, 100);
  assert.equal(poolStatus().dailyLimit, 200);
});

test("state is per key, and reading one does not invent the others", () => {
  lockKey(idOf(1), 1234567890);
  assert.equal(readState(idOf(1)).lockedUntil, 1234567890);
  assert.equal(readState(idOf(0)).lockedUntil, 0);
  assert.equal(readState(idOf(0)).totalRemaining, null);
});
