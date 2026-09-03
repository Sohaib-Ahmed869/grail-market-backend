// A dispute decides who keeps the money, so every one of these is a rule
// somebody would otherwise be able to bend: arguing with yourself, disputing
// a deal you were not in, or dismissing the accusation against you.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canRaise, canComment, canWithdraw, canResolve, statusAfterComment,
  isReason, isOutcome, RAISE_WINDOW_DAYS,
} from "../src/disputes/rules.js";

const deal = (o = {}) => ({
  sellerId: "seller", buyerId: "buyer",
  listingStatus: "sold", offerStatus: "accepted",
  existingStatus: null,
  ...o,
});

// ---- raising ---------------------------------------------------------------

test("either side of a completed trade may raise one", () => {
  const b = canRaise("buyer", deal(), "not-received");
  assert.deepEqual(b, { ok: true, against: "seller", role: "buyer" });
  const s = canRaise("seller", deal(), "not-paid");
  assert.deepEqual(s, { ok: true, against: "buyer", role: "seller" });
});

test("a stranger cannot raise a dispute about someone else's deal", () => {
  assert.deepEqual(canRaise("nosey", deal(), "damaged"), { ok: false, why: "not-party" });
});

test("nobody disputes a deal with themselves", () => {
  const d = deal({ sellerId: "same", buyerId: "same" });
  assert.deepEqual(canRaise("same", d, "damaged"), { ok: false, why: "self" });
});

test("a trade that did not complete has nothing to dispute", () => {
  // sold, but no accepted offer — there is no counterparty to name
  assert.equal(canRaise("buyer", deal({ offerStatus: "pending" }), "damaged").why, "no-deal");
  // an accepted offer on a listing that never shipped is not a trade either
  assert.equal(canRaise("buyer", deal({ listingStatus: "live" }), "damaged").why, "no-deal");
  // and with no buyer there is nobody on the other side
  assert.equal(canRaise("seller", deal({ buyerId: null }), "not-paid").why, "no-deal");
});

test("an invented reason code is refused before anything else is checked", () => {
  assert.deepEqual(canRaise("buyer", deal(), "give-me-money"), { ok: false, why: "bad-reason" });
  assert.ok(isReason("counterfeit"));
  assert.ok(!isReason("counterfiet"));
});

test("one live dispute at a time, and a resolved one does not reopen", () => {
  assert.equal(canRaise("buyer", deal({ existingStatus: "open" }), "damaged").why, "already-open");
  assert.equal(canRaise("buyer", deal({ existingStatus: "answered" }), "damaged").why, "already-open");
  assert.equal(
    canRaise("buyer", deal({ existingStatus: "resolved" }), "damaged").why,
    "already-resolved",
  );
});

test("a withdrawn dispute may be raised again", () => {
  // withdrawing is usually "let me talk to them first", and that sometimes
  // fails — a permanent bar would punish trying to settle it privately
  assert.ok(canRaise("buyer", deal({ existingStatus: "withdrawn" }), "damaged").ok);
});

test("the window closes, and its edge is inclusive", () => {
  assert.ok(canRaise("buyer", deal(), "damaged", RAISE_WINDOW_DAYS).ok, "the last day still counts");
  assert.equal(canRaise("buyer", deal(), "damaged", RAISE_WINDOW_DAYS + 1).why, "no-deal");
  assert.ok(canRaise("buyer", deal(), "damaged", null).ok, "an unknown sale date is not a refusal");
});

// ---- the thread ------------------------------------------------------------

const d = (o = {}) => ({ raisedBy: "buyer", against: "seller", status: "open", ...o });

test("both parties may add to a live dispute, and nobody else", () => {
  assert.ok(canComment("buyer", d()));
  assert.ok(canComment("seller", d()));
  assert.ok(!canComment("nosey", d()));
});

test("a settled dispute is a record, not a conversation", () => {
  for (const status of ["resolved", "withdrawn"]) {
    assert.ok(!canComment("buyer", d({ status })), `commented on a ${status} dispute`);
    assert.ok(!canComment("seller", d({ status })));
  }
});

test("the accused answering is what moves it out of 'open' — once", () => {
  assert.equal(statusAfterComment("seller", d()), "answered");
  // the raiser talking to themselves does not count as an answer
  assert.equal(statusAfterComment("buyer", d()), "open");
  // and a second reply does not move it again
  assert.equal(statusAfterComment("seller", d({ status: "answered" })), "answered");
  assert.equal(statusAfterComment("seller", d({ status: "resolved" })), "resolved");
});

// ---- ending it -------------------------------------------------------------

test("only the person who raised it may withdraw it", () => {
  assert.ok(canWithdraw("buyer", d()));
  assert.ok(canWithdraw("buyer", d({ status: "answered" })));
  // the accused withdrawing it would be dismissing the accusation against them
  assert.ok(!canWithdraw("seller", d()));
  assert.ok(!canWithdraw("buyer", d({ status: "resolved" })));
});

test("neither party decides their own dispute", () => {
  assert.ok(!canResolve("buyer", d()), "the raiser cannot rule for themselves");
  assert.ok(!canResolve("seller", d()), "nor can the accused");
  assert.ok(canResolve("staff", d()), "somebody outside it can");
  assert.ok(!canResolve("staff", d({ status: "resolved" })), "and not twice");
});

test("an invented outcome is not an outcome", () => {
  assert.ok(isOutcome("refund-full"));
  assert.ok(!isOutcome("refund-everything"));
});
