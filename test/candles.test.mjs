// Candles decide what a price chart claims happened. The open and the close
// depend entirely on order, the high and low on nothing being dropped, and
// every one of those failures draws a plausible bar that is wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candles, bucketOf, availableRanges, RANGES } from "../src/history/candles.js";

const c = (day, price) => ({ day, price });

test("a bar takes its open from the first day and its close from the last", () => {
  const [bar] = candles(
    [c("2026-03-02", 10), c("2026-03-03", 14), c("2026-03-04", 9), c("2026-03-05", 12)],
    "week",
  );
  assert.equal(bar.open, 10, "the first day of the bar");
  assert.equal(bar.close, 12, "the last");
  assert.equal(bar.high, 14);
  assert.equal(bar.low, 9);
  assert.equal(bar.readings, 4);
});

test("input in the wrong order is sorted, not trusted", () => {
  // a series assembled from two sources is in no order at all, and open and
  // close depend entirely on it
  const [bar] = candles(
    [c("2026-03-05", 12), c("2026-03-02", 10), c("2026-03-04", 9)],
    "week",
  );
  assert.equal(bar.open, 10);
  assert.equal(bar.close, 12);
});

test("weeks start on Monday and a Sunday belongs to the week before it", () => {
  // 2026-03-01 is a Sunday; it belongs to the week beginning Monday 23 Feb
  assert.equal(bucketOf("2026-03-01", "week"), "2026-02-23");
  assert.equal(bucketOf("2026-03-02", "week"), "2026-03-02");   // Monday
  assert.equal(bucketOf("2026-03-08", "week"), "2026-03-02");   // Sunday
  assert.equal(bucketOf("2026-03-09", "week"), "2026-03-09");   // next Monday
});

test("days either side of a boundary do not land in one bar", () => {
  const bars = candles([c("2026-03-01", 5), c("2026-03-02", 9)], "week");
  assert.equal(bars.length, 2, "a Sunday and the Monday after are two weeks");
  assert.equal(bars[0].close, 5);
  assert.equal(bars[1].open, 9);
});

test("months bucket by calendar month", () => {
  assert.equal(bucketOf("2026-03-31", "month"), "2026-03-01");
  assert.equal(bucketOf("2026-04-01", "month"), "2026-04-01");
  const bars = candles([c("2026-03-30", 5), c("2026-04-02", 8)], "month");
  assert.equal(bars.length, 2);
});

test("a day bucket is one reading, which is a line and not a candle", () => {
  const bars = candles([c("2026-03-02", 10), c("2026-03-03", 12)], "day");
  assert.equal(bars.length, 2);
  // open == high == low == close is exactly what a single close looks like,
  // and is why a daily bar must never be DRAWN as a candle
  assert.deepEqual(
    [bars[0].open, bars[0].high, bars[0].low, bars[0].close],
    [10, 10, 10, 10],
  );
  assert.equal(bars[0].readings, 1);
});

test("rubbish readings are dropped rather than charted", () => {
  const bars = candles(
    [c("2026-03-02", 10), c("2026-03-03", 0), c("2026-03-04", NaN),
     c("nonsense", 5), c("2026-03-05", 12)],
    "week",
  );
  assert.equal(bars.length, 1);
  assert.equal(bars[0].readings, 2, "only the two real prices");
  assert.equal(bars[0].low, 10, "a zero must not become the low");
});

test("nothing in, nothing out", () => {
  assert.deepEqual(candles([], "week"), []);
  assert.deepEqual(candles([c("2026-03-02", 10)], "week").length, 1);
});

test("a bar size is offered once there are two bars of it", () => {
  // eight days spanning two calendar weeks but one month
  const eight = [c("2026-03-01", 10), c("2026-03-03", 11), c("2026-03-08", 12)];
  const got = availableRanges(eight);
  assert.ok(got.includes("D"), "three separate days is a daily chart");
  assert.ok(got.includes("W"), "1 Mar is one week and 3 Mar the next");
  assert.ok(!got.includes("M"), "all of it is March, so monthly is one bar");
});

test("one bar is not a chart", () => {
  // three readings, all in the same week
  const week = [c("2026-03-02", 10), c("2026-03-03", 11), c("2026-03-04", 12)];
  assert.ok(!availableRanges(week).includes("W"), "one weekly bar is a rectangle");
  assert.ok(availableRanges(week).includes("D"));
});

test("a long series offers every bar size", () => {
  const long = [c("2024-01-01", 10), c("2025-06-01", 15), c("2026-03-10", 20)];
  assert.deepEqual(availableRanges(long), RANGES.map((r) => r.id));
});

test("one reading offers nothing at all", () => {
  assert.deepEqual(availableRanges([c("2026-03-02", 10)]), []);
  assert.deepEqual(availableRanges([]), []);
});
