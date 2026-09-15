import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { publicListing } from "../src/listings/publicshape.js";

// A row as `select * from listings` returns it, including the review workflow
// columns the admin console writes. Read off the live API on 14 Sep 2026,
// where every one of these reached an anonymous caller.
const row = {
  listing_id: "l_1", seller_id: "u_1", catalog_id: "base1-4", card_name: "Charizard",
  set_name: "Base Set", card_number: "4", game: "pokemon", image_url: null,
  grader: "PSA", grade: "8", cert_number: "12345678", is_raw: false,
  condition_note: "Clean", price: "5200", currency: "AUD", market_value: "5000",
  strategy: "patient", delivery: ["Post — tracked"], suburb: "Sydney", status: "live",
  photos: [], video_url: null, photo_verified: true, featured_until: null,
  created_at: "2026-09-10", live_at: "2026-09-10", sold_at: null, variant: null,
  label_grade: null, language: null, edition: null, finish: null,
  views: 40, saves: 3, reject_reason: null,
  submitted_at: "2026-09-10", claimed_by: "staff_7", claimed_at: "2026-09-10",
  reviewed_by: "staff_7", reviewed_at: "2026-09-10", moderator_flags: ["price-high"],
  moderator_note: "Seller has two strikes", info_requested_at: null,
  some_future_column: "private",
};

test("moderation, review and seller-private fields never reach the public", () => {
  const p = publicListing(row);
  for (const k of ["moderator_note", "moderator_flags", "claimed_by", "claimed_at", "reviewed_by",
    "reviewed_at", "submitted_at", "info_requested_at", "strategy", "views", "saves", "reject_reason"]) {
    assert.ok(!(k in p), `${k} must not be public`);
  }
});

test("an unknown new column is private until someone decides otherwise", () => {
  assert.ok(!("some_future_column" in publicListing(row)));
});

test("what a buyer needs is kept, and featured is derived", () => {
  const p = publicListing(row);
  for (const k of ["listing_id", "seller_id", "card_name", "set_name", "card_number", "grader", "grade",
    "cert_number", "is_raw", "condition_note", "price", "currency", "market_value", "delivery", "suburb",
    "photos", "photo_verified", "live_at"]) {
    assert.ok(k in p, `${k} should be public`);
  }
  assert.equal(p.featured, false);
});
