import { storePool } from "../cards.store.js";

// The reporting surface.
//
// Every figure on `/admin/reports` is an aggregate over tables another module
// owns — `listings`, `disputes`, `conduct_cases`, `users`, `support_tickets`.
// There is no reports table and there should not be one: a stored copy of a
// count is a number that goes stale the moment anything writes, and the whole
// point of this page is to be checkable against the queues it summarises.
//
// Nothing here writes. If a figure cannot be computed from what the store
// actually holds, this file returns null for it and the console says so —
// see `available` on every series. Printing a plausible zero where a source is
// missing is the failure this page exists to catch.

/* --------------------------------------------------------------------------
   The period
   -------------------------------------------------------------------------- */

/** The four the console offers. `days` is what every query bounds on. */
export const PERIODS: Record<string, { label: string; days: number }> = {
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  quarter: { label: "This quarter", days: 90 },
  ytd: { label: "Year to date", days: 365 },
};

export const isPeriod = (p: string) => Object.hasOwn(PERIODS, p);

/** How many buckets a trend is drawn in, and how wide each one is.
 *
 *  Twelve either way, because the chart is twelve columns wide whatever the
 *  period — a 7-day period drawn in weekly buckets would be one column with
 *  eleven gaps beside it. Short periods bucket by day, long ones by week. */
export function bucketing(days: number): { unit: "day" | "week"; step: number; count: number } {
  if (days <= 14) return { unit: "day", step: 1, count: Math.min(12, days) };
  const count = Math.min(12, Math.ceil(days / 7));
  /* Twelve seven-day buckets are 84 days, and a 90-day period drawn in them
     silently loses its first week — every column still holds a plausible
     number, so there is nothing on screen to notice. The step widens to cover
     the period instead. */
  const step = Math.max(7, Math.ceil(days / count));
  return { unit: "week", step, count };
}

/* --------------------------------------------------------------------------
   Types
   -------------------------------------------------------------------------- */

/** One report in the catalogue, with its own series attached.
 *
 *  `available` is the honest half. A report whose source is not wired yet
 *  keeps its row — the catalogue is a statement of what is reported on, not of
 *  what happens to be queryable this week — but it carries no numbers, and the
 *  console draws it as unavailable rather than as a flat line at zero. */
export type ReportSeries = {
  id: string;
  name: string;
  detail: string;
  cadence: string;
  category: "Marketplace" | "Moderation" | "Trust and safety" | "Members";
  chart: "Area chart" | "Line chart" | "Column chart" | "Table";
  unit: "k" | "n" | "%";
  format: string;
  available: boolean;
  /** Why not, when not. Shown on the panel in place of the chart. */
  unavailable?: string;
  headline: string;
  headlineLabel: string;
  labels: string[];
  trend: number[];
};

export type ReportsPayload = {
  period: { key: string; label: string; days: number; from: string; to: string };
  kpis: {
    key: string;
    label: string;
    value: string;
    delta: { dir: "up" | "down" | "flat"; text: string } | null;
    foot: string;
    tone?: "navy" | "gold";
  }[];
  gameSplit: { label: string; value: number; amount: string }[];
  decisionSplit: { label: string; value: number; color: string }[];
  conflictOutcomes: { label: string; value: number }[];
  throughput: {
    onTime: number | null;
    medianLabel: string;
    breached: number;
    decided: number;
  };
  reports: ReportSeries[];
};

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});

const money = (n: number) => AUD.format(Math.round(n));
const count = (n: number) => n.toLocaleString("en-AU");

/** A duration in hours, as the console prints it. */
export function hoursLabel(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return mins ? `${whole}h ${mins}m` : `${whole}h`;
}

/** Movement between this period and the one before it, as a percentage.
 *
 *  Growing from nothing has no percentage — it is not "infinite per cent
 *  up", it is a first period, and saying so is more use than a number that
 *  cannot be compared to the next one. */
export function delta(now: number, before: number): { dir: "up" | "down" | "flat"; text: string } | null {
  if (before === 0) return null;
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 0.5) return { dir: "flat", text: `${Math.abs(pct).toFixed(1)}%` };
  return { dir: pct > 0 ? "up" : "down", text: `${Math.abs(pct).toFixed(1)}%` };
}

/**
 * The bucket boundaries a series is drawn against.
 *
 * Built in JavaScript rather than with `generate_series` so an empty bucket is
 * a zero in the right place instead of a missing row the chart silently closes
 * up. A week with no sales in it is a fact about the week.
 */
export function buckets(days: number): { starts: Date[]; labels: string[]; step: number } {
  const { unit, step, count: n } = bucketing(days);
  const now = new Date();
  const starts: Date[] = [];
  const labels: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(now.getTime() - (i + 1) * step * 86_400_000);
    starts.push(start);
    labels.push(
      unit === "day"
        ? start.toLocaleDateString("en-AU", { day: "2-digit", month: "short" })
        : `W${n - i}`,
    );
  }
  return { starts, labels, step };
}

/**
 * Fold dated rows into those buckets.
 *
 * One pass over the rows rather than one query per bucket: twelve round trips
 * for a twelve-column chart is twelve chances for the columns to be measured
 * against different moments, and the last one would always be the shortest
 * because time moved while the first eleven ran.
 */
export function fold(
  rows: { at: string | Date; value: number }[],
  starts: Date[],
  step: number,
): number[] {
  const out = new Array(starts.length).fill(0);
  const first = starts[0]?.getTime() ?? 0;
  const width = step * 86_400_000;
  for (const r of rows) {
    const t = new Date(r.at).getTime();
    const i = Math.floor((t - first) / width);
    if (i >= 0 && i < out.length) out[i] += r.value;
  }
  return out;
}

/** A cumulative series — a running total rather than a per-bucket count. What
 *  "active members" means, as against "members who joined this week". */
export function running(base: number, per: number[]): number[] {
  let n = base;
  return per.map((v) => (n += v));
}

/* --------------------------------------------------------------------------
   The one read

   Everything the page draws, in one round trip's worth of parallel queries.
   The page has four panels, a catalogue of eight and a KPI row; fetching them
   separately is how two panels end up reporting different periods because a
   day rolled over between two requests.
   -------------------------------------------------------------------------- */

export async function reportsFor(periodKey: string): Promise<ReportsPayload> {
  const period = PERIODS[periodKey] ?? PERIODS["30d"];
  const key = isPeriod(periodKey) ? periodKey : "30d";
  const days = period.days;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  /* The same span again, immediately before, which is what every delta on the
     page is measured against. "18% up" with nothing said about since when is
     not a figure anybody can check. */
  const prevFrom = new Date(from.getTime() - days * 86_400_000);

  const { starts, labels, step } = buckets(days);
  const seriesFrom = starts[0] ?? from;

  const empty = blank(key, period.label, days, from, to, labels);

  const pool = storePool();
  if (!pool) return empty;

  const q = <T = any>(sql: string, args: any[] = []) =>
    pool.query(sql, args).then(
      (r) => r.rows as T[],
      /* One unreadable table must not blank the whole page. The panel it feeds
         goes unavailable and everything else still answers. */
      () => null,
    );

  const [
    decided,
    decidedPrev,
    sold,
    soldPrev,
    gameRows,
    outcomeRows,
    timing,
    disputeCount,
    memberRows,
    memberBase,
    lowConfidence,
    sellerRows,
    actionRows,
    ticketRows,
  ] = await Promise.all([
    /* Every listing decided in the period, by what it was decided to. The
       decision is `reviewed_at` and not `live_at`: a listing can go live, be
       paused and go live again, and the review happened once. */
    q(
      `select status, reviewed_by, reviewed_at at time zone 'utc' as at
         from listings
        where reviewed_at >= $1 and reviewed_at < $2`,
      [from, to],
    ),
    q(
      `select count(*)::int n
         from listings
        where reviewed_at >= $1 and reviewed_at < $2
          and status in ('live','sold')`,
      [prevFrom, from],
    ),
    /* GMV. Sold listings only, at the price on the row — there is no
       commission in this model, so gross merchandise value is the whole of
       what changed hands and there is no take rate to net off it. */
    q(
      `select coalesce(game,'unknown') game, price::float price,
              sold_at at time zone 'utc' as at, seller_id
         from listings
        where status = 'sold' and sold_at >= $1 and sold_at < $2`,
      [seriesFrom < from ? seriesFrom : from, to],
    ),
    q(
      `select coalesce(sum(price),0)::float total
         from listings
        where status = 'sold' and sold_at >= $1 and sold_at < $2`,
      [prevFrom, from],
    ),
    q(
      `select coalesce(game,'unknown') game, count(*)::int n,
              coalesce(sum(price),0)::float total
         from listings
        where status = 'sold' and sold_at >= $1 and sold_at < $2
        group by 1 order by 3 desc`,
      [from, to],
    ),
    /* Conduct decisions. `conduct_cases` is ours; `disputes` is the app's, and
       the outcome that matters here is the one a moderator recorded. */
    q(
      `select coalesce(outcome,'none') outcome, count(*)::int n,
              decided_at at time zone 'utc' as at
         from conduct_cases
        where decided_at >= $1 and decided_at < $2
        group by 1, 3`,
      [seriesFrom < from ? seriesFrom : from, to],
    ),
    /* Time to decision, and how much of it landed inside the target. Measured
       from `submitted_at` — when it entered the queue — never `created_at`,
       for the reason the listings migration gives. */
    q(
      `select
         percentile_cont(0.5) within group (
           order by extract(epoch from (reviewed_at - submitted_at)) / 3600
         )::float median_hours,
         count(*) filter (
           where reviewed_at - submitted_at <= interval '24 hours'
         )::int on_time,
         count(*)::int decided
       from listings
      where reviewed_at >= $1 and reviewed_at < $2 and submitted_at is not null`,
      [from, to],
    ),
    q(
      `select count(*)::int n from disputes where created_at >= $1 and created_at < $2`,
      [from, to],
    ),
    q(
      `select created_at at time zone 'utc' as at from users
        where created_at >= $1 and created_at < $2`,
      [seriesFrom < from ? seriesFrom : from, to],
    ),
    q(`select count(*)::int n from users where created_at < $1`, [
      seriesFrom < from ? seriesFrom : from,
    ]),
    /* Listings that went live on a figure built from too few sales. The
       threshold is the same four the outlier test needs — below it there is no
       spread to measure and the figure is a guess with a number on it. */
    q(
      `select l.reviewed_at at time zone 'utc' as at
         from listings l
         left join lateral (
           select count(*)::int n from sales_ledger sl
            where l.catalog_id is not null
              and sl.catalog_id = l.catalog_id
              and sl.grader is not distinct from l.grader
              and sl.grade  is not distinct from l.grade
         ) c on true
        where l.status in ('live','sold')
          and l.reviewed_at >= $1 and l.reviewed_at < $2
          and coalesce(c.n, 0) < 4`,
      [seriesFrom < from ? seriesFrom : from, to],
    ),
    /* Seller concentration: the largest single seller's share of the period's
       GMV, which is the figure the report is named for. */
    q(
      `select seller_id, coalesce(sum(price),0)::float total
         from listings
        where status = 'sold' and sold_at >= $1 and sold_at < $2
        group by 1 order by 2 desc limit 1`,
      [from, to],
    ),
    /* The audit log this console does not have a table for, assembled from the
       actions that did leave a mark: a listing decided, a case decided, a
       member's standing changed. It is a count of admin actions, and it is
       named as an approximation on the panel rather than as a log. */
    q(
      `select at from (
         select reviewed_at at time zone 'utc' as at from listings
          where reviewed_at >= $1 and reviewed_at < $2
         union all
         select decided_at at time zone 'utc' as at from conduct_cases
          where decided_at >= $1 and decided_at < $2
       ) a`,
      [seriesFrom < from ? seriesFrom : from, to],
    ),
    q(
      `select created_at at time zone 'utc' as at,
              first_reply_at at time zone 'utc' as replied
         from support_tickets
        where created_at >= $1 and created_at < $2`,
      [seriesFrom < from ? seriesFrom : from, to],
    ),
  ]);

  /* ------------------------------------------------------------- the panels */

  const inPeriod = (at: string | Date) => new Date(at) >= from;

  const decisions = decided ?? [];
  const verified = decisions.filter(
    (d) => ["live", "sold"].includes(d.status) && d.reviewed_by,
  ).length;
  const autoCleared = decisions.filter(
    (d) => ["live", "sold"].includes(d.status) && !d.reviewed_by,
  ).length;
  const rejected = decisions.filter((d) => d.status === "rejected").length;
  const infoRequested = decisions.filter((d) => d.status === "info_requested").length;
  const decidedTotal = verified + autoCleared + rejected + infoRequested;

  const soldRows = sold ?? [];
  const gmv = soldRows.filter((s) => inPeriod(s.at)).reduce((t, s) => t + s.price, 0);
  const gmvPrev = soldPrev?.[0]?.total ?? 0;

  const gameTotal = (gameRows ?? []).reduce((t, g) => t + g.total, 0);
  const gameSplit = (gameRows ?? []).map((g) => ({
    label: GAME_LABEL[String(g.game).toLowerCase()] ?? titleCase(String(g.game)),
    value: gameTotal > 0 ? Math.round((g.total / gameTotal) * 100) : 0,
    amount: money(g.total),
  }));

  const outcomes = outcomeRows ?? [];
  const outcomeTotals = new Map<string, number>();
  for (const o of outcomes) {
    if (!inPeriod(o.at)) continue;
    outcomeTotals.set(o.outcome, (outcomeTotals.get(o.outcome) ?? 0) + o.n);
  }
  const conflictOutcomes = OUTCOME_LABELS.map(([code, label]) => ({
    label,
    value: outcomeTotals.get(code) ?? 0,
  })).sort((a, b) => b.value - a.value);

  const t = timing?.[0];
  const medianHours = t?.median_hours ?? null;
  const decidedWithClock = t?.decided ?? 0;
  const onTime =
    decidedWithClock > 0 ? Math.round(((t?.on_time ?? 0) / decidedWithClock) * 100) : null;

  const soldCount = soldRows.filter((s) => inPeriod(s.at)).length;
  const disputes = disputeCount?.[0]?.n ?? 0;
  const conflictRate = soldCount > 0 ? (disputes / soldCount) * 100 : null;

  const largestSeller = sellerRows?.[0]?.total ?? 0;
  const concentration = gmv > 0 ? (largestSeller / gmv) * 100 : null;

  /* ------------------------------------------------------------ the series */

  const gmvSeries = fold(
    soldRows.map((s) => ({ at: s.at, value: s.price / 1000 })),
    starts,
    step,
  ).map((v) => Math.round(v * 10) / 10);

  const clearedSeries = fold(
    decisions
      .filter((d) => ["live", "sold"].includes(d.status))
      .map((d) => ({ at: d.at, value: 1 })),
    starts,
    step,
  );

  const casesClosedSeries = fold(
    outcomes.map((o) => ({ at: o.at, value: o.n })),
    starts,
    step,
  );

  const actionsAppliedSeries = fold(
    outcomes.filter((o) => o.outcome !== "none").map((o) => ({ at: o.at, value: o.n })),
    starts,
    step,
  );

  const joinedSeries = fold(
    (memberRows ?? []).map((m) => ({ at: m.at, value: 1 })),
    starts,
    step,
  );
  const membersSeries = running(memberBase?.[0]?.n ?? 0, joinedSeries);

  const lowConfidenceSeries = fold(
    (lowConfidence ?? []).map((l) => ({ at: l.at, value: 1 })),
    starts,
    step,
  );

  /* Concentration per bucket: the largest seller's share of that bucket, which
     is not the same as their share of the period and is the one that shows a
     single account taking over. */
  const concentrationSeries = starts.map((start, i) => {
    const end = new Date(start.getTime() + step * 86_400_000);
    const bucket = soldRows.filter((s) => {
      const at = new Date(s.at);
      return at >= start && at < end;
    });
    const total = bucket.reduce((sum, s) => sum + s.price, 0);
    if (total <= 0) return 0;
    const bySeller = new Map<string, number>();
    for (const s of bucket) bySeller.set(s.seller_id, (bySeller.get(s.seller_id) ?? 0) + s.price);
    const top = Math.max(...bySeller.values());
    return Math.round((top / total) * 1000) / 10;
  });

  const auditSeries = fold(
    (actionRows ?? []).map((a) => ({ at: a.at, value: 1 })),
    starts,
    step,
  );

  const ticketsAnswered = (ticketRows ?? []).filter((r) => r.replied && inPeriod(r.at)).length;
  const ticketsOpened = (ticketRows ?? []).filter((r) => inPeriod(r.at)).length;
  const ticketsSeries = fold(
    (ticketRows ?? []).map((r) => ({ at: r.at, value: 1 })),
    starts,
    step,
  );

  /* --------------------------------------------------------------- assemble */

  const reports: ReportSeries[] = [
    {
      id: "RP-01",
      name: "GMV and sales",
      detail:
        "Gross merchandise value by game and price band. No take rate: no money passes through the platform, so there is no commission to net off.",
      cadence: "Live",
      category: "Marketplace",
      chart: "Area chart",
      unit: "k",
      format: "CSV",
      available: sold !== null,
      unavailable: sold === null ? "The listings table could not be read." : undefined,
      headline: money(gmv),
      headlineLabel: `GMV, ${period.label.toLowerCase()}`,
      labels,
      trend: gmvSeries,
    },
    {
      id: "RP-02",
      name: "Listing throughput",
      detail:
        "Listings in, cleared, rejected, and time to decision against the 24h review target.",
      cadence: "Live",
      category: "Moderation",
      chart: "Line chart",
      unit: "n",
      format: "CSV",
      available: decided !== null,
      unavailable: decided === null ? "The listings table could not be read." : undefined,
      headline: count(verified + autoCleared),
      headlineLabel: "Cleared in the period",
      labels,
      trend: clearedSeries,
    },
    {
      id: "RP-03",
      name: "Conflict outcomes",
      detail:
        "Every case closed in the period, whose conduct it concerned, and the action applied.",
      cadence: "Live",
      category: "Moderation",
      chart: "Column chart",
      unit: "n",
      format: "CSV",
      available: outcomeRows !== null,
      unavailable: outcomeRows === null ? "The conduct board could not be read." : undefined,
      headline: count(conflictOutcomes.reduce((s, o) => s + o.value, 0)),
      headlineLabel: "Conflicts closed",
      labels,
      trend: casesClosedSeries,
    },
    {
      id: "RP-04",
      name: "Conduct actions",
      detail:
        "Every warning, restriction, closure and police referral, with the case it came from and the moderator who applied it.",
      cadence: "Live",
      category: "Trust and safety",
      chart: "Column chart",
      unit: "n",
      format: "CSV",
      available: outcomeRows !== null,
      unavailable: outcomeRows === null ? "The conduct board could not be read." : undefined,
      headline: count(
        conflictOutcomes.filter((o) => o.label !== "No action").reduce((s, o) => s + o.value, 0),
      ),
      headlineLabel: "Actions applied",
      labels,
      trend: actionsAppliedSeries,
    },
    {
      id: "RP-05",
      name: "Member growth",
      detail: "Sign-ups and the running membership across the period.",
      cadence: "Live",
      category: "Members",
      chart: "Line chart",
      unit: "n",
      format: "CSV",
      available: memberRows !== null,
      unavailable: memberRows === null ? "The member table could not be read." : undefined,
      headline: count(membersSeries[membersSeries.length - 1] ?? 0),
      headlineLabel: "Members",
      labels,
      trend: membersSeries,
    },
    {
      id: "RP-06",
      name: "Price confidence audit",
      detail:
        "Listings that went live on a figure built from fewer than four confirmed sales at that grader and grade.",
      cadence: "Live",
      category: "Marketplace",
      chart: "Line chart",
      unit: "n",
      format: "CSV",
      available: lowConfidence !== null,
      unavailable: lowConfidence === null ? "The sales ledger could not be read." : undefined,
      headline: count(lowConfidenceSeries.reduce((s, v) => s + v, 0)),
      headlineLabel: "Low-confidence listings",
      labels,
      trend: lowConfidenceSeries,
    },
    {
      id: "RP-07",
      name: "Seller concentration",
      detail: "Share of GMV taken by the largest single seller in each bucket.",
      cadence: "Live",
      category: "Marketplace",
      chart: "Column chart",
      unit: "%",
      format: "CSV",
      available: sold !== null,
      unavailable: sold === null ? "The listings table could not be read." : undefined,
      headline: concentration === null ? "—" : `${concentration.toFixed(1)}%`,
      headlineLabel: "Largest seller share",
      labels,
      trend: concentrationSeries,
    },
    {
      id: "RP-08",
      name: "Moderation actions",
      detail:
        "Listing decisions and conduct decisions, counted per bucket. Not an audit log — there is no audit table yet, and this is the count of the actions that did leave a dated mark.",
      cadence: "Live",
      category: "Moderation",
      chart: "Table",
      unit: "n",
      format: "CSV",
      available: actionRows !== null,
      unavailable: actionRows === null ? "Neither decision table could be read." : undefined,
      headline: count(auditSeries.reduce((s, v) => s + v, 0)),
      headlineLabel: "Actions taken",
      labels,
      trend: auditSeries,
    },
    {
      id: "RP-09",
      name: "Support desk",
      detail:
        "Tickets opened in the period and how many of them got a first reply. The reply clock stops once and never restarts, so a ticket answered late stays answered late.",
      cadence: "Live",
      category: "Members",
      chart: "Column chart",
      unit: "n",
      format: "CSV",
      available: ticketRows !== null,
      unavailable: ticketRows === null ? "The support desk could not be read." : undefined,
      headline: count(ticketsOpened),
      headlineLabel: `Opened · ${count(ticketsAnswered)} answered`,
      labels,
      trend: ticketsSeries,
    },
  ];

  return {
    period: { key, label: period.label, days, from: from.toISOString(), to: to.toISOString() },
    kpis: [
      {
        key: "r1",
        label: "Cleared this period",
        value: count(verified + autoCleared),
        delta: delta(verified + autoCleared, decidedPrev?.[0]?.n ?? 0),
        foot: `of ${count(decidedTotal)} decided`,
        tone: "navy",
      },
      {
        key: "r2",
        label: "Median time to decision",
        value: hoursLabel(medianHours),
        delta: null,
        foot: "Target is 24h",
        tone: "gold",
      },
      {
        key: "r3",
        label: "Rejection rate",
        value: decidedTotal > 0 ? `${((rejected / decidedTotal) * 100).toFixed(1)}%` : "—",
        delta: null,
        foot: `${count(rejected)} of ${count(decidedTotal)}`,
      },
      {
        key: "r4",
        label: "Conflict rate",
        value: conflictRate === null ? "—" : `${conflictRate.toFixed(1)}%`,
        delta: null,
        foot: soldCount > 0 ? `${count(disputes)} of ${count(soldCount)} sales` : "No sales yet",
      },
    ],
    gameSplit,
    decisionSplit: [
      { label: "Verified", value: verified, color: "var(--ok)" },
      { label: "Rejected", value: rejected, color: "var(--bad)" },
      { label: "Info requested", value: infoRequested, color: "var(--warn)" },
      { label: "Auto-cleared", value: autoCleared, color: "var(--gold-300)" },
    ],
    conflictOutcomes,
    throughput: {
      onTime,
      medianLabel: hoursLabel(medianHours),
      breached: Math.max(0, decidedWithClock - (t?.on_time ?? 0)),
      decided: decidedWithClock,
    },
    reports,
  };
}

/* --------------------------------------------------------------------------
   The shape with nothing in it

   Returned when there is no database at all. Every panel says unavailable
   rather than zero: a console with no store behind it and a marketplace with
   no activity in it must not look the same.
   -------------------------------------------------------------------------- */

function blank(
  key: string,
  label: string,
  days: number,
  from: Date,
  to: Date,
  labels: string[],
): ReportsPayload {
  const none = "No store is configured, so nothing can be counted.";
  return {
    period: { key, label, days, from: from.toISOString(), to: to.toISOString() },
    kpis: [],
    gameSplit: [],
    decisionSplit: [],
    conflictOutcomes: [],
    throughput: { onTime: null, medianLabel: "—", breached: 0, decided: 0 },
    reports: [
      ["RP-01", "GMV and sales", "Marketplace", "Area chart"],
      ["RP-02", "Listing throughput", "Moderation", "Line chart"],
      ["RP-03", "Conflict outcomes", "Moderation", "Column chart"],
      ["RP-04", "Conduct actions", "Trust and safety", "Column chart"],
      ["RP-05", "Member growth", "Members", "Line chart"],
      ["RP-06", "Price confidence audit", "Marketplace", "Line chart"],
      ["RP-07", "Seller concentration", "Marketplace", "Column chart"],
      ["RP-08", "Moderation actions", "Moderation", "Table"],
      ["RP-09", "Support desk", "Members", "Column chart"],
    ].map(([id, name, category, chart]) => ({
      id,
      name,
      detail: none,
      cadence: "Live",
      category: category as ReportSeries["category"],
      chart: chart as ReportSeries["chart"],
      unit: "n" as const,
      format: "CSV",
      available: false,
      unavailable: none,
      headline: "—",
      headlineLabel: "",
      labels,
      trend: [],
    })),
  };
}

/* --------------------------------------------------------------------------
   Vocabulary
   -------------------------------------------------------------------------- */

/** The store's game keys, in the console's words. Same mapping the listing
 *  queue normalises with, kept here so a report never prints "pokemon". */
const GAME_LABEL: Record<string, string> = {
  pokemon: "Pokémon",
  "pokémon": "Pokémon",
  magic: "Magic",
  mtg: "Magic",
  yugioh: "Yu-Gi-Oh!",
  "yu-gi-oh": "Yu-Gi-Oh!",
  onepiece: "One Piece",
  "one piece": "One Piece",
  sports: "Sports",
  unknown: "Unspecified",
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Conduct outcomes, in the order the board defines them. `none` is a real
 *  outcome — a case looked at and closed with no action is not a case that was
 *  never decided, and hiding it makes the moderation rate look higher. */
const OUTCOME_LABELS: [string, string][] = [
  ["warned", "Warned"],
  ["none", "No action"],
  ["restricted", "Restricted"],
  ["closed", "Account closed"],
  ["police", "Referred to police"],
];
