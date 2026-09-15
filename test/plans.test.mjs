// The pricing the client confirmed, and who may list under it.
//
// GrailMarket's pricing brief of 1 September, restated on the ticket
// (GM001-32): one free active listing per VERIFIED seller, Collector at
// A$19.99 a month or A$199.99 a year with 25 active listings, Dealer at
// A$69.99 a month or A$699.99 a year, unlimited under a Fair Use Policy.
// Extra listing A$5.99. Priority Boost A$4.99 / 48h, Featured A$9.99 / 7d,
// Spotlight A$19.99 / 7d. No commission, no free trial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANS, PAID_PLANS, PRICING, findPlan } from "../src/billing/plans.js";
import { entitlementFor, canCreateListing } from "../src/billing/entitlement.js";
import { BOOST_TIERS, boostTier, isBoostTier } from "../src/admin/commerce.store.js";

test("the offered plans are Free, Collector and Dealer, at the confirmed prices", () => {
  assert.deepEqual(PLANS.map((p) => p.id), ["free", "collector", "dealer"]);
  const collector = findPlan("collector");
  assert.equal(collector.amountCents, 1999);
  assert.equal(collector.annualCents, 19999);
  assert.equal(collector.listings, 25);
  const dealer = findPlan("dealer");
  assert.equal(dealer.amountCents, 6999);
  assert.equal(dealer.annualCents, 69999);
  assert.equal(dealer.listings, null);
  assert.equal(dealer.fairUse, true);
  assert.match(dealer.perks.join(" "), /Fair Use/i);
  assert.equal(findPlan("free").amountCents, 0);
  assert.equal(findPlan("free").listings, 1);
  assert.deepEqual(PAID_PLANS.map((p) => p.id), ["collector", "dealer"]);
  assert.equal(PRICING.extraListingCents, 599);
});

test("a verified seller with no subscription gets the free listing", () => {
  const e = entitlementFor({ paidPlanId: null, identityApproved: true });
  assert.equal(e.plan?.id, "free");
  assert.equal(canCreateListing(e, 0).ok, true);
  // One active at a time, reusable when it closes: the second is refused, and
  // with the first closed (liveCount back to 0) it is allowed again.
  const second = canCreateListing(e, 1);
  assert.equal(second.ok, false);
  assert.equal(second.error, "quota");
});

test("an unverified seller with no subscription is refused, with both ways forward", () => {
  const e = entitlementFor({ paidPlanId: null, identityApproved: false });
  assert.equal(e.plan, null);
  const r = canCreateListing(e, 0);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-plan");
  assert.match(r.message, /verify/i);
  assert.match(r.message, /plan/i);
});

test("Collector allows 25, Dealer has no ceiling, whether or not identity is verified", () => {
  const c = entitlementFor({ paidPlanId: "collector", identityApproved: false });
  assert.equal(canCreateListing(c, 24).ok, true);
  assert.equal(canCreateListing(c, 25).ok, false);
  const d = entitlementFor({ paidPlanId: "dealer", identityApproved: true });
  assert.equal(canCreateListing(d, 5000).ok, true);
});

test("a legacy Starter row still resolves rather than breaking entitlement", () => {
  const s = findPlan("starter");
  assert.ok(s, "starter must still resolve");
  assert.equal(s.legacy, true);
  assert.ok(!PLANS.some((p) => p.id === "starter"), "starter must not be offered");
  const e = entitlementFor({ paidPlanId: "starter", identityApproved: false });
  assert.equal(e.plan?.id, "starter");
  assert.equal(canCreateListing(e, 0).ok, true);
});

test("an unrecognised plan id falls back to free-if-verified, never to unlimited", () => {
  assert.equal(entitlementFor({ paidPlanId: "platinum", identityApproved: false }).plan, null);
  assert.equal(entitlementFor({ paidPlanId: "platinum", identityApproved: true }).plan?.id, "free");
});

test("the boosts offered are Priority, Featured and Spotlight at the confirmed prices", () => {
  const byKey = Object.fromEntries(BOOST_TIERS.map((t) => [t.key, t]));
  assert.deepEqual(Object.keys(byKey), ["priority", "featured", "spotlight"]);
  assert.equal(byKey.priority.amountCents, 499);
  assert.equal(byKey.priority.hours, 48);
  assert.equal(byKey.priority.featured, false);
  assert.equal(byKey.featured.amountCents, 999);
  assert.equal(byKey.featured.days, 7);
  assert.equal(byKey.featured.featured, true);
  assert.equal(byKey.spotlight.amountCents, 1999);
  assert.equal(byKey.spotlight.days, 7);
  assert.equal(byKey.spotlight.featured, true);
});

test("an old boost bought as 'week' still resolves, but is not offered", () => {
  const week = boostTier("week");
  assert.ok(week, "legacy tier must resolve for display and apply");
  assert.equal(week.days, 7);
  assert.equal(week.legacy, true);
  assert.equal(isBoostTier("week"), false);
  assert.equal(isBoostTier("spotlight"), true);
});
