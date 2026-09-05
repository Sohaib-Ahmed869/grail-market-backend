// There is no cron process, so these two guards ARE the scheduler. The
// failure modes are a job that never runs and a job every instance runs at
// once, and both are silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { worthChecking, isDue, canClaim, DAILY, LEASE_MS } from "../src/maintenance/schedule.js";

const NOW = 1_800_000_000_000;

test("a fresh process always looks once", () => {
  // otherwise a restart right after a missed window waits a full day
  assert.equal(worthChecking(null, DAILY, NOW), true);
});

test("the local guard keeps the common case off the database", () => {
  assert.equal(worthChecking(NOW, DAILY, NOW + 60_000), false);
  // a tenth of a day is 2.4 hours
  assert.equal(worthChecking(NOW, DAILY, NOW + 2.3 * 3600_000), false);
  assert.equal(worthChecking(NOW, DAILY, NOW + 2.5 * 3600_000), true);
});

test("the local guard never checks more than once a minute, whatever the interval", () => {
  // a job with a tiny interval must not put a query on every request
  assert.equal(worthChecking(NOW, 5_000, NOW + 30_000), false);
  assert.equal(worthChecking(NOW, 5_000, NOW + 61_000), true);
});

test("a job that has never run is due", () => {
  assert.equal(isDue(null, DAILY, NOW), true);
  assert.equal(isDue(undefined, DAILY, NOW), true);
  // and so is one whose timestamp is unreadable — better to run twice than
  // to stop forever because a column holds something unexpected
  assert.equal(isDue("not a date", DAILY, NOW), true);
});

test("due is measured from the last run, and the boundary is inclusive", () => {
  const ran = new Date(NOW - DAILY);
  assert.equal(isDue(ran, DAILY, NOW), true);
  assert.equal(isDue(new Date(NOW - DAILY + 1), DAILY, NOW), false);
  assert.equal(isDue(new Date(NOW), DAILY, NOW), false);
});

test("an unclaimed job can be taken", () => {
  assert.equal(canClaim(null, NOW), true);
});

test("a live claim blocks a second instance", () => {
  // the case that matters: two boxes wake at the same moment
  assert.equal(canClaim(new Date(NOW), NOW), false);
  assert.equal(canClaim(new Date(NOW - LEASE_MS + 1000), NOW), false);
});

test("a claim expires, so a process that died mid-job does not stop it forever", () => {
  assert.equal(canClaim(new Date(NOW - LEASE_MS), NOW), true);
  assert.equal(canClaim(new Date(NOW - LEASE_MS * 2), NOW), true);
});

test("the lease is shorter than the interval it guards", () => {
  // otherwise a stuck claim outlives the window and the job skips a day
  assert.ok(LEASE_MS < DAILY);
});
