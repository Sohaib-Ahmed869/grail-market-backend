// The listing state machine, now that a card can be promised to somebody.
//
// Accepting an offer used to change one word on the offer row. The listing
// stayed `live`, so a card two people had agreed on kept collecting offers
// from a third — every one of them a person who thought they were in with a
// chance, and a seller who could not honour any of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRANSITIONS, canMove } from "../src/listings/store.js";

test("an agreed card comes off the market without being destroyed", () => {
  assert.equal(canMove("live", "reserved"), true);
  // Reserved is not an end state. It resolves one way or the other.
  assert.equal(canMove("reserved", "sold"), true);
  assert.equal(canMove("reserved", "live"), true, "a deal that falls through returns it");
});

test("a deal that falls through does not cost the listing, and sold stays final", () => {
  // The first version of this flow marked the listing sold when the seller
  // dispatched, which then needed `sold -> live` so a collapsed deal could put
  // the card back — and that breaks a rule two older tests already held: a
  // sold listing is final.
  //
  // The card is not sold while it is in the post. It stays reserved until the
  // buyer confirms, so every point at which a deal can be cancelled is a
  // `reserved -> live` move and `sold` never has to reopen.
  assert.equal(canMove("reserved", "live"), true);
  assert.equal(canMove("sold", "live"), false, "a sold listing is final");
  assert.deepEqual(TRANSITIONS.sold, []);
});

test("nothing reaches the market without review", () => {
  // The rule the whole queue exists for. `live` must only be reachable from a
  // decision, from an unpause, or from a deal coming back.
  const into = Object.entries(TRANSITIONS)
    .filter(([, to]) => to.includes("live"))
    .map(([from]) => from)
    .sort();
  assert.deepEqual(into, ["in_review", "paused", "reserved"]);
  assert.equal(canMove("draft", "live"), false, "a draft cannot publish itself");
  assert.equal(canMove("rejected", "live"), false, "a rejection cannot publish itself");
  assert.equal(canMove("info_requested", "live"), false);
});

test("a withdrawal is still final", () => {
  assert.deepEqual(TRANSITIONS.withdrawn, []);
  assert.equal(canMove("withdrawn", "live"), false);
  assert.equal(canMove("withdrawn", "in_review"), false);
});

test("a reserved card cannot be quietly re-listed or paused around", () => {
  // Pausing a card somebody has agreed to buy would take it out of the deal's
  // sight without ending the deal.
  assert.equal(canMove("reserved", "paused"), false);
  assert.equal(canMove("reserved", "in_review"), false);
});

test("an unknown state moves nowhere", () => {
  assert.equal(canMove("nonsense", "live"), false);
  assert.equal(canMove("", "sold"), false);
});
