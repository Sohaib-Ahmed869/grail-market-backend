import { FREE_PLAN, findPlan, type Plan } from "./plans.js";

// Who may put a card up, and how many at once.
//
// One function for the sell flow and the "3 of 25 active" line above a
// seller's listings, so the ceiling shown is the ceiling enforced. The paying
// half is decided before this is called — `activePlanId` reads the
// subscription and its status — so this only has to answer what that plan,
// or the lack of one, allows.

export type Entitlement = { plan: Plan | null };

/** A paid plan wins. With none, a verified seller gets the free listing; an
 *  unverified one gets nothing. An unrecognised plan id is treated as no plan,
 *  so a bad row fails closed rather than open. */
export function entitlementFor(a: { paidPlanId: string | null; identityApproved: boolean }): Entitlement {
  const paid = a.paidPlanId ? findPlan(a.paidPlanId) : null;
  if (paid && !paid.free) return { plan: paid };
  return { plan: a.identityApproved ? FREE_PLAN : null };
}

export type CreateCheck =
  | { ok: true }
  | { ok: false; error: "no-plan" | "quota"; message: string };

/** `active` is the seller's listings currently live or in review — a closed
 *  listing is not counted, which is what makes the free slot reusable. */
export function canCreateListing(e: Entitlement, active: number): CreateCheck {
  if (!e.plan) {
    return {
      ok: false, error: "no-plan",
      message: "Verify your identity to list one card free, or choose a plan to list more.",
    };
  }
  const limit = e.plan.listings;
  if (limit != null && active >= limit) {
    return {
      ok: false, error: "quota",
      message: e.plan.free
        ? "Your free listing is in use. It frees up when that listing closes — or choose a plan to list more."
        : `${e.plan.name} allows ${limit} active listing${limit === 1 ? "" : "s"}. Upgrade to list more.`,
    };
  }
  return { ok: true };
}
