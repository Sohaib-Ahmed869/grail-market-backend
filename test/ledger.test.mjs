// The sales ledger. Invariant 5 says append-only and invariant 1 says a price
// key is (card, grader, grade) — these pin both, because the ledger is what a
// price claim is answerable against months later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SALES_SCHEMA, PARSER_VERSION } from "../src/sales/ledger.js";

test("the schema has no update or delete path", () => {
  // Not a style preference. A sale that turns out wrong is corrected by
  // recording the correction; editing history is how a disputed price becomes
  // unanswerable.
  assert.match(SALES_SCHEMA, /CREATE TABLE IF NOT EXISTS sales_ledger/);
  assert.doesNotMatch(SALES_SCHEMA, /ON CONFLICT.*DO UPDATE/i);
});

test("every row carries the raw title and the parser version", () => {
  // So the whole history can be reparsed when the parser improves, rather than
  // being frozen at whatever we understood on the day it arrived.
  assert.match(SALES_SCHEMA, /raw_title/);
  assert.match(SALES_SCHEMA, /parser_version\s+text NOT NULL/);
  assert.ok(PARSER_VERSION.length > 0);
});

test("the index is keyed by card AND grader AND grade", () => {
  // Invariant 1: there is no grade-only lookup anywhere in this system, and a
  // PSA 9 must never answer for a BGS 9.
  assert.match(SALES_SCHEMA, /sales_ledger \(catalog_id, grader, grade, sold_at DESC\)/);
});

test("price and sold_at cannot be null", () => {
  // A sale without a price is not a sale, and one without a date cannot be
  // ordered — which is the only thing the screen asks of it.
  assert.match(SALES_SCHEMA, /price\s+numeric NOT NULL/);
  assert.match(SALES_SCHEMA, /sold_at\s+timestamptz NOT NULL/);
  assert.match(SALES_SCHEMA, /source\s+text NOT NULL/);
});
