import { storePool } from "../cards.store.js";
import type { PlanId } from "./plans.js";

// What a member is entitled to, and how that came to be.
//
// Same split as identity, for the same reason: one row that answers "what can
// this person do right now", and an append-only log of what Stripe told us.
// The log is what you read when somebody says they were charged twice.

export const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id        text PRIMARY KEY,
  plan_id        text,
  status         text NOT NULL,
  stripe_sub_id  text,
  current_period_end timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_events (
  event_id   text PRIMARY KEY,
  user_id    text,
  type       text NOT NULL,
  payload    jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_events_user ON billing_events (user_id, received_at DESC);
`;

export async function initBilling(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(BILLING_SCHEMA);
}

export async function alreadySeen(eventId: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query("select 1 from billing_events where event_id = $1", [eventId]);
  return (r.rowCount ?? 0) > 0;
}

export async function recordEvent(e: {
  eventId: string; userId: string | null; type: string; payload: unknown;
}): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `insert into billing_events (event_id, user_id, type, payload)
     values ($1,$2,$3,$4) on conflict (event_id) do nothing`,
    [e.eventId, e.userId, e.type, e.payload ? JSON.stringify(e.payload) : null],
  );
}

export async function applySubscription(s: {
  userId: string; planId: PlanId | null; status: string;
  stripeSubId: string | null; periodEnd: Date | null;
}): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `insert into subscriptions (user_id, plan_id, status, stripe_sub_id, current_period_end, updated_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (user_id) do update set
       plan_id = coalesce(excluded.plan_id, subscriptions.plan_id),
       status = excluded.status,
       stripe_sub_id = coalesce(excluded.stripe_sub_id, subscriptions.stripe_sub_id),
       current_period_end = coalesce(excluded.current_period_end, subscriptions.current_period_end),
       updated_at = now()`,
    [s.userId, s.planId, s.status, s.stripeSubId, s.periodEnd],
  );
}

/** The statuses under which a subscription is actually paying.
 *
 *  A cancelled or past_due row keeps its plan_id — Stripe does not blank it —
 *  so reading plan_id without the status is how somebody keeps a paid
 *  entitlement after they stop paying for it. This lived privately in
 *  scanquota.store.ts and the listings path grew its own check without it,
 *  which is exactly how two answers to one question appear.
 */
export const PAYING = new Set(["active", "trialing"]);

/** The plan a member is actually entitled to right now, or null.
 *
 *  The single answer to "what are they paying for". Every entitlement gate
 *  goes through it so a scan and a listing cannot disagree about the same
 *  subscription. */
export async function activePlanId(userId: string): Promise<string | null> {
  const sub = await readSubscription(userId);
  if (!sub) return null;
  return PAYING.has(String(sub.status)) ? (sub.plan_id ?? null) : null;
}

export async function readSubscription(userId: string) {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select user_id, plan_id, status, current_period_end from subscriptions where user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}
