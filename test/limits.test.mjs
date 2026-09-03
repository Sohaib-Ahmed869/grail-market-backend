// A limiter that is slightly wrong is worse than none: it either lets an
// attacker through or locks a real person out of their own account. These pin
// the window's edges and the two behaviours that are easy to get backwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindow } from "../src/limits/bucket.js";

const RULE = { limit: 5, windowMs: 60_000 };
const NOW = 1_700_000_000_000;

test("the allowance is spent, then refused", () => {
  const w = new SlidingWindow();
  for (let i = 0; i < 5; i++) {
    const d = w.check("ip", RULE, NOW);
    assert.ok(d.ok, `attempt ${i + 1} should pass`);
    assert.equal(d.remaining, 4 - i);
  }
  const d = w.check("ip", RULE, NOW);
  assert.equal(d.ok, false);
  assert.ok(d.retryAfterSec > 0 && d.retryAfterSec <= 60);
});

test("it slides — a fixed window would allow double at the boundary", () => {
  const w = new SlidingWindow();
  // spend the whole allowance at the very end of a minute
  for (let i = 0; i < 5; i++) w.check("ip", RULE, NOW + 59_000);
  // a fixed window resets here and would allow five more immediately
  assert.equal(w.check("ip", RULE, NOW + 60_100).ok, false, "the window must slide");
  // once the first five have genuinely aged out, it opens again
  assert.equal(w.check("ip", RULE, NOW + 120_000).ok, true);
});

test("refused attempts count, so hammering does not drain the window", () => {
  const w = new SlidingWindow();
  for (let i = 0; i < 5; i++) w.check("ip", RULE, NOW);
  // twenty refusals spread across the window
  for (let i = 0; i < 20; i++) w.check("ip", RULE, NOW + i * 1000);
  assert.equal(w.check("ip", RULE, NOW + 59_000).ok, false, "still shut");
});

test("keys do not interfere", () => {
  const w = new SlidingWindow();
  for (let i = 0; i < 5; i++) w.check("a", RULE, NOW);
  assert.equal(w.check("a", RULE, NOW).ok, false);
  assert.equal(w.check("b", RULE, NOW).ok, true, "one address must not lock out another");
});

test("a success clears the count", () => {
  const w = new SlidingWindow();
  for (let i = 0; i < 4; i++) w.check("ip", RULE, NOW);
  // signed in on the fifth try — the next four typos should not lock them out
  w.clear("ip");
  for (let i = 0; i < 5; i++) {
    assert.ok(w.check("ip", RULE, NOW + 1000).ok, `attempt ${i + 1} after success`);
  }
});

test("retryAfter shrinks as the window drains, and never hits zero", () => {
  const w = new SlidingWindow();
  for (let i = 0; i < 6; i++) w.check("ip", RULE, NOW);
  const early = w.check("ip", RULE, NOW + 1_000);
  const late = w.check("ip", RULE, NOW + 50_000);
  assert.equal(early.ok, false);
  assert.equal(late.ok, false);
  assert.ok(late.retryAfterSec < early.retryAfterSec, "the wait must count down");
  assert.ok(late.retryAfterSec >= 1, "never tell a client to retry in 0 seconds");
});

test("the map does not grow without bound", () => {
  const w = new SlidingWindow(50);
  for (let i = 0; i < 500; i++) w.check(`ip-${i}`, RULE, NOW + i);
  // the sweep runs on a minute's cadence, so push past it
  w.check("last", RULE, NOW + 3_700_000);
  assert.ok(w.size <= 51, `held ${w.size} keys — it must forget`);
});
