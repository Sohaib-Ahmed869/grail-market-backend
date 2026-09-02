// The alert rule is the whole point of a watchlist, and it is the part that
// is easy to get subtly wrong: measure from the wrong place and you either
// alert forever off one climb, or miss a slow drift that adds up to a third
// of the card's value.
import { test } from "node:test";
import assert from "node:assert/strict";

// The decision under test, extracted so it can be exercised without a
// database. `recordPrice` applies exactly this and then writes the result.
function decide({ baseline, price, alertPct, alertDir }) {
  if (baseline == null || baseline <= 0) return { fires: false, setsBaseline: true };
  const move = ((price - baseline) / baseline) * 100;
  const dirOk = alertDir === "up" ? move > 0 : alertDir === "down" ? move < 0 : true;
  const fires = alertPct != null && dirOk && Math.abs(move) >= alertPct;
  return { fires, move, setsBaseline: fires };
}

test("the first sighting sets a baseline and says nothing", () => {
  const r = decide({ baseline: null, price: 100, alertPct: 10, alertDir: "any" });
  assert.equal(r.fires, false);
  assert.equal(r.setsBaseline, true);
});

test("a move past the threshold fires, either way", () => {
  assert.equal(decide({ baseline: 100, price: 111, alertPct: 10, alertDir: "any" }).fires, true);
  assert.equal(decide({ baseline: 100, price: 89, alertPct: 10, alertDir: "any" }).fires, true);
});

test("a move short of it does not", () => {
  assert.equal(decide({ baseline: 100, price: 109, alertPct: 10, alertDir: "any" }).fires, false);
});

test("direction is respected", () => {
  assert.equal(decide({ baseline: 100, price: 120, alertPct: 10, alertDir: "down" }).fires, false);
  assert.equal(decide({ baseline: 100, price: 80, alertPct: 10, alertDir: "down" }).fires, true);
  assert.equal(decide({ baseline: 100, price: 80, alertPct: 10, alertDir: "up" }).fires, false);
});

test("one climb does not alert forever", () => {
  // baseline moves on fire, so the same price cannot fire again
  let baseline = 100;
  const first = decide({ baseline, price: 115, alertPct: 10, alertDir: "any" });
  assert.equal(first.fires, true);
  baseline = 115;
  assert.equal(decide({ baseline, price: 115, alertPct: 10, alertDir: "any" }).fires, false);
  assert.equal(decide({ baseline, price: 120, alertPct: 10, alertDir: "any" }).fires, false);
});

test("a slow drift still adds up", () => {
  // 4% a day for four days never trips a daily comparison, but it is 16%
  // from the last thing the watcher was told, so it fires
  const baseline = 100;
  for (const p of [104, 108, 112]) {
    assert.equal(decide({ baseline, price: p, alertPct: 15, alertDir: "any" }).fires, false);
  }
  assert.equal(decide({ baseline, price: 116, alertPct: 15, alertDir: "any" }).fires, true);
});

test("no alert set means no alert", () => {
  assert.equal(decide({ baseline: 100, price: 300, alertPct: null, alertDir: "any" }).fires, false);
});
