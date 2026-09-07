import { storePool } from "../cards.store.js";
import { periodOf, quotaFor, type Quota } from "./quota.js";
import { activePlanId } from "../billing/store.js";

// Where the scan count lives.
//
// Postgres rather than the local sqlite `usage` table beside it: that one
// counts what WE spent with each provider, per box, and is thrown away when a
// box is replaced. This counts what a MEMBER used, has to survive a deploy,
// and has to be the same number whichever instance answers.

export const SCAN_QUOTA_SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_usage (
  user_id text NOT NULL,
  period  text NOT NULL,          -- 'YYYY-MM'
  used    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
`;

export async function initScanQuota(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(SCAN_QUOTA_SCHEMA);
}

/** The plan id, but only while the subscription is actually paying.
 *
 *  This was a private copy of the rule; the listings path then grew its own
 *  version WITHOUT the status check, which is precisely the drift a second
 *  copy invites. One implementation now, in billing/store.ts. */
const activePlan = activePlanId;

async function usedThisPeriod(userId: string): Promise<number> {
  const pool = storePool();
  if (!pool) return 0;
  const r = await pool.query(
    "select used from scan_usage where user_id = $1 and period = $2",
    [userId, periodOf()],
  );
  return Number(r.rows[0]?.used ?? 0);
}

export async function scanQuota(userId: string): Promise<Quota> {
  const [plan, used] = await Promise.all([
    activePlan(userId).catch(() => null),
    usedThisPeriod(userId),
  ]);
  return quotaFor(plan, used);
}

/** Count one, and say whether it was allowed.
 *
 *  The increment and the check are one statement: two members on two instances
 *  reading "9 used" at the same moment and both being allowed is exactly the
 *  race a separate read-then-write has, and it is worth nothing to leave open.
 *  A row over the limit is still written — the count is what it is — and `ok`
 *  is decided from the value AFTER the increment. */
export async function chargeScanQuota(
  userId: string,
): Promise<{ ok: boolean; quota: Quota }> {
  const pool = storePool();
  // With no store there is no counting, and refusing every scan because the
  // meter is down is the wrong failure. Let it through.
  if (!pool) return { ok: true, quota: quotaFor(null, 0) };

  const r = await pool.query(
    `insert into scan_usage (user_id, period, used) values ($1, $2, 1)
     on conflict (user_id, period) do update set used = scan_usage.used + 1
     returning used`,
    [userId, periodOf()],
  );
  const used = Number(r.rows[0]?.used ?? 1);
  const plan = await activePlan(userId).catch(() => null);
  // `used` already includes this scan, so the quota is checked against the
  // count before it — the tenth scan of a ten-scan allowance must be allowed.
  const quota = quotaFor(plan, used - 1);
  return { ok: quota.ok, quota: quotaFor(plan, used) };
}
