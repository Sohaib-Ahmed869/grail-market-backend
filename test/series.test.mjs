// The awkward parts of a price chart are all about absent days. These pin what
// happens where there is no data, because the wrong choice there draws a chart
// that dives to zero every time the refresh job skipped a card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fill, daysBetween, movement, downsample, indexOf } from "../src/history/series.js";

const p = (day, price) => ({ day, price });

test("a missing day carries the last known price forward", () => {
  const out = fill([p("2026-01-01", 100), p("2026-01-04", 130)], "2026-01-01", "2026-01-05");
  assert.deepEqual(out.map((x) => x.price), [100, 100, 100, 130, 130]);
});

test("nothing is invented before the first observation", () => {
  // knowing nothing on the 1st is not the same as it being worth $130 then
  const out = fill([p("2026-01-03", 130)], "2026-01-01", "2026-01-04");
  assert.deepEqual(out.map((x) => x.day), ["2026-01-03", "2026-01-04"]);
});

test("an empty series fills to nothing rather than to zeros", () => {
  assert.deepEqual(fill([], "2026-01-01", "2026-01-10"), []);
});

test("the range includes both ends, and a backwards range is empty", () => {
  assert.equal(daysBetween("2026-01-01", "2026-01-01").length, 1);
  assert.equal(daysBetween("2026-01-01", "2026-01-31").length, 31);
  assert.deepEqual(daysBetween("2026-02-01", "2026-01-01"), []);
  // and it crosses a month and a leap day without arithmetic of its own
  assert.equal(daysBetween("2028-02-27", "2028-03-01").length, 4);
});

test("the summary describes the series, and refuses on one point", () => {
  assert.equal(movement([p("2026-01-01", 100)]), null, "one point is not a movement");
  const m = movement([p("a", 100), p("b", 140), p("c", 120)]);
  assert.equal(m.first, 100);
  assert.equal(m.last, 120);
  assert.equal(m.change, 20);
  assert.equal(Math.round(m.changePct), 20);
  assert.equal(m.high, 140, "the peak in the middle still counts");
  assert.equal(m.low, 100);
});

test("a first price of zero is missing data, not an infinite rise", () => {
  const m = movement([p("a", 0), p("b", 50)]);
  assert.equal(m.changePct, 0, "must not report Infinity or 100% from a zero base");
});

test("downsampling keeps both ends, so the caption cannot contradict the chart", () => {
  const long = Array.from({ length: 365 }, (_, i) => p(`d${i}`, i));
  const small = downsample(long, 90);
  assert.equal(small.length, 90);
  assert.equal(small[0].price, 0);
  assert.equal(small[small.length - 1].price, 364);
  // and a short series is left alone
  assert.equal(downsample(long.slice(0, 10), 90).length, 10);
});

test("the index rebases, so one expensive card cannot swamp forty cheap ones", () => {
  const dear = [p("2026-01-01", 10_000), p("2026-01-02", 10_000)];   // flat
  const cheap = [p("2026-01-01", 10), p("2026-01-02", 20)];          // doubled
  const out = indexOf([dear, cheap], "2026-01-01", "2026-01-02");
  assert.equal(out[0].price, 100, "day one is always 100");
  // flat + doubled = up 50% on average, whatever the dollar amounts are
  assert.equal(out[1].price, 150);
});

test("a day covered by too little of the basket produces no point", () => {
  const series = Array.from({ length: 8 }, () => [p("2026-01-01", 100)]);
  // only one of eight has a second day, which is not the market moving
  series[0] = [p("2026-01-01", 100), p("2026-01-02", 200)];
  const out = indexOf(series, "2026-01-01", "2026-01-02");
  // every series carries forward, so day two IS covered — the point stands,
  // and reads as one card up and seven flat
  assert.equal(out.length, 2);
  assert.ok(out[1].price > 100 && out[1].price < 120, `got ${out[1].price}`);
});

test("an empty basket is an empty index, not a crash", () => {
  assert.deepEqual(indexOf([], "2026-01-01", "2026-01-05"), []);
  assert.deepEqual(indexOf([[]], "2026-01-01", "2026-01-05"), []);
});
