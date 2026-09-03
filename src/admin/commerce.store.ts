import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { PLANS, findPlan, priceIdFor, type PlanId } from "../billing/plans.js";

// Subscriptions and boosts, as the console reads them.
//
// Two different kinds of money live on this page and they must not be confused
// with each other or with a trade. A plan is a recurring charge Stripe holds; a
// boost is a one-off charge for putting one listing in front of people. Neither
// is a commission — no money passes through the platform between two members,
// which is why there is no refund tooling anywhere in the console.
//
// The plan half reads tables that already exist (`subscriptions`,
// `billing_events`) rather than keeping a second copy of them. The boost half
// needs a table of its own, because `listings.featured_until` records that a
// listing IS featured and says nothing about whether anybody was charged for
// it — and "paid for and never applied" is precisely the gap between those two
// facts.

/* --------------------------------------------------------------------------
   Boosts
   -------------------------------------------------------------------------- */

export const COMMERCE_SCHEMA = `
-- One purchase of one boost on one listing.
--
-- Kept apart from listings.featured_until on purpose: that column is what the
-- marketplace reads to decide the rail, and this is what the desk reads to
-- decide whether somebody was charged for something they never got. A boost
-- that was paid for is a row here with applied_at still null.
CREATE TABLE IF NOT EXISTS listing_boosts (
  boost_id     text PRIMARY KEY,
  listing_id   text NOT NULL,
  user_id      text NOT NULL,
  -- 'day' | 'week' | 'month'
  tier         text NOT NULL,
  amount_cents integer NOT NULL,
  currency     text NOT NULL DEFAULT 'AUD',
  purchased_at timestamptz NOT NULL DEFAULT now(),
  -- When we actually put it on the rail. Null is the failure state the whole
  -- table exists to make visible.
  applied_at   timestamptz,
  expires_at   timestamptz,
  -- Why it never ran, where the scheduler knows.
  fault        text,
  comped_by    text,
  comped_at    timestamptz,
  comp_reason  text
);
CREATE INDEX IF NOT EXISTS listing_boosts_stuck
  ON listing_boosts (applied_at, purchased_at DESC);
CREATE INDEX IF NOT EXISTS listing_boosts_user ON listing_boosts (user_id, purchased_at DESC);

-- A month given away rather than charged for.
--
-- Not written into "subscriptions": that row is what Stripe says is true, and
-- an agent's goodwill is not something Stripe knows about. Keeping them apart
-- means a comp can never be mistaken for a payment that came in.
CREATE TABLE IF NOT EXISTS plan_comps (
  comp_id    text PRIMARY KEY,
  user_id    text NOT NULL,
  plan_id    text NOT NULL,
  months     integer NOT NULL DEFAULT 1,
  reason     text NOT NULL,
  granted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_comps_user ON plan_comps (user_id, created_at DESC);
`;

export async function initCommerce(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(COMMERCE_SCHEMA);
}

/**
 * The three boost products, from the feature set: A$4 a day, A$12 a featured
 * week, A$35 a featured month.
 *
 * Held here rather than in Stripe because, unlike a plan price, these decide
 * behaviour as well as amount — `days` is how long the listing stays up and
 * `featured` is whether it reaches the rail at all. A number that changes what
 * the software does belongs in the software.
 */
export type BoostTierKey = "day" | "week" | "month";

export type BoostTier = {
  key: BoostTierKey;
  name: string;
  /** AUD cents. */
  amountCents: number;
  days: number;
  /** The featured rail, or only a lift within the listing's own category. */
  featured: boolean;
  detail: string;
};

export const BOOST_TIERS: BoostTier[] = [
  {
    key: "day",
    name: "Daily boost",
    amountCents: 400,
    days: 1,
    featured: false,
    detail: "Lifts one listing within its own category and grade band for 24 hours.",
  },
  {
    key: "week",
    name: "Featured week",
    amountCents: 1200,
    days: 7,
    featured: true,
    detail: "Seven days on the featured rail, plus the category lift.",
  },
  {
    key: "month",
    name: "Featured month",
    amountCents: 3500,
    days: 30,
    featured: true,
    detail: "Thirty days featured. The only tier that survives a listing being edited.",
  },
];

export const boostTier = (k: string) => BOOST_TIERS.find((t) => t.key === k) ?? null;
export const isBoostTier = (k: string): k is BoostTierKey => BOOST_TIERS.some((t) => t.key === k);

/** Where a bought boost actually is. `paid-not-applied` is the one with a
 *  queue of its own — see the schema note. */
export type BoostState = "active" | "scheduled" | "expired" | "paid-not-applied" | "comped";

export type AdminBoost = {
  id: string;
  tier: BoostTierKey;
  tierName: string;
  listingId: string;
  card: string;
  userId: string;
  handle: string;
  name: string;
  /** AUD. */
  amount: number;
  state: BoostState;
  purchased: string;
  appliedAt: string | null;
  expiresAt: string | null;
  /** Hours it has been sitting unapplied. Only meaningful when it is stuck. */
  stuckHours: number | null;
  fault: string | null;
  compedBy: string | null;
  compReason: string | null;
};

function boostStateOf(r: any): BoostState {
  if (r.comped_at) return "comped";
  if (!r.applied_at) return "paid-not-applied";
  const now = Date.now();
  if (new Date(r.applied_at).getTime() > now) return "scheduled";
  if (r.expires_at && new Date(r.expires_at).getTime() > now) return "active";
  return "expired";
}

/** The ledger. Stuck first, because that is the only row with work in it. */
export async function boostLedger(opts: { id?: string; limit?: number } = {}): Promise<AdminBoost[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select b.*, l.card_name, u.name
       from listing_boosts b
       left join listings l on l.listing_id = b.listing_id
       left join users u on u.user_id = b.user_id
      where ($1::text is null or b.boost_id = $1)
      order by (b.applied_at is null and b.comped_at is null) desc, b.purchased_at desc
      limit $2`,
    [opts.id ?? null, Math.min(opts.limit ?? 200, 500)],
  );
  return r.rows.map((x: any) => {
    const state = boostStateOf(x);
    const name = x.name ?? "Unknown member";
    return {
      id: x.boost_id,
      tier: x.tier as BoostTierKey,
      tierName: boostTier(x.tier)?.name ?? x.tier,
      listingId: x.listing_id,
      card: x.card_name ?? "Listing removed",
      userId: x.user_id,
      handle: handleFor(name, x.user_id),
      name,
      amount: Number(x.amount_cents ?? 0) / 100,
      state,
      purchased: iso(x.purchased_at),
      appliedAt: x.applied_at ? iso(x.applied_at) : null,
      expiresAt: x.expires_at ? iso(x.expires_at) : null,
      stuckHours:
        state === "paid-not-applied"
          ? Math.max(0, Math.round((Date.now() - new Date(x.purchased_at).getTime()) / 3_600_000))
          : null,
      fault: x.fault ?? null,
      compedBy: x.comped_by ?? null,
      compReason: x.comp_reason ?? null,
    };
  });
}

export async function adminBoost(id: string): Promise<AdminBoost | null> {
  const [one] = await boostLedger({ id });
  return one ?? null;
}

/**
 * Start a boost that was charged for and never ran, and give back the time.
 *
 * The days it sat unapplied are added on top of the days that were bought, so
 * a member who paid for seven days on the rail gets seven days on the rail.
 * Two writes, and they must agree: the boost row is the receipt, and
 * `listings.featured_until` is what the marketplace actually reads.
 */
export async function applyBoost(
  id: string,
): Promise<{ ok: boolean; daysAdded: number } | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select boost_id, listing_id, tier, purchased_at, applied_at, comped_at from listing_boosts where boost_id = $1",
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.applied_at || row.comped_at) return { ok: false, daysAdded: 0 };

  const t = boostTier(row.tier);
  if (!t) return { ok: false, daysAdded: 0 };
  const lostHours = Math.max(0, (Date.now() - new Date(row.purchased_at).getTime()) / 3_600_000);
  const daysAdded = Math.ceil(lostHours / 24);
  const totalDays = t.days + daysAdded;

  await pool.query(
    `update listing_boosts
        set applied_at = now(), expires_at = now() + ($2 || ' days')::interval
      where boost_id = $1`,
    [id, String(totalDays)],
  );
  // The rail reads the listing, not the receipt. A boost that is "applied" in
  // one table and invisible in the other is the same failure again.
  await pool.query(
    `update listings
        set featured_until = greatest(coalesce(featured_until, now()), now() + ($2 || ' days')::interval)
      where listing_id = $1`,
    [row.listing_id, String(totalDays)],
  );
  return { ok: true, daysAdded };
}

/** Give it away instead. It costs real revenue, so it carries a name. */
export async function compBoost(id: string, by: string, reason: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update listing_boosts
        set comped_by = $2, comped_at = now(), comp_reason = $3
      where boost_id = $1 and comped_at is null`,
    [id, by, reason],
  );
  return (r.rowCount ?? 0) > 0;
}

/** One billing cycle given away, not a standing arrangement. */
export async function compPlan(a: {
  userId: string;
  planId: PlanId;
  months: number;
  reason: string;
  by: string;
}): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const exists = await pool.query("select 1 from users where user_id = $1", [a.userId]);
  if (!exists.rowCount) return false;
  await pool.query(
    `insert into plan_comps (comp_id, user_id, plan_id, months, reason, granted_by)
     values ($1,$2,$3,$4,$5,$6)`,
    [`pc_${randomUUID().slice(0, 12)}`, a.userId, a.planId, Math.max(1, a.months), a.reason, a.by],
  );
  return true;
}

/* --------------------------------------------------------------------------
   Plans
   -------------------------------------------------------------------------- */

export type AdminPlan = {
  id: PlanId;
  name: string;
  blurb: string;
  /** AUD a month, as Stripe is configured to charge. Display only. */
  price: number;
  /** Live listings allowed at once. null = no ceiling. */
  quota: number | null;
  perks: string[];
  /** The Stripe price this plan checks out against. Empty until configured. */
  stripePriceId: string;
  /** The env var holding it, which is what an operator has to go and set. */
  stripePriceEnv: string;
  subscribers: number;
  pastDue: number;
  cancelled: number;
  /** AUD a month from the subscribers who are actually paying. */
  mrr: number;
  /** Months given away on this plan, all time. */
  comped: number;
};

/**
 * The plans, with the headcount behind each.
 *
 * The price is not editable here and there is no "publish to Stripe" button,
 * deliberately. Stripe holds the amount that is charged; a figure typed into
 * this console as well would be a second copy of it, and the first time
 * anybody changed one the console would be quoting a price nobody is paying.
 * What the console answers is the question Stripe cannot: how many people are
 * on each plan and what that is worth.
 */
export async function adminPlans(): Promise<AdminPlan[]> {
  const pool = storePool();
  const counts = new Map<string, { active: number; pastDue: number; cancelled: number }>();
  const comps = new Map<string, number>();

  if (pool) {
    const r = await pool.query(
      `select plan_id, status, count(*)::int n from subscriptions group by 1, 2`,
    );
    for (const row of r.rows) {
      const k = String(row.plan_id ?? "");
      const c = counts.get(k) ?? { active: 0, pastDue: 0, cancelled: 0 };
      const n = Number(row.n);
      // Stripe's own vocabulary, collapsed to the three states an operator
      // acts on. `trialing` counts as active because the seat is occupied.
      if (row.status === "active" || row.status === "trialing") c.active += n;
      else if (row.status === "past_due" || row.status === "unpaid") c.pastDue += n;
      else c.cancelled += n;
      counts.set(k, c);
    }
    const c = await pool.query(`select plan_id, coalesce(sum(months), 0)::int n from plan_comps group by 1`);
    for (const row of c.rows) comps.set(String(row.plan_id), Number(row.n));
  }

  return PLANS.map((p) => {
    const c = counts.get(p.id) ?? { active: 0, pastDue: 0, cancelled: 0 };
    const price = p.amountCents / 100;
    return {
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      price,
      quota: p.listings,
      perks: p.perks,
      stripePriceId: priceIdFor(p),
      stripePriceEnv: p.priceEnv,
      subscribers: c.active,
      pastDue: c.pastDue,
      cancelled: c.cancelled,
      mrr: price * c.active,
      comped: comps.get(p.id) ?? 0,
    };
  });
}

export const planExists = (id: string): id is PlanId => Boolean(findPlan(id));

/* --------------------------------------------------------------------------
   Billing events

   `billing_events` is every webhook Stripe has ever sent us, which is far more
   than a person needs: a single successful subscription writes fourteen rows,
   twelve of which are Stripe talking to itself. What is kept below is the set
   an operator can act on, in words rather than in event types.
   -------------------------------------------------------------------------- */

export type BillingEventKind =
  | "subscribed"
  | "paid"
  | "payment-failed"
  | "cancelled"
  | "plan-changed"
  | "abandoned"
  | "refunded";

/** Stripe's event type → what it means to the desk. Anything not on this list
 *  is machinery and is not shown. */
const EVENT_KINDS: Record<string, BillingEventKind> = {
  "checkout.session.completed": "subscribed",
  "customer.subscription.created": "subscribed",
  "customer.subscription.updated": "plan-changed",
  "customer.subscription.deleted": "cancelled",
  "invoice.paid": "paid",
  "invoice.payment_succeeded": "paid",
  "invoice.payment_failed": "payment-failed",
  "invoice.payment_action_required": "payment-failed",
  "charge.failed": "payment-failed",
  "charge.refunded": "refunded",
  "checkout.session.expired": "abandoned",
};

export type AdminBillingEvent = {
  id: string;
  kind: BillingEventKind;
  /** Stripe's own type, for anyone who has to go and look it up. */
  type: string;
  userId: string | null;
  handle: string;
  name: string;
  planId: string | null;
  /** AUD, or null where the event carries no amount. */
  amount: number | null;
  at: string;
  /** Stripe's decline reason, where it gave one. */
  reason: string | null;
};

/** Dig a user id out of wherever this particular event shape hides it. */
function userIdIn(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.metadata?.user_id ??
    payload.client_reference_id ??
    payload.parent?.subscription_details?.metadata?.user_id ??
    payload.lines?.data?.[0]?.metadata?.user_id ??
    payload.subscription_details?.metadata?.user_id ??
    null
  );
}

function planIdIn(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.metadata?.plan_id ??
    payload.parent?.subscription_details?.metadata?.plan_id ??
    payload.lines?.data?.[0]?.metadata?.plan_id ??
    null
  );
}

function amountIn(payload: any): number | null {
  if (!payload || typeof payload !== "object") return null;
  const cents =
    payload.amount_paid ?? payload.amount_total ?? payload.amount_due ?? payload.amount ?? null;
  return typeof cents === "number" ? cents / 100 : null;
}

export async function billingLedger(limit = 60): Promise<AdminBillingEvent[]> {
  const pool = storePool();
  if (!pool) return [];
  const types = Object.keys(EVENT_KINDS);
  const r = await pool.query(
    `select event_id, user_id, type, payload, received_at
       from billing_events
      where type = any($1)
      order by received_at desc
      limit $2`,
    [types, Math.min(limit, 300)],
  );

  const rows = r.rows.map((x: any) => ({
    id: x.event_id,
    kind: EVENT_KINDS[x.type],
    type: x.type as string,
    userId: (x.user_id ?? userIdIn(x.payload)) as string | null,
    planId: planIdIn(x.payload),
    amount: amountIn(x.payload),
    at: iso(x.received_at),
    reason:
      (x.payload?.last_payment_error?.message ??
        x.payload?.failure_message ??
        x.payload?.outcome?.seller_message ??
        null) as string | null,
  }));

  // One lookup for every name on the page rather than one per row.
  const ids = [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (ids.length) {
    const u = await pool.query("select user_id, name from users where user_id = any($1)", [ids]);
    for (const row of u.rows) names.set(row.user_id, row.name);
  }

  return rows.map((r) => {
    const name = r.userId ? names.get(r.userId) ?? "Unknown member" : "Unknown member";
    return {
      ...r,
      name,
      handle: r.userId ? handleFor(name, r.userId) : "—",
    };
  });
}

/* --------------------------------------------------------------------------
   Shared shaping
   -------------------------------------------------------------------------- */

function handleFor(name: string, id: string): string {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `@${slug}` : `@${id}`;
}

const iso = (d: any) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
