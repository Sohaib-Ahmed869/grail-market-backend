// A rating is a claim about a trade that happened. Every rule here exists to
// stop it being a claim about nothing: you cannot rate a stranger, cannot
// rate a deal that never completed, cannot rate twice, and cannot rate
// yourself. Without those, the star count is decoration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canRate } from "../src/ratings/rules.js";

const deal = (o = {}) => ({
  listingStatus: "sold",
  sellerId: "u_seller",
  buyerId: "u_buyer",
  offerStatus: "accepted",
  already: false,
  ...o,
});

test("both sides of a completed deal may rate each other", () => {
  assert.equal(canRate("u_buyer", deal()).ok, true);
  assert.equal(canRate("u_seller", deal()).ok, true);
});

test("a bystander may not", () => {
  const r = canRate("u_someone_else", deal());
  assert.equal(r.ok, false);
  assert.equal(r.why, "not-party");
});

test("no rating before the card has changed hands", () => {
  assert.equal(canRate("u_buyer", deal({ listingStatus: "live" })).why, "not-complete");
  assert.equal(canRate("u_buyer", deal({ offerStatus: "open" })).why, "not-complete");
  assert.equal(canRate("u_buyer", deal({ offerStatus: "declined" })).why, "not-complete");
});

test("once each, not once per mood", () => {
  assert.equal(canRate("u_buyer", deal({ already: true })).why, "already-rated");
});

test("nobody rates themselves", () => {
  // a seller who also somehow holds the buyer id on the same deal
  assert.equal(canRate("u_same", deal({ sellerId: "u_same", buyerId: "u_same" })).why, "self");
});

test("the counterparty is whoever you are not", () => {
  assert.equal(canRate("u_buyer", deal()).counterparty, "u_seller");
  assert.equal(canRate("u_seller", deal()).counterparty, "u_buyer");
});

test("stars are one to five, whole numbers", () => {
  const { validStars } = canRate("u_buyer", deal());
  assert.equal(validStars(0), false);
  assert.equal(validStars(6), false);
  assert.equal(validStars(3.5), false);
  assert.equal(validStars(1), true);
  assert.equal(validStars(5), true);
});
