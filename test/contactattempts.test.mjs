// Contact-sharing attempts, recorded against the account.
//
// Masking a phone number in one message is the easy half. The half Sam asked
// for on 8 September is the record: someone who tries it five times is a
// different member from someone who typed a certificate number that looked
// like one, and the console has to be able to tell them apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFlags, reviewDue, CONTACT_REVIEW_WINDOW_DAYS } from "../src/admin/contact.rules.js";

test("a phone, an email, a link or a number split across messages is a contact attempt", () => {
  for (const f of [["phone"], ["email"], ["link"], ["split-contact"], ["off-platform", "phone"]]) {
    assert.deepEqual(classifyFlags(f), { record: true, contact: true }, f.join(","));
  }
});

test("naming an app or a handle is recorded but is not a contact detail", () => {
  // "find me on insta, same name as here" is flagged, deliberately not masked,
  // and must not push anyone into a review on its own.
  assert.deepEqual(classifyFlags(["off-platform"]), { record: true, contact: false });
  assert.deepEqual(classifyFlags(["handle"]), { record: true, contact: false });
  assert.deepEqual(classifyFlags(["mail-provider"]), { record: true, contact: false });
});

test("a clean message records nothing", () => {
  assert.deepEqual(classifyFlags([]), { record: false, contact: false });
  assert.deepEqual(classifyFlags(null), { record: false, contact: false });
});

test("a review opens when contact attempts reach the limit, and not before", () => {
  assert.equal(reviewDue({ contactAttempts: 2, limit: 3, open: false }), false);
  assert.equal(reviewDue({ contactAttempts: 3, limit: 3, open: false }), true);
});

test("an open review is not opened again on every further attempt", () => {
  assert.equal(reviewDue({ contactAttempts: 9, limit: 3, open: true }), false);
});

test("a limit of zero switches the automatic review off rather than opening one for everyone", () => {
  assert.equal(reviewDue({ contactAttempts: 50, limit: 0, open: false }), false);
});

test("the window is a month", () => {
  assert.equal(CONTACT_REVIEW_WINDOW_DAYS, 30);
});
