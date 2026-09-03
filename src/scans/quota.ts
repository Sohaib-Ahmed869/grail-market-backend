// How many scans a member gets, and how many are left.
//
// Pure, so the month boundary and the ceilings can be pinned by fixtures. The
// arithmetic is trivial; the part worth testing is what happens at the edges —
// the day the month rolls, an unknown plan, and the difference between "you
// have none left" and "you have no ceiling".

export type PlanId = "starter" | "collector" | "dealer";

/** Scans a month. `null` means no ceiling.
 *
 *  Free browsing has a small allowance rather than none: somebody has to be
 *  able to try the thing that makes this app worth paying for, and a wall on
 *  the first scan is a wall in front of the demo. */
export const SCAN_LIMITS: Record<"free" | PlanId, number | null> = {
  free: 10,
  starter: 100,
  collector: 500,
  dealer: null,
};

export type Quota = {
  plan: "free" | PlanId;
  used: number;
  /** null when the plan has no ceiling */
  limit: number | null;
  /** null when there is no ceiling to be remaining against */
  remaining: number | null;
  resetsOn: string;
  ok: boolean;
};

/** The billing period key: a scan in March counts against March.
 *
 *  Calendar months rather than a rolling window keyed to the signup date —
 *  "resets on the 1st" is a sentence anyone can act on, and a rolling window
 *  means the answer to "when do I get more" is a different date per member. */
export const periodOf = (now: Date | number = new Date()): string =>
  new Date(now).toISOString().slice(0, 7);

/** The first day of the next month, in the same UTC frame as periodOf. */
export function resetsOn(now: Date | number = new Date()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

export function quotaFor(
  planId: string | null | undefined,
  used: number,
  now: Date | number = new Date(),
): Quota {
  // An unrecognised plan id falls back to free rather than to unlimited. A
  // typo in a database column must not become a way to scan for nothing.
  const plan = (planId && planId in SCAN_LIMITS ? planId : "free") as "free" | PlanId;
  const limit = SCAN_LIMITS[plan];
  const spent = Math.max(0, Math.floor(used) || 0);
  return {
    plan,
    used: spent,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - spent),
    resetsOn: resetsOn(now),
    ok: limit == null || spent < limit,
  };
}
