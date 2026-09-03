// The arithmetic is trivial. What is worth pinning is the edges: an unknown
// plan, the month rolling over, and the difference between "none left" and
// "no ceiling" — which are the same value in JavaScript and opposite answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaFor, periodOf, resetsOn, SCAN_LIMITS } from "../src/scans/quota.js";

const MARCH = Date.UTC(2026, 2, 15);

test("an unknown plan falls back to free, never to unlimited", () => {
  // a typo in a database column must not become a way to scan for nothing
  for (const bad of [null, undefined, "", "Dealer", "enterprise", "dealer "]) {
    const q = quotaFor(bad, 0, MARCH);
    assert.equal(q.plan, "free", `${JSON.stringify(bad)} was not treated as free`);
    assert.equal(q.limit, SCAN_LIMITS.free);
  }
});

test("no ceiling and none left are told apart", () => {
  const unlimited = quotaFor("dealer", 9_999, MARCH);
  assert.equal(unlimited.limit, null);
  assert.equal(unlimited.remaining, null, "null means no ceiling, not zero left");
  assert.equal(unlimited.ok, true);

  const spent = quotaFor("free", SCAN_LIMITS.free, MARCH);
  assert.equal(spent.remaining, 0);
  assert.equal(spent.ok, false);
});

test("the last scan of the allowance is allowed, the next is not", () => {
  assert.equal(quotaFor("free", SCAN_LIMITS.free - 1, MARCH).ok, true);
  assert.equal(quotaFor("free", SCAN_LIMITS.free, MARCH).ok, false);
});

test("remaining never goes negative, however the count got there", () => {
  const q = quotaFor("free", 500, MARCH);
  assert.equal(q.remaining, 0, "a member over their limit is at zero, not at -490");
  assert.equal(q.ok, false);
});

test("a rubbish count is zero rather than NaN", () => {
  for (const bad of [NaN, -5, undefined, null, "seven"]) {
    const q = quotaFor("free", bad, MARCH);
    assert.equal(q.used, 0, `${JSON.stringify(bad)} produced ${q.used}`);
    assert.equal(q.remaining, SCAN_LIMITS.free);
  }
});

test("the period is the calendar month", () => {
  assert.equal(periodOf(MARCH), "2026-03");
  assert.equal(periodOf(Date.UTC(2026, 11, 31)), "2026-12");
  // the very first instant of a month belongs to that month
  assert.equal(periodOf(Date.UTC(2026, 2, 1)), "2026-03");
});

test("the reset date is the first of next month, across a year boundary", () => {
  assert.equal(resetsOn(MARCH), "2026-04-01");
  assert.equal(resetsOn(Date.UTC(2026, 11, 20)), "2027-01-01");
  // and off the end of a 31-day month, where naive +1 day arithmetic slips
  assert.equal(resetsOn(Date.UTC(2026, 0, 31)), "2026-02-01");
});

test("every plan has a limit written down", () => {
  for (const plan of ["free", "starter", "collector", "dealer"]) {
    assert.ok(plan in SCAN_LIMITS, `${plan} has no scan allowance`);
  }
  // and paying for more must actually get you more
  assert.ok(SCAN_LIMITS.starter > SCAN_LIMITS.free);
  assert.ok(SCAN_LIMITS.collector > SCAN_LIMITS.starter);
  assert.equal(SCAN_LIMITS.dealer, null);
});
