// Tiers decide who may do what with someone else's money involved, so the
// ladder is pinned: each step needs everything below it, and nothing skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tierOf, requiredFor, whatIsMissing, needsHighValue } from "../src/identity/tiers.js";

const at = (o = {}) => ({
  phoneVerified: false, hasPaymentInstrument: false,
  identityStatus: null, completedSales: 0, addressVerified: false, ...o,
});

test("a new account browses and nothing more", () => {
  assert.equal(tierOf(at()), 0);
});

test("tier 1 needs a phone AND a payment method", () => {
  assert.equal(tierOf(at({ phoneVerified: true })), 0);
  assert.equal(tierOf(at({ hasPaymentInstrument: true })), 0);
  assert.equal(tierOf(at({ phoneVerified: true, hasPaymentInstrument: true })), 1);
});

test("a passed ID check is tier 2, with or without the steps below it", () => {
  // Someone can pass the ID check before adding a card. Holding them at 0
  // because of an unticked box below would be pedantry, not safety.
  assert.equal(tierOf(at({ identityStatus: "Approved" })), 2);
});

test("an ID check still in review does not count", () => {
  for (const s of ["In Review", "Declined", "Not Started", "Abandoned"]) {
    assert.ok(tierOf(at({ identityStatus: s })) < 2, `${s} should not reach tier 2`);
  }
});

test("tier 3 is earned: address plus a trading record", () => {
  const base = { identityStatus: "Approved", addressVerified: true };
  assert.equal(tierOf(at({ ...base, completedSales: 0 })), 2);
  assert.equal(tierOf(at({ ...base, completedSales: 3 })), 3);
  // address alone is not enough, and neither is history alone
  assert.equal(tierOf(at({ identityStatus: "Approved", completedSales: 9 })), 2);
});

test("the gates sit where the scope document puts them", () => {
  assert.equal(requiredFor("browse"), 0);
  assert.equal(requiredFor("watch"), 0);
  assert.equal(requiredFor("offer"), 1);
  assert.equal(requiredFor("sell"), 2);
  assert.equal(requiredFor("sell-high-value"), 3);
});

test("a blocked person is told the next step, not just refused", () => {
  assert.match(whatIsMissing(0, 1), /phone/i);
  assert.match(whatIsMissing(1, 2), /ID check/i);
  assert.match(whatIsMissing(2, 3), /address/i);
  assert.equal(whatIsMissing(2, 2), null, "no message when already past the gate");
  assert.equal(whatIsMissing(3, 1), null);
});

test("the high-value line is a price, not a guess", () => {
  assert.equal(needsHighValue(1999), false);
  assert.equal(needsHighValue(2000), true);
  assert.equal(needsHighValue(41500), true);
});

test("with the inputs to hand, the message names the one thing missing", () => {
  const phoneOnly = at({ phoneVerified: true });
  assert.match(whatIsMissing(0, 1, phoneOnly), /payment method/i);
  assert.ok(!/phone/i.test(whatIsMissing(0, 1, phoneOnly)), "should not ask for a phone they have");

  const payOnly = at({ hasPaymentInstrument: true });
  assert.match(whatIsMissing(0, 1, payOnly), /phone/i);

  // without inputs it asks for both, which is correct rather than precise
  assert.match(whatIsMissing(0, 1), /phone/i);
  assert.match(whatIsMissing(0, 1), /payment/i);
});
