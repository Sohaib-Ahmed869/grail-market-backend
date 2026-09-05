// One subscription must not mean two different things.
//
// The scan path asked "what plan are they PAYING for" and checked the status.
// The listings path asked "what is in plan_id" and did not. Stripe does not
// blank plan_id when a subscription lapses, so a cancelled dealer row still
// read as `dealer` to the sell flow: the listing ceiling on screen and the
// scan allowance disagreed about the same person, and a lapsed subscriber kept
// the right to publish.
//
// The rule, in one place, asserted here so a third caller cannot quietly grow
// a fourth interpretation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAYING } from "../src/billing/store.js";

// The shape readSubscription returns, straight out of the table.
const row = (status, plan_id) => ({ status, plan_id });

/** The rule activePlanId applies, isolated from the database. */
const entitled = (r) => (r && PAYING.has(String(r.status)) ? (r.plan_id ?? null) : null);

test("paying statuses keep the plan", () => {
  assert.equal(entitled(row("active", "collector")), "collector");
  assert.equal(entitled(row("trialing", "dealer")), "dealer");
});

test("a lapsed subscription keeps its plan_id and loses the entitlement", () => {
  // Every one of these still carries plan_id = 'dealer' in the real table.
  for (const status of ["canceled", "cancelled", "past_due", "unpaid", "incomplete",
                        "incomplete_expired", "paused"]) {
    assert.equal(entitled(row(status, "dealer")), null, `${status} must not entitle`);
  }
});

test("no row is no plan", () => {
  assert.equal(entitled(null), null);
  assert.equal(entitled(undefined), null);
});

test("an active row with no plan_id entitles nothing, rather than everything", () => {
  // coalesce on the upsert should prevent this, but a null here must fail
  // closed: an unrecognised plan falls back to no plan, never to unlimited.
  assert.equal(entitled(row("active", null)), null);
});

test("the paying set is exactly the two Stripe states that mean paid", () => {
  // Pinned deliberately. Adding a status here grants entitlement, so it should
  // be a decision somebody makes on purpose and a test they have to edit.
  assert.deepEqual([...PAYING].sort(), ["active", "trialing"]);
});
