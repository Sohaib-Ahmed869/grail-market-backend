// What to list a card for, and when to refuse to say.
//
// The rule is the client's, recorded on GM001-59: settled sales, never asking
// prices; the three most recent, PROVIDED they sit close together in time; a
// recommended range the seller may list above or below. Ahmed's explicit
// exclusion — "do not average a sale from six months ago against a recent
// one" — is the clause most of these tests exist for, because averaging the
// window away is the easy mistake and it produces a number that was never
// true on any day.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listingGuidance, hasGuidance, MAX_SPREAD_DAYS, WANTED,
} from "../src/sales/guidance.js";

const FX = { base: "USD", date: "2026-09-14", rates: { USD: 1, AUD: 1.5, GBP: 0.8 } };

const iso = (daysAgo) =>
  new Date(Date.UTC(2026, 8, 14) - daysAgo * 86400000).toISOString();

const sale = (price, daysAgo, currency = "AUD", source = "thecardapi:ebay") => ({
  saleId: `s${price}-${daysAgo}`, catalogId: "base1-4", grader: "PSA", grade: "9",
  price, currency, soldAt: iso(daysAgo), source, sourceUrl: null, rawTitle: null,
});

test("three recent sales close together give a three-point range", () => {
  const g = listingGuidance([sale(1000, 1), sale(1100, 5), sale(900, 9)], FX);
  assert.ok(hasGuidance(g));
  assert.equal(g.market, 1000);        // the settled mean
  assert.equal(g.quick, 880);          // below it, for a fast sale
  assert.equal(g.patient, 1120);       // above it, for a patient one
  assert.ok(g.quick < g.market && g.market < g.patient);
  assert.equal(g.sampleSize, 3);
  assert.equal(g.currency, "AUD");
});

test("the last sale date travels with the figures", () => {
  // Invariant 6: a range with no date reads the same whether the last sale was
  // yesterday or two years ago.
  const g = listingGuidance([sale(1000, 2), sale(1000, 4), sale(1000, 6)], FX);
  assert.ok(hasGuidance(g));
  assert.equal(g.lastSaleAt, iso(2));
  assert.equal(g.spreadDays, 4);
});

test("a six-month-old sale is not averaged against recent ones", () => {
  // The exclusion Ahmed stated outright.
  const g = listingGuidance([sale(1000, 1), sale(1100, 3), sale(400, 180)], FX);
  assert.ok(!hasGuidance(g));
  assert.equal(g.reason, "too-spread");
  assert.match(g.message, /too far apart/);
  // and it must NOT have quietly produced a number
  assert.equal(g.quick, undefined);
});

test("the window boundary holds in both directions", () => {
  const inside = listingGuidance([sale(100, 0), sale(100, 10), sale(100, MAX_SPREAD_DAYS)], FX);
  assert.ok(hasGuidance(inside));
  const outside = listingGuidance([sale(100, 0), sale(100, 10), sale(100, MAX_SPREAD_DAYS + 1)], FX);
  assert.ok(!hasGuidance(outside));
  assert.equal(outside.reason, "too-spread");
});

test("fewer than three settled sales is a refusal, not a guess", () => {
  const g = listingGuidance([sale(1000, 1), sale(1100, 2)], FX);
  assert.ok(!hasGuidance(g));
  assert.equal(g.reason, "too-few");
  assert.equal(g.sampleSize, 2);
  assert.equal(g.lastSaleAt, iso(1));
});

test("no sales at all says so", () => {
  const g = listingGuidance([], FX);
  assert.ok(!hasGuidance(g));
  assert.equal(g.reason, "no-sales");
  assert.equal(g.lastSaleAt, null);
});

test("only the three MOST RECENT are used", () => {
  // A fourth, older, cheaper sale must not drag the figure down.
  const g = listingGuidance(
    [sale(1000, 1), sale(1000, 2), sale(1000, 3), sale(10, 4)], FX,
  );
  assert.ok(hasGuidance(g));
  assert.equal(g.market, 1000);
  assert.equal(g.sampleSize, WANTED);
});

test("order is not trusted from the caller", () => {
  // Handed oldest-first, it must still take the newest three — otherwise the
  // range is silently built from the stalest sales on record.
  const g = listingGuidance([sale(10, 40), sale(1000, 3), sale(1000, 1), sale(1000, 2)], FX);
  assert.ok(hasGuidance(g));
  assert.equal(g.market, 1000);
});

test("mixed currencies are converted, never averaged raw", () => {
  // The sold-comp feed writes AUD, USD and GBP for the same card. 1000 AUD,
  // 1000 USD (= 1500 AUD) and 800 GBP (= 1500 AUD) average to 1333.33 AUD,
  // not to 933.33 of nothing.
  const g = listingGuidance(
    [sale(1000, 1, "AUD"), sale(1000, 2, "USD"), sale(800, 3, "GBP")], FX,
  );
  assert.ok(hasGuidance(g));
  assert.equal(g.market, 1333.33);
  assert.equal(g.currency, "AUD");
});

test("a currency we hold no rate for is refused, not treated as 1:1", () => {
  const g = listingGuidance([sale(1000, 1, "XYZ"), sale(1000, 2, "XYZ"), sale(1000, 3, "XYZ")], FX);
  assert.ok(!hasGuidance(g));
  assert.equal(g.reason, "no-rate");
});

test("confidence reflects how tightly the sales agree", () => {
  const tight = listingGuidance([sale(100, 1), sale(102, 2), sale(101, 3)], FX);
  assert.ok(hasGuidance(tight));
  assert.equal(tight.confidence, "high");

  const loose = listingGuidance([sale(40, 1), sale(100, 2), sale(260, 3)], FX);
  assert.ok(hasGuidance(loose));
  assert.equal(loose.confidence, "low", "three wildly different prices are not one price");
});

test("the evidence comes back with the answer", () => {
  const g = listingGuidance([sale(1000, 1), sale(1100, 2), sale(900, 3)], FX);
  assert.ok(hasGuidance(g));
  assert.equal(g.sales.length, 3);
  assert.ok(g.sales.every((s) => s.soldAt && s.source));
});
