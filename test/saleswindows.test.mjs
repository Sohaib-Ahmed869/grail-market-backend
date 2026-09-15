// GM001-28: last sale, 7-day and 30-day windows for ONE exact (card, grader,
// grade), from our own sales ledger and stored daily prices — not only the
// provider's percentages. Invariant 1: every call here is one key; nothing is
// ever mixed across graders or grades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { salesWindows, MIN_WINDOW_SALES } from "../src/history/windows.js";

const FX = { base: "USD", date: "2026-09-14", rates: { USD: 1, AUD: 1.5, GBP: 0.8 } };
const NOW = Date.UTC(2026, 8, 14, 12);
const at = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const sale = (price, daysAgo, currency = "AUD", source = "thecardapi:ebay") => ({
  saleId: `s${price}-${daysAgo}-${currency}`, catalogId: "base1-4", grader: "PSA", grade: "9",
  price, currency, soldAt: at(daysAgo), source, sourceUrl: null, rawTitle: null,
});

test("the last sale comes back in AUD and USD with its date and source", () => {
  const w = salesWindows([sale(150, 2, "USD"), sale(300, 1, "AUD")], [], FX, NOW);
  assert.equal(w.lastSale.soldAt, at(1));
  assert.equal(w.lastSale.aud, 300);
  assert.equal(w.lastSale.usd, 200);
  assert.equal(w.lastSale.source, "thecardapi:ebay");
});

test("windows use medians over converted prices, with count, low and high", () => {
  const w = salesWindows([sale(100, 1), sale(200, 2, "USD"), sale(120, 3), sale(110, 20)], [], FX, NOW);
  // 7d: 100, 300 (200 USD), 120 AUD -> median 120
  assert.equal(w.window7.count, 3);
  assert.equal(w.window7.median, 120);
  assert.equal(w.window7.low, 100);
  assert.equal(w.window7.high, 300);
  assert.equal(w.window30.count, 4);
  assert.equal(w.window30.median, 115);
});

test(`a window with fewer than ${MIN_WINDOW_SALES} sales reports its count and no figure`, () => {
  const w = salesWindows([sale(100, 1), sale(90, 12)], [], FX, NOW);
  assert.equal(w.window7.count, 1);
  assert.equal(w.window7.median, null);
  assert.equal(w.window7.changePct, null);
  assert.equal(w.window7.confidence, "none");
});

test("change is only given when both the window and the one before it hold enough sales", () => {
  // this week 110, 110 ; last week 100, 100  -> +10%
  const both = salesWindows([sale(110, 1), sale(110, 2), sale(100, 8), sale(100, 9)], [], FX, NOW);
  assert.equal(both.window7.changePct, 10);
  assert.equal(both.window7.previousCount, 2);
  // last week only one sale -> no change, though this week has a median
  const thin = salesWindows([sale(110, 1), sale(110, 2), sale(100, 8)], [], FX, NOW);
  assert.equal(thin.window7.median, 110);
  assert.equal(thin.window7.changePct, null);
});

test("one freak sale is set aside, the same rule as listing guidance", () => {
  const w = salesWindows([sale(100, 1), sale(100, 2), sale(105, 3), sale(2000, 4)], [], FX, NOW);
  assert.equal(w.window7.count, 3);
  assert.equal(w.window7.excluded, 1);
  assert.equal(w.window7.high, 105);
});

test("a currency with no rate is left out rather than read as 1:1", () => {
  const w = salesWindows([sale(100, 1), sale(100, 2), sale(999, 3, "XYZ")], [], FX, NOW);
  assert.equal(w.window7.count, 2);
  assert.equal(w.unconvertible, 1);
});

test("no sales at all is an empty answer, not zeros", () => {
  const w = salesWindows([], [], FX, NOW);
  assert.equal(w.lastSale, null);
  assert.equal(w.window7.count, 0);
  assert.equal(w.window7.median, null);
  assert.equal(w.asOf, null);
});

test("stored daily prices give close-to-close movement, labelled by how many days were observed", () => {
  const points = [
    { day: "2026-08-15", price: 80 }, { day: "2026-09-07", price: 100 },
    { day: "2026-09-10", price: 105 }, { day: "2026-09-14", price: 110 },
  ];
  const w = salesWindows([], points, FX, NOW);
  assert.equal(w.daily7.changePct, 10);         // 100 on 09-07 -> 110
  assert.equal(w.daily7.observed, 3);
  assert.equal(w.daily30.changePct, 37.5);      // 80 on 08-15 -> 110
  assert.equal(w.asOf, "2026-09-14");
  // not enough history for a period -> null, not a guess
  const short = salesWindows([], [{ day: "2026-09-13", price: 1 }, { day: "2026-09-14", price: 2 }], FX, NOW);
  assert.equal(short.daily7.changePct, null);
});
