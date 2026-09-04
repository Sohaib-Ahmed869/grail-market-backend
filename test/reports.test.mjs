// The reporting page's arithmetic.
//
// Everything here is the pure part: dated rows in, the twelve numbers a chart
// draws out. It needs no store, which is the point — bucketing is where a
// report quietly starts disagreeing with the queue it summarises, and an
// off-by-one there is invisible on screen. Every column still has a plausible
// number in it; they are just the wrong week's.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketing,
  buckets,
  delta,
  fold,
  hoursLabel,
  isPeriod,
  PERIODS,
  running,
} from "../src/admin/reports.store.js";

const DAY = 86_400_000;

/* ========================================================== the period */

test("every period the console offers is a period the API knows", () => {
  for (const key of ["7d", "30d", "quarter", "ytd"]) {
    assert.ok(isPeriod(key), `${key} should be a period`);
    assert.ok(PERIODS[key].days > 0);
  }
  assert.equal(isPeriod("last-tuesday"), false);
});

/* A period nobody asked for must not be able to reach the query builder as a
   NaN day count — the route falls back, and this is the check it falls back
   on. */
test("an unknown period is not a period", () => {
  assert.equal(isPeriod(""), false);
  assert.equal(isPeriod("toString"), false, "inherited keys are not periods");
});

/* ========================================================= the bucketing */

test("a short period is drawn in days, a long one in weeks", () => {
  assert.equal(bucketing(7).unit, "day");
  assert.equal(bucketing(7).count, 7, "seven days is seven columns, not one");
  assert.equal(bucketing(30).unit, "week");
  assert.equal(bucketing(90).unit, "week");
});

test("no period is drawn in more than twelve columns", () => {
  for (const days of [7, 14, 30, 90, 365, 4000]) {
    assert.ok(bucketing(days).count <= 12, `${days} days`);
  }
});

/* A year in seven-day buckets is 52 columns; the chart has twelve. The step
   widens instead, or eleven months fall off the left of the page.

   This is the one that is invisible when it is wrong: twelve seven-day
   buckets are 84 days, so a 90-day period drawn in them loses its first week
   while every column on screen still holds a plausible number. */
test("the buckets always cover the period they are drawn for", () => {
  for (const key of Object.keys(PERIODS)) {
    const { days } = PERIODS[key];
    const { step, count } = bucketing(days);
    assert.ok(step * count >= days, `${key}: ${count} × ${step}d must cover ${days}d`);
  }
  assert.equal(bucketing(365).count, 12);
});

test("the buckets a series is drawn against run up to now", () => {
  const { starts, labels, step } = buckets(30);
  assert.equal(starts.length, labels.length);
  assert.ok(starts.length > 1);
  for (let i = 1; i < starts.length; i++) {
    assert.equal(
      starts[i].getTime() - starts[i - 1].getTime(),
      step * DAY,
      "buckets must be evenly spaced",
    );
  }
  const last = starts[starts.length - 1].getTime() + step * DAY;
  assert.ok(Math.abs(last - Date.now()) < 60_000, "the last bucket ends about now");
});

/* ============================================================== folding */

test("a row lands in the bucket its date falls in", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const starts = [0, 1, 2, 3].map((i) => new Date(start.getTime() + i * 7 * DAY));
  const rows = [
    { at: "2026-01-01T00:00:00Z", value: 1 }, // first instant of bucket 0
    { at: "2026-01-07T23:59:00Z", value: 1 }, // last of bucket 0
    { at: "2026-01-08T00:00:00Z", value: 1 }, // first of bucket 1
    { at: "2026-01-22T12:00:00Z", value: 5 }, // bucket 3
  ];
  assert.deepEqual(fold(rows, starts, 7), [2, 1, 0, 5]);
});

/* An empty bucket is a fact about the week, not a row to leave out. Closing
   the gap up would move every later column one to the left. */
test("a bucket nothing happened in is a zero, not a missing column", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const starts = [0, 1, 2].map((i) => new Date(start.getTime() + i * DAY));
  const out = fold([{ at: "2026-01-03T06:00:00Z", value: 4 }], starts, 1);
  assert.equal(out.length, 3);
  assert.deepEqual(out, [0, 0, 4]);
});

test("rows outside the window are dropped rather than piled onto an end bucket", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const starts = [0, 1].map((i) => new Date(start.getTime() + i * DAY));
  const out = fold(
    [
      { at: "2025-12-25T00:00:00Z", value: 99 }, // before
      { at: "2026-01-09T00:00:00Z", value: 99 }, // after
      { at: "2026-01-01T09:00:00Z", value: 3 },
    ],
    starts,
    1,
  );
  assert.deepEqual(out, [3, 0], "a row from last month must not inflate week one");
});

test("folding sums the values rather than counting the rows", () => {
  const starts = [new Date("2026-01-01T00:00:00Z")];
  const out = fold(
    [
      { at: "2026-01-01T01:00:00Z", value: 120.5 },
      { at: "2026-01-01T02:00:00Z", value: 79.5 },
    ],
    starts,
    1,
  );
  assert.deepEqual(out, [200]);
});

test("a Date is folded the same as the string the driver would hand back", () => {
  const starts = [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z")];
  const asDate = fold([{ at: new Date("2026-01-02T05:00:00Z"), value: 1 }], starts, 1);
  const asText = fold([{ at: "2026-01-02T05:00:00Z", value: 1 }], starts, 1);
  assert.deepEqual(asDate, asText);
});

/* ========================================================== running total */

test("a running total starts from what was already there", () => {
  assert.deepEqual(running(100, [5, 0, 3]), [105, 105, 108]);
});

/* Member growth is the count of everybody, not of this week's joiners. Without
   the base the chart would open at zero members and climb to the number who
   happened to sign up in the period. */
test("a running total is not a per-bucket count", () => {
  assert.deepEqual(running(0, [1, 1, 1]), [1, 2, 3]);
});

/* ================================================================ deltas */

test("growth from nothing has no percentage", () => {
  assert.equal(delta(40, 0), null, "40 up from 0 is not a percentage");
});

test("a delta names its direction", () => {
  assert.equal(delta(120, 100).dir, "up");
  assert.equal(delta(80, 100).dir, "down");
  assert.equal(delta(100, 100).dir, "flat");
});

/* A figure that moved by a rounding error should not be reported as movement:
   "0.0% up" is a claim about a trend that is not there. */
test("a movement too small to matter reads as flat", () => {
  const d = delta(1000, 1002);
  assert.equal(d.dir, "flat");
});

/* =============================================================== durations */

test("a duration is printed in the units it is worth reading in", () => {
  assert.equal(hoursLabel(5.2), "5h 12m");
  assert.equal(hoursLabel(24), "24h");
  assert.equal(hoursLabel(0.5), "30m");
});

/* No decision taken is not "0h to decide". A median over an empty set has no
   answer and the panel has to be able to say so. */
test("no median is an em dash, never a zero", () => {
  assert.equal(hoursLabel(null), "—");
  assert.equal(hoursLabel(NaN), "—");
});
