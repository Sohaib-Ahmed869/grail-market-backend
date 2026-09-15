import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPublish } from "../src/listings/autopublish.js";

const on = { enabled: true, below: 2500 };
const clean = {
  price: 180, marketValue: 200, catalogId: "base1-4", photoVerified: true,
  graded: true, certNumber: "12345678", sellerStanding: "active", identityApproved: true,
};

test("a clean listing under the value publishes itself", () => {
  assert.deepEqual(autoPublish(clean, on), { publish: true, held: [] });
});

test("at or above the value always waits for a person", () => {
  const r = autoPublish({ ...clean, price: 2500, marketValue: 2600 }, on);
  assert.equal(r.publish, false);
  assert.match(r.held[0], /auto-publish value/);
});

test("switched off, nothing publishes itself — the old behaviour", () => {
  assert.equal(autoPublish(clean, { enabled: false, below: 2500 }).publish, false);
});

test("a price far from market value is held either way", () => {
  assert.match(autoPublish({ ...clean, price: 40, marketValue: 200 }, on).held.join(), /unusually low/);
  assert.match(autoPublish({ ...clean, price: 900, marketValue: 200 }, on).held.join(), /unusually high/);
  assert.match(autoPublish({ ...clean, marketValue: null }, on).held.join(), /No market value/);
});

test("every failed check is listed, so the reviewer knows what to look at", () => {
  const r = autoPublish({
    ...clean, catalogId: null, photoVerified: false, certNumber: null,
    sellerStanding: "restricted", identityApproved: false,
  }, on);
  assert.equal(r.publish, false);
  assert.equal(r.held.length, 5);
});

test("a raw card needs no certificate", () => {
  assert.equal(autoPublish({ ...clean, graded: false, certNumber: null }, on).publish, true);
});
