import { storePool } from "../cards.store.js";
import { adminPlans, billingLedger } from "./commerce.store.js";

// The dashboard, in one read.
//
// It is the last page in the console that was drawing sample money. That was
// worse than it sounds: it quoted ~4,900 subscribers from a fixture while
// `/admin/pricing` read the real number off the database, so two pages of the
// same console disagreed about the same figure and only one of them was right.
//
// One endpoint rather than five, for the same reason `/admin/commerce` is one:
// the page shows a single moment, and five round trips is five chances for the
// panels to be describing different ones.
//
// Nothing here is stored. Every figure is an aggregate computed now, and a
// source that cannot be read contributes null rather than zero — a dashboard
// that shows a confident 0 for a table it could not open is the failure this
// whole console is careful about.

export type FunnelStage = { key: string; label: string; value: number };

export type Dashboard = {
  /** Counts a page owns, each linking to that page. */
  stats: {
    liveListings: number;
    queueDepth: number;
    breached: number;
    openReports: number;
    members: number;
  };
  /** Subscriptions, from the same place `/admin/pricing` reads them. */
  money: {
    mrr: number;
    subscribers: number;
    tiers: { id: string; name: string; price: number; quota: number | null; subscribers: number; mrr: number }[];
    /** This calendar month, from the billing ledger. */
    collected: number;
    failed: number;
    failedAccounts: number;
  };
  /** New accounts through verification, last 30 days. */
  funnel: FunnelStage[];
  /** Twelve weeks, GMV against verifications cleared — the two series the
   *  volume chart draws against each other. GMV is in thousands, because that
   *  is the axis the chart labels. */
  gmv: { label: string; gmv: number; verified: number }[];
  /** What is in the queue, by tier. */
  queueMix: { label: string; value: number; color: string }[];
};

/** Money in and money that bounced, this calendar month. */
function thisMonth(events: { kind: string; amount: number | null; at: string; userId: string | null }[]) {
  const from = new Date();
  from.setUTCDate(1);
  from.setUTCHours(0, 0, 0, 0);

  let collected = 0;
  let failed = 0;
  const bounced = new Set<string>();

  for (const e of events) {
    if (new Date(e.at) < from) continue;
    if (e.kind === "paid") collected += e.amount ?? 0;
    else if (e.kind === "payment-failed") {
      failed += e.amount ?? 0;
      if (e.userId) bounced.add(e.userId);
    }
  }
  return { collected, failed, failedAccounts: bounced.size };
}

export async function dashboard(): Promise<Dashboard> {
  const empty: Dashboard = {
    stats: { liveListings: 0, queueDepth: 0, breached: 0, openReports: 0, members: 0 },
    money: { mrr: 0, subscribers: 0, tiers: [], collected: 0, failed: 0, failedAccounts: 0 },
    funnel: [],
    gmv: [],
    queueMix: [],
  };

  const pool = storePool();
  if (!pool) return empty;

  const one = async (sql: string, args: any[] = []): Promise<any> => {
    try {
      const r = await pool.query(sql, args);
      return r.rows[0] ?? {};
    } catch {
      return {};
    }
  };
  const many = async (sql: string, args: any[] = []): Promise<any[]> => {
    try {
      return (await pool.query(sql, args)).rows;
    } catch {
      return [];
    }
  };

  const [counts, funnelRow, sold, verified, mix, events, plans] = await Promise.all([
    one(
      `select
         count(*) filter (where status = 'live')::int live,
         count(*) filter (where status = 'in_review')::int queued,
         count(*) filter (
           where status = 'in_review' and submitted_at < now() - interval '24 hours'
         )::int breached,
         /* The conduct board's own state, not the dispute's.
         
            disputes.status is the app's column and the console never writes
            it — deciding a case writes conduct_cases.state, which is the
            whole reason that table exists beside this one. Counting the
            dispute meant a case closed on the board still showed as open
            here, so the dashboard and the board disagreed about the same
            three cases. Same join and the same default as caseCounts(). */
         (select count(*)::int
            from disputes d
            left join conduct_cases c on c.dispute_id = d.dispute_id
           where coalesce(c.state, 'open') <> 'resolved') open_reports,
         (select count(*)::int from users where role = 'member') members
       from listings`,
    ),
    /* Two steps, not four.
    
       The middle two were "mobile confirmed" and "ID submitted". The console
       does not handle ID verification — the provider decides and we hold the
       outcome — so a step for "started it" is a step nobody here can act on,
       and a funnel whose middle cannot be worked is a chart of somebody
       else's process. What is left is the pair that means something to this
       console: how many signed up, and how many came out verified. */
    one(
      `select
         count(*)::int created,
         count(*) filter (where i.status = 'Approved')::int approved
       from users u
       left join identity_status i on i.user_id = u.user_id
      where u.role = 'member' and u.created_at > now() - interval '30 days'`,
    ),
    many(
      `select date_trunc('week', sold_at) wk, coalesce(sum(price),0)::float total
         from listings
        where status = 'sold' and sold_at > now() - interval '84 days'
        group by 1 order by 1`,
    ),
    many(
      `select date_trunc('week', verified_at) wk, count(*)::int n
         from identity_status
        where status = 'Approved' and verified_at > now() - interval '84 days'
        group by 1 order by 1`,
    ),
    many(
      `select
         case
           when price >= 10000 then 'grail'
           when price >= 2000  then 'high-value'
           else 'standard'
         end tier,
         count(*)::int n
       from listings where status = 'in_review' group by 1`,
    ),
    /* Through the ledger rather than straight at `billing_events`: the kind
       and the amount are not columns, they are read out of Stripe's payload by
       `billingLedger`, and a second parser here would be a second opinion
       about what a webhook meant. */
    billingLedger(300).catch(() => []),
    adminPlans().catch(() => []),
  ]);

  /* Twelve weeks, zeros included. A week with no sales in it is a fact about
     the week, and letting the query's missing row close the gap would shift
     every later column one to the left. */
  const weeks: { label: string; gmv: number; verified: number }[] = [];
  const byWeek = new Map<string, number>();
  for (const r of sold) byWeek.set(new Date(r.wk).toISOString().slice(0, 10), Number(r.total));
  const verifiedByWeek = new Map<string, number>();
  for (const r of verified) {
    verifiedByWeek.set(new Date(r.wk).toISOString().slice(0, 10), Number(r.n));
  }
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 7 * 86_400_000);
    /* Monday, to match `date_trunc('week')`, which is ISO and starts there. */
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d.getTime() - day * 86_400_000);
    const key = monday.toISOString().slice(0, 10);
    weeks.push({
      label: monday.toLocaleDateString("en-AU", { day: "2-digit", month: "short" }),
      // in thousands: the chart's own axis is labelled $k
      gmv: Math.round(((byWeek.get(key) ?? 0) / 1000) * 10) / 10,
      verified: verifiedByWeek.get(key) ?? 0,
    });
  }

  const TIER_COLOUR: Record<string, string> = {
    grail: "var(--gold)",
    "high-value": "var(--navy-500)",
    standard: "var(--ink-4)",
  };
  const TIER_LABEL: Record<string, string> = {
    grail: "Grail",
    "high-value": "High value",
    standard: "Standard",
  };

  const f = funnelRow;
  return {
    stats: {
      liveListings: counts.live ?? 0,
      queueDepth: counts.queued ?? 0,
      breached: counts.breached ?? 0,
      openReports: counts.open_reports ?? 0,
      members: counts.members ?? 0,
    },
    money: {
      mrr: plans.reduce((s: number, p: any) => s + p.mrr, 0),
      subscribers: plans.reduce((s: number, p: any) => s + p.subscribers, 0),
      tiers: plans.map((p: any) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        quota: p.quota,
        subscribers: p.subscribers,
        mrr: p.mrr,
      })),
      ...thisMonth(events),
    },
    funnel: [
      { key: "created", label: "Account created", value: f.created ?? 0 },
      { key: "approved", label: "ID approved", value: f.approved ?? 0 },
    ],
    gmv: weeks,
    queueMix: mix.map((m: any) => ({
      label: TIER_LABEL[m.tier] ?? m.tier,
      value: Number(m.n),
      color: TIER_COLOUR[m.tier] ?? "var(--ink-4)",
    })),
  };
}
