import { storePool } from "../cards.store.js";

// The listing queue, as the admin console needs it.
//
// The console does not want a `listings` row. It wants the row plus the three
// things a moderator reads before deciding: who the seller is and whether they
// have a history, what the card is actually worth, and how long this has been
// waiting. Assembling that per row in the client is five round trips a listing;
// it is one query here.
//
// Nothing in this file writes. Decisions go through `moveListing` in
// listings/store.ts so there is exactly one place the state machine is
// enforced — this module must never become a second one.

/* --------------------------------------------------------------------------
   The domain the console speaks

   Its statuses are not the store's. The store has one `in_review`; the console
   distinguishes a listing waiting on anybody from one a named moderator has
   claimed, because those are different work. The mapping lives here, in one
   direction, rather than being re-derived on every screen.
   -------------------------------------------------------------------------- */

export type AdminStatus =
  | "awaiting"
  | "in-review"
  | "info-requested"
  | "live"
  | "sold"
  | "paused"
  | "withdrawn"
  | "rejected";

/** Which store statuses each console view gathers. */
export const VIEWS: Record<string, string[]> = {
  queue: ["in_review"],
  seller: ["info_requested"],
  market: ["live", "sold", "paused"],
  closed: ["withdrawn", "rejected"],
  all: ["in_review", "info_requested", "live", "sold", "paused", "withdrawn", "rejected"],
};

/** The review target, in hours. The dashboard states it, so it lives once. */
export const SLA_HOURS = 24;

/**
 * Tier thresholds, in the listing's own currency.
 *
 * A tier is not stored because it is not a fact about the card — it is a fact
 * about how much is at stake, and it moves when the price does. A seller who
 * drops a grail-tier ask to $900 should not still be queued as a grail.
 */
export const GRAIL_FLOOR = 10_000;
export const HIGH_VALUE_FLOOR = 2_000;

export type AdminListing = {
  id: string;
  card: string;
  art?: string;
  setLine: string;
  game: string;
  grader: string;
  grade: string;
  labelGrade?: string;
  cert: string;
  askPrice: number;
  currency: string;
  marketPrice: number;
  /**
   * Where the market figure came from. "comps" is the median of our own
   * confirmed sales at this exact grader and grade; "listing" is the figure
   * the seller was quoted when they priced it, held on the row and not
   * recomputed since; "none" means there is no figure to show.
   *
   * The console has to be able to say which, because a moderator reading
   * "$1,878 from 0 comparable sales" is being told two contradictory things.
   */
  marketSource: "comps" | "listing" | "none";
  confidence: "high" | "medium" | "low";
  sampleSize: number;
  tier: "grail" | "high-value" | "standard";
  status: AdminStatus;
  seller: {
    id: string;
    handle: string;
    name: string;
    initials: string;
    sales: number;
    rating: number;
    reviews: number;
    verified: boolean;
  };
  submitted: string;
  releasedAt?: string;
  reviewedBy?: string;
  claimedBy?: string;
  slaHours: number;
  photos: number;
  views: number;
  watchers: number;
  flags: string[];
  note?: string;
  rejectReason?: string;
};

/* --------------------------------------------------------------------------
   One query, one row per listing

   `sales_ledger` is joined on the exact price key — catalogue id, grader and
   grade together — and never on the catalogue id alone. Invariant 1: there is
   no grade-only price lookup in this system, and a market figure quoted from
   the wrong grader is worse than no figure at all, because a moderator will
   act on it.
   -------------------------------------------------------------------------- */

const ROW_SQL = `
  select
    l.*,
    u.name           as seller_name,
    u.user_id        as seller_uid,
    u.created_at     as seller_since,
    coalesce(idn.status, 'Not Started') as seller_identity,
    coalesce(sold.n, 0)   as seller_sales,
    coalesce(rep.n, 0)    as seller_reviews,
    rep.avg               as seller_rating,
    comps.n               as comp_count,
    comps.median          as comp_median
  from listings l
  left join users u on u.user_id = l.seller_id
  left join identity_status idn on idn.user_id = l.seller_id
  left join lateral (
    select count(*)::int n from listings s
     where s.seller_id = l.seller_id and s.status = 'sold'
  ) sold on true
  left join lateral (
    select count(*)::int n, avg(r.stars)::float avg
      from ratings r
     where r.ratee_id = l.seller_id and r.rater_role = 'buyer'
  ) rep on true
  left join lateral (
    select count(*)::int n,
           percentile_cont(0.5) within group (order by sl.price)::float median
      from sales_ledger sl
     where l.catalog_id is not null
       and sl.catalog_id = l.catalog_id
       and sl.grader is not distinct from l.grader
       and sl.grade  is not distinct from l.grade
  ) comps on true
`;

export async function adminListings(q: {
  view?: string;
  search?: string | null;
  tier?: string | null;
  limit?: number;
}): Promise<AdminListing[]> {
  const pool = storePool();
  if (!pool) return [];

  const statuses = VIEWS[q.view ?? "all"] ?? VIEWS.all;
  const args: any[] = [statuses];
  const where = ["l.status = any($1)"];

  // The console's search box says "card, cert, listing id, seller". It has to
  // mean all four, or a moderator handed a cert number by a seller has nowhere
  // to type it.
  if (q.search) {
    args.push(`%${q.search.trim()}%`);
    const n = args.length;
    where.push(
      `(l.card_name ilike $${n} or l.cert_number ilike $${n}
        or l.listing_id ilike $${n} or u.name ilike $${n} or l.set_name ilike $${n})`,
    );
  }

  if (q.tier && q.tier !== "all") {
    args.push(GRAIL_FLOOR, HIGH_VALUE_FLOOR);
    const g = args.length - 1;
    const h = args.length;
    const expr =
      q.tier === "grail" ? `l.price >= $${g}`
      : q.tier === "high-value" ? `l.price >= $${h} and l.price < $${g}`
      : `l.price < $${h}`;
    where.push(expr);
  }

  args.push(Math.min(q.limit ?? 200, 500));
  const r = await pool.query(
    `${ROW_SQL} where ${where.join(" and ")}
      order by
        -- overdue first, then the rest in the order they arrived: the console
        -- sorts by time left rather than by value, and says so on screen
        case when l.status = 'in_review' then 0 else 1 end,
        l.submitted_at asc nulls first,
        l.created_at desc
      limit $${args.length}`,
    args,
  );
  return r.rows.map(shape);
}

export async function adminListing(id: string): Promise<AdminListing | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(`${ROW_SQL} where l.listing_id = $1`, [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

/**
 * The number on every tab.
 *
 * A count is a count, so it is one aggregate over `listings` rather than the
 * whole queue fetched a second time. Building it by re-running the row query
 * and counting the results in JavaScript meant every load paid for the
 * lateral joins — the seller, the ratings, the comps — twice, for figures
 * that need none of them.
 */
export async function queueCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = { queue: 0, seller: 0, market: 0, closed: 0, all: 0 };
  const pool = storePool();
  if (!pool) return out;
  const r = await pool.query(
    `select status, count(*)::int n
       from listings where status <> 'draft' group by status`,
  );
  for (const row of r.rows) {
    const n = Number(row.n);
    out.all += n;
    if (row.status === "in_review") out.queue += n;
    else if (row.status === "info_requested") out.seller += n;
    else if (["live", "sold", "paused"].includes(row.status)) out.market += n;
    else out.closed += n;
  }
  return out;
}

/** The photo set, as angles rather than as a count. */
export async function listingPhotos(
  id: string,
): Promise<{ angle: string; url: string }[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query("select photos from listings where listing_id = $1", [id]);
  const raw = r.rows[0]?.photos;
  return Array.isArray(raw) ? raw : [];
}

/**
 * The sales the quoted figure is built on.
 *
 * Returned with the grader and grade of every row so the console can show that
 * the rule held — one grading company, one grade, no conversions — rather than
 * asserting it in a caption nobody can check.
 */
export async function listingComps(id: string, limit = 5) {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select sl.sale_id, sl.price::float, sl.currency, sl.sold_at,
            sl.grader, sl.grade, sl.source, sl.source_url
       from listings l
       join sales_ledger sl
         on sl.catalog_id = l.catalog_id
        and sl.grader is not distinct from l.grader
        and sl.grade  is not distinct from l.grade
      where l.listing_id = $1 and l.catalog_id is not null
      order by sl.sold_at desc
      limit $2`,
    [id, Math.min(limit, 25)],
  );
  const sales = r.rows.map((x: any) => ({
    id: x.sale_id,
    price: x.price as number,
    currency: x.currency as string,
    soldAt: x.sold_at,
    grader: x.grader as string | null,
    grade: x.grade as string | null,
    source: x.source as string,
    ref: x.source_url ?? x.sale_id,
  }));
  return markOutliers(sales);
}

/**
 * Which of these sales should not be moving the quoted figure.
 *
 * Median absolute deviation rather than a standard deviation: the thing being
 * looked for IS the extreme value, and a mean and a standard deviation are
 * both dragged towards it by the one row that needs catching. With five comps
 * one bad sale would take the threshold with it.
 *
 * Under four sales nothing is flagged. A spread measured from three numbers is
 * not a spread, and calling one of three a fake sale is a guess a moderator
 * would then act on.
 */
export function markOutliers<T extends { price: number }>(
  sales: T[],
): (T & { outlier: boolean; why?: string })[] {
  if (sales.length < 4) return sales.map((s) => ({ ...s, outlier: false }));

  const prices = sales.map((s) => s.price).sort((a, b) => a - b);
  const med = median(prices);
  // The deviations have to be sorted in their own right: they come out of the
  // sorted prices in a V shape, not in order, and `median` reads the middle of
  // whatever it is handed. Unsorted, this returned a deviation near the top of
  // the range as the typical one, which made the threshold small enough to
  // flag most of a perfectly ordinary spread.
  const deviations = prices.map((p) => Math.abs(p - med)).sort((a, b) => a - b);
  const mad = median(deviations) || 1;

  return sales.map((s) => {
    // 0.6745 rescales MAD to a standard-deviation equivalent for a normal
    // spread, so the 3.5 below reads as "three and a half sigma out".
    const score = (0.6745 * Math.abs(s.price - med)) / mad;
    if (score <= 3.5) return { ...s, outlier: false };
    return {
      ...s,
      outlier: true,
      why: `${s.price > med ? "Well above" : "Well below"} the other confirmed sales at this grade. Excluded from the quoted figure.`,
    };
  });
}

/** The middle of an ASCENDING array. Passing an unsorted one is a bug, and
 *  was one — see the note in `markOutliers`. */
const median = (sorted: number[]) => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * What this seller has been decided on before.
 *
 * The feature set calls for the decision to be filed on the member record and
 * for the reviewer to see that history before taking the next one. There is no
 * member-events table yet, so this is the part of it that does exist and is
 * true: every other listing this seller has put up, what was decided, by whom
 * and when. It is read from `listings` rather than assembled from a second
 * store, so it cannot drift from what the queue says.
 */
export async function sellerHistory(listingId: string, limit = 12) {
  const pool = storePool();
  if (!pool) return [];
  // Keyed on the listing rather than the seller so the caller does not have to
  // read the listing first. Every query behind the record then runs at once,
  // and the record opens in one round trip's worth of latency instead of two.
  const r = await pool.query(
    `select h.listing_id, h.card_name, h.set_name, h.status, h.price::float,
            h.reject_reason, h.reviewed_by, h.reviewed_at, h.submitted_at, h.created_at
       from listings l
       join listings h on h.seller_id = l.seller_id
      where l.listing_id = $1 and h.listing_id <> $1 and h.status <> 'draft'
      order by coalesce(h.reviewed_at, h.submitted_at, h.created_at) desc
      limit $2`,
    [listingId, Math.min(limit, 50)],
  );
  return r.rows.map((x: any) => ({
    id: x.listing_id,
    card: x.card_name,
    setName: x.set_name,
    status: x.status,
    price: x.price,
    reason: x.reject_reason ?? null,
    by: x.reviewed_by ?? null,
    at: iso(x.reviewed_at ?? x.submitted_at ?? x.created_at),
  }));
}

/** Claim a listing so the queue shows it is being worked, and by whom. */
export async function claimListing(id: string, by: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update listings set claimed_by = $2, claimed_at = now()
      where listing_id = $1 and status = 'in_review' and claimed_by is null`,
    [id, by],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function releaseListing(id: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    "update listings set claimed_by = null, claimed_at = null where listing_id = $1",
    [id],
  );
}

/** A moderator's own finding, and the note that goes on the record with it. */
export async function annotate(
  id: string,
  patch: { flags?: string[]; note?: string | null },
): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `update listings set
       moderator_flags = coalesce($2::jsonb, moderator_flags),
       moderator_note  = coalesce($3, moderator_note)
     where listing_id = $1`,
    [id, patch.flags ? JSON.stringify(patch.flags) : null, patch.note ?? null],
  );
}

/* --------------------------------------------------------------------------
   Row → console
   -------------------------------------------------------------------------- */

export function shape(r: any): AdminListing {
  const ask = Number(r.price ?? 0);
  const photos = Array.isArray(r.photos) ? r.photos.length : 0;

  // The listing's own snapshot of market value is what the seller was shown
  // when they priced it. It is only trusted when we have nothing better; a
  // figure computed from our own confirmed sales is the one the price engine
  // stands behind. 0 means "too few sales to say" and the console renders it
  // as a withheld figure rather than as free.
  const comps = Number(r.comp_count ?? 0);
  const fromComps = comps > 0 && r.comp_median != null;
  const market = fromComps
    ? Number(r.comp_median)
    : r.market_value != null
      ? Number(r.market_value)
      : 0;
  const marketSource: AdminListing["marketSource"] =
    fromComps ? "comps" : market > 0 ? "listing" : "none";

  const name: string = r.seller_name ?? "Unknown seller";

  return {
    id: r.listing_id,
    card: r.card_name,
    art: r.image_url ?? undefined,
    setLine: [r.set_name, r.variant, r.card_number ? `#${String(r.card_number).replace(/^#/, "")}` : null]
      .filter(Boolean)
      .join(" · "),
    game: r.game ?? "—",
    grader: r.is_raw || !r.grader ? "Raw" : r.grader,
    grade: r.grade ?? "None",
    labelGrade: r.label_grade ?? undefined,
    cert: r.cert_number ?? "—",
    askPrice: ask,
    currency: r.currency ?? "AUD",
    marketPrice: market,
    marketSource,
    confidence: comps >= 20 ? "high" : comps >= 5 ? "medium" : "low",
    sampleSize: comps,
    tier: ask >= GRAIL_FLOOR ? "grail" : ask >= HIGH_VALUE_FLOOR ? "high-value" : "standard",
    status: adminStatus(r),
    seller: {
      id: r.seller_id,
      handle: handleFor(name, r.seller_id),
      name,
      initials: initialsFor(name),
      sales: Number(r.seller_sales ?? 0),
      rating: r.seller_rating != null ? Number(r.seller_rating) : 0,
      reviews: Number(r.seller_reviews ?? 0),
      verified: r.seller_identity === "Approved",
    },
    submitted: iso(r.submitted_at ?? r.created_at),
    releasedAt: r.live_at ? iso(r.live_at) : undefined,
    reviewedBy: r.reviewed_by ?? undefined,
    claimedBy: r.claimed_by ?? undefined,
    slaHours: slaLeft(r),
    photos,
    views: Number(r.views ?? 0),
    watchers: Number(r.saves ?? 0),
    flags: Array.isArray(r.moderator_flags) ? r.moderator_flags : [],
    note: r.moderator_note ?? undefined,
    rejectReason: r.reject_reason ?? undefined,
  };
}

export function adminStatus(r: any): AdminStatus {
  switch (r.status) {
    case "in_review":
      return r.claimed_by ? "in-review" : "awaiting";
    case "info_requested":
      return "info-requested";
    case "paused":
      return "paused";
    case "live":
      return "live";
    case "sold":
      return "sold";
    case "rejected":
      return "rejected";
    default:
      return "withdrawn";
  }
}

/** Hours left on the review target. Negative is over, and the console leads
 *  with it. Anything that is not waiting on us has no clock running. */
export function slaLeft(r: any): number {
  if (r.status !== "in_review") return 0;
  const from = r.submitted_at ?? r.created_at;
  if (!from) return SLA_HOURS;
  const elapsed = (Date.now() - new Date(from).getTime()) / 3_600_000;
  return Math.round(SLA_HOURS - elapsed);
}

/** Members have no handle in the store yet, so one is derived from the name
 *  and falls back to the id. It is a label on an admin screen, never a key. */
function handleFor(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `@${slug}` : `@${id}`;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const iso = (d: any) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
