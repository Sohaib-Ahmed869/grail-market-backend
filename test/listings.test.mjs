// The listing state machine. "live" is the transition that matters — it is the
// moment a card becomes visible to strangers — and the product's whole claim
// is that a human sees it first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRANSITIONS, canMove, LISTINGS_SCHEMA } from "../src/listings/store.js";

test("nothing reaches live without passing through review", () => {
  // The claim on every screen is that a person checks each listing. If a draft
  // could publish itself, that claim is false and nobody would find out until
  // a fraudulent listing was already up.
  assert.equal(canMove("draft", "live"), false);
  assert.equal(canMove("rejected", "live"), false);
  assert.equal(canMove("in_review", "live"), true);
});

test("a sold or withdrawn listing is final", () => {
  // Otherwise a card that changed hands could quietly go back on the market,
  // and the sale we recorded as a comp would describe a listing that is live.
  assert.deepEqual(TRANSITIONS.sold, []);
  assert.deepEqual(TRANSITIONS.withdrawn, []);
  assert.equal(canMove("sold", "live"), false);
});

test("a rejected listing can be fixed and resubmitted", () => {
  // A rejection is a correction, not a death sentence.
  assert.equal(canMove("rejected", "in_review"), true);
});

test("a seller can withdraw from anywhere that is still open", () => {
  for (const from of ["draft", "in_review", "live", "rejected"]) {
    assert.equal(canMove(from, "withdrawn"), true, from);
  }
});

test("an unknown state moves nowhere rather than everywhere", () => {
  // A typo in a status must fail closed. Failing open would mean an
  // unrecognised listing could reach live.
  assert.equal(canMove("banana", "live"), false);
  assert.equal(canMove("", "live"), false);
});

test("listings default to draft, never to live", () => {
  assert.match(LISTINGS_SCHEMA, /status\s+text NOT NULL DEFAULT 'draft'/);
});

test("the market index is ordered featured-first, then newest", () => {
  // Stated on screen too, so a paid boost never looks like an arbitrary order.
  assert.match(LISTINGS_SCHEMA, /listings_live ON listings \(status, featured_until DESC NULLS LAST, live_at DESC\)/);
});
