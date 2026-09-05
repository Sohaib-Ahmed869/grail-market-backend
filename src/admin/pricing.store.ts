import { storePool } from "../cards.store.js";

// The price engine, as the console reads it.
//
// Four questions, and the page answers exactly those four:
//
//   1. Are the sources still delivering?          → feedHealth()
//   2. Which (card, grader, grade) do we price?   → gradeSets()
//   3. What sits under each of those figures?     → compsFor()
//   4. What has been thrown out, and should it be? → excludedComps()
//
// Invariant 1 runs through all of it: a grade belongs to a (card, grading
// company) pair, never to a card alone. Nothing here groups by grade without
// grader, and nothing converts between graders to reach a number.

/* --------------------------------------------------------------------------
   Our half of the record

   `sales_ledger` is append-only — never UPDATE, never DELETE — so a decision
   to leave a sale out of a quoted price cannot be a column on it. It is a row
   of ours beside it, exactly as a conduct decision sits beside a dispute.
   -------------------------------------------------------------------------- */

export const PRICING_SCHEMA = `
CREATE TABLE IF NOT EXISTS price_exclusions (
  sale_id    text PRIMARY KEY,
  -- true = held out of the quoted figure. A row that has been ruled back IN
  -- stays here with is_excluded = false, because "a person looked at this and
  -- said it is real" is worth keeping. Not called "excluded": that is the name
  -- of the pseudo-table in every ON CONFLICT clause that touches this row.
  is_excluded boolean NOT NULL DEFAULT true,
  reason     text,
  -- 'engine' when the outlier test flagged it, otherwise the operator's name.
  ruled_by   text NOT NULL,
  ruled_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_exclusions_open ON price_exclusions (is_excluded, ruled_at DESC);
`;

export async function initPricing(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(PRICING_SCHEMA);
}

/* --------------------------------------------------------------------------
   Feed health
   -------------------------------------------------------------------------- */

export type FeedStatus = "healthy" | "degraded" | "stale" | "down";

export type FeedHealth = {
  key: string;
  name: string;
  covers: string;
  status: FeedStatus;
  /** Last time rows landed, or null if this source has never delivered. */
  lastSync: string | null;
  sinceHours: number | null;
  /** Hours after which this source counts as stale. */
  staleAfter: number;
  /** Rows this source has contributed. */
  rows: number;
  /** Share of its lookups that came back with nothing usable, as a percentage. */
  rejectRate: number;
  note?: string;
};

/**
 * The sources the engine actually runs on.
 *
 * Not the ones the feature set names. The brief was written against eBay AU,
 * PriceCharting and TCGplayer; what the ingest chain is wired to today is our
 * own completed trades, PokémonPriceTracker and the CardGrader store, with an
 * estimate as the last resort. Printing the brief's list would be a page that
 * says four sources are healthy when three of them are not connected — which
 * is the exact failure this page exists to catch.
 */
const FEEDS: { key: string; name: string; covers: string; staleAfter: number }[] = [
  {
    key: "grailmarket",
    name: "Grail Market sales",
    covers: "Our own completed trades. The only source we can check from both ends.",
    staleAfter: 24 * 14,
  },
  {
    key: "pokemonpricetracker",
    name: "PokémonPriceTracker",
    covers: "Graded sale history for Pokémon. The main source behind a graded figure.",
    staleAfter: 48,
  },
  {
    key: "grailcard-store",
    name: "CardGrader store",
    covers: "Graded sales we have already collected and hold ourselves.",
    staleAfter: 24 * 7,
  },
  {
    key: "estimate",
    name: "Estimated from raw",
    covers:
      "Not a source. Where no graded sale exists, a figure is derived from the raw price and marked low confidence.",
    staleAfter: 24 * 30,
  },
];

function statusOf(sinceHours: number | null, staleAfter: number, rows: number): FeedStatus {
  if (rows === 0) return "down";
  if (sinceHours === null) return "down";
  if (sinceHours > staleAfter * 2) return "stale";
  if (sinceHours > staleAfter) return "degraded";
  return "healthy";
}

export async function feedHealth(): Promise<FeedHealth[]> {
  const pool = storePool();
  if (!pool) return [];

  // Two tables answer this between them: graded figures carry the source that
  // produced them, and our own trades land in the sales ledger instead.
  const [graded, sales, misses] = await Promise.all([
    pool.query(`select source, count(*)::int n, max(fetched_at) newest from grade_prices group by 1`),
    pool.query(`select source, count(*)::int n, max(ingested_at) newest from sales_ledger group by 1`),
    pool.query(
      `select provider,
              count(*)::int n,
              count(*) filter (where is_miss)::int missed
         from card_prices group by 1`,
    ),
  ]);

  const seen = new Map<string, { rows: number; newest: Date | null }>();
  for (const r of [...graded.rows, ...sales.rows]) {
    const k = String(r.source);
    const prev = seen.get(k);
    const newest = r.newest ? new Date(r.newest) : null;
    seen.set(k, {
      rows: (prev?.rows ?? 0) + Number(r.n),
      newest:
        prev?.newest && newest ? (prev.newest > newest ? prev.newest : newest) : newest ?? prev?.newest ?? null,
    });
  }

  const missRate = new Map<string, number>();
  for (const r of misses.rows) {
    const n = Number(r.n);
    missRate.set(String(r.provider), n ? Math.round((Number(r.missed) / n) * 1000) / 10 : 0);
  }

  return FEEDS.map((f) => {
    const s = seen.get(f.key) ?? { rows: 0, newest: null };
    const sinceHours = s.newest
      ? Math.max(0, Math.round((Date.now() - s.newest.getTime()) / 3_600_000))
      : null;
    const status = statusOf(sinceHours, f.staleAfter, s.rows);
    return {
      key: f.key,
      name: f.name,
      covers: f.covers,
      status,
      lastSync: s.newest ? s.newest.toISOString() : null,
      sinceHours,
      staleAfter: f.staleAfter,
      rows: s.rows,
      rejectRate: missRate.get(f.key) ?? 0,
      note:
        s.rows === 0
          ? "Nothing has ever come from this source. Any price that would have leaned on it is being answered from somewhere else, or not at all."
          : status === "stale"
            ? `Nothing new for ${sinceHours} hours, against a ${f.staleAfter}-hour threshold. Prices leaning on this source are older than they look.`
            : undefined,
    };
  });
}

/* --------------------------------------------------------------------------
   Grade sets
   -------------------------------------------------------------------------- */

export type GradeSet = {
  catalogId: string;
  card: string;
  setLine: string;
  game: string;
  grader: string;
  grade: string;
  /** The figure the app would quote. Null where the engine has no answer. */
  price: number | null;
  /** Which currency that figure is in. Graded figures come back from the
   *  providers in USD while our own ledger is in AUD, and a page that shows
   *  both without saying so is a page that invents a 50% price move. */
  currency: string;
  low: number | null;
  high: number | null;
  median: number | null;
  sampleSize: number;
  confidence: string;
  source: string;
  lastSaleAt: string | null;
  fetchedAt: string | null;
  /** Confirmed sales we hold in our own ledger for this exact pair. */
  ledgerSales: number;
};

/**
 * Every (card, grader, grade) the engine holds a figure for.
 *
 * Ordered by how shaky the figure is rather than alphabetically: a set priced
 * off one sale is the one worth looking at, and a page that opens on the
 * best-supported rows buries exactly the rows a person is here for.
 */
export async function gradeSets(limit = 60): Promise<GradeSet[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select g.catalog_id, g.grader, g.grade, g.price::float, g.low::float, g.high::float,
            g.median::float, g.sample_size, g.confidence, g.source, g.currency,
            g.last_sale_at, g.fetched_at,
            c.name, c.set_name, c.card_number, c.game,
            coalesce(s.n, 0)::int as ledger_sales
       from grade_prices g
       left join catalog_cards c on c.catalog_id = g.catalog_id
       left join lateral (
         select count(*)::int n from sales_ledger sl
          where sl.catalog_id = g.catalog_id
            and sl.grader = g.grader
            and sl.grade = g.grade::text
       ) s on true
      order by g.sample_size asc, g.fetched_at desc
      limit $1`,
    [Math.min(limit, 300)],
  );
  return r.rows.map((x: any) => ({
    catalogId: x.catalog_id,
    card: x.name ?? x.catalog_id,
    setLine: [x.set_name, x.card_number ? `#${x.card_number}` : null].filter(Boolean).join(" · "),
    game: x.game ?? "pokemon",
    grader: x.grader,
    grade: gradeText(x.grade),
    price: num(x.price),
    currency: String(x.currency ?? "USD").trim() || "USD",
    low: num(x.low),
    high: num(x.high),
    median: num(x.median),
    sampleSize: Number(x.sample_size ?? 0),
    confidence: x.confidence ?? "low",
    source: x.source ?? "unknown",
    lastSaleAt: x.last_sale_at ? iso(x.last_sale_at) : null,
    fetchedAt: x.fetched_at ? iso(x.fetched_at) : null,
    ledgerSales: Number(x.ledger_sales ?? 0),
  }));
}

/* --------------------------------------------------------------------------
   The sales under a figure
   -------------------------------------------------------------------------- */

export type AdminComp = {
  id: string;
  catalogId: string;
  card: string;
  setLine: string;
  grader: string | null;
  grade: string | null;
  price: number;
  currency: string;
  soldAt: string;
  source: string;
  ref: string;
  rawTitle: string | null;
  excluded: boolean;
  why: string | null;
  ruledBy: string | null;
};

const COMP_SQL = `
  select sl.sale_id, sl.catalog_id, sl.grader, sl.grade, sl.price::float, sl.currency,
         sl.sold_at, sl.source, sl.source_url, sl.raw_title,
         c.name, c.set_name, c.card_number,
         x.is_excluded, x.reason, x.ruled_by
    from sales_ledger sl
    left join catalog_cards c on c.catalog_id = sl.catalog_id
    left join price_exclusions x on x.sale_id = sl.sale_id
`;

function shapeComp(x: any): AdminComp {
  return {
    id: x.sale_id,
    catalogId: x.catalog_id,
    // The catalogue is the good name; the listing's own title is the next
    // best. Falling straight through to the catalogue id shows an operator
    // "base1-15" where they asked what card this is.
    card: x.name ?? x.raw_title ?? x.catalog_id,
    setLine:
      [x.set_name, x.card_number ? `#${x.card_number}` : null].filter(Boolean).join(" · ") ||
      x.catalog_id,
    grader: x.grader,
    grade: x.grade,
    price: Number(x.price),
    currency: x.currency ?? "AUD",
    soldAt: iso(x.sold_at),
    source: x.source,
    ref: x.source_url ?? x.sale_id,
    rawTitle: x.raw_title,
    excluded: x.is_excluded === true,
    why: x.reason ?? null,
    ruledBy: x.ruled_by ?? null,
  };
}

/** Every confirmed sale for one exact pair, newest first. Never crosses
 *  graders — see the module note. */
export async function compsFor(
  catalogId: string,
  grader: string | null,
  grade: string | null,
  limit = 5,
): Promise<AdminComp[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `${COMP_SQL}
      where sl.catalog_id = $1
        and ($2::text is null or sl.grader = $2)
        and ($3::text is null or sl.grade = $3)
      order by sl.sold_at desc
      limit $4`,
    [catalogId, grader, grade, Math.min(limit, 50)],
  );
  return r.rows.map(shapeComp);
}

/** Everything currently held out of a quoted figure and waiting on a person. */
export async function excludedComps(limit = 50): Promise<AdminComp[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `${COMP_SQL} where x.is_excluded is true order by x.ruled_at desc limit $1`,
    [Math.min(limit, 200)],
  );
  return r.rows.map(shapeComp);
}

/**
 * Keep a sale out of the quoted figure, or put it back in.
 *
 * The ledger row itself is never touched. `excluded = false` is recorded
 * rather than deleted so "a person read this and said it is a real sale"
 * survives, and the engine does not re-flag it on the next run.
 */
export async function ruleOnComp(
  saleId: string,
  a: { excluded: boolean; reason: string; by: string },
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const exists = await pool.query("select 1 from sales_ledger where sale_id = $1", [saleId]);
  if (!exists.rowCount) return false;
  await pool.query(
    `insert into price_exclusions (sale_id, is_excluded, reason, ruled_by, ruled_at)
     values ($1,$2,$3,$4, now())
     on conflict (sale_id) do update
       set is_excluded = excluded.is_excluded, reason = excluded.reason,
           ruled_by = excluded.ruled_by, ruled_at = now()`,
    [saleId, a.excluded, a.reason || null, a.by],
  );
  return true;
}

/** The median of what counts, which is what the app quotes. */
export function medianOf(list: AdminComp[]): number | null {
  const kept = list.filter((c) => !c.excluded).map((c) => c.price).sort((a, b) => a - b);
  if (!kept.length) return null;
  const mid = Math.floor(kept.length / 2);
  return kept.length % 2 ? kept[mid] : Math.round((kept[mid - 1] + kept[mid]) / 2);
}

/* --------------------------------------------------------------------------
   Shaping
   -------------------------------------------------------------------------- */

/** `grade` is numeric in `grade_prices` and text in the ledger. 10.0 and "10"
 *  are the same grade, and a page that prints both is a page that looks like
 *  it holds two grade sets where it holds one. */
function gradeText(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v ?? "");
}

const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (d: any) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
