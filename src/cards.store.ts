import { Pool } from "pg";

// Shared card store (Neon Postgres).
//
// Graded prices are metered and expensive: the provider bills per card
// returned and a day's allowance runs out in a handful of lookups. The local
// SQLite cache fixed repeat scans on ONE machine, but every deploy, every dev
// box and every extra instance started from nothing and re-bought the same
// cards.
//
// This is the durable layer underneath that: whatever the paid API hands back
// is written here in full, and every future lookup — from any machine — reads
// here before spending a credit. We keep the entire provider payload, not just
// the three numbers we happen to render today, so that adding a field later is
// a migration rather than a re-purchase.
//
// Everything here is best-effort. A database that is unreachable, slow or
// misconfigured must never break a scan; callers fall back to the local cache
// and then to the API.

const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 8000;

let pool: Pool | null = null;
let ready: Promise<boolean> | null = null;
/** flips false after a hard failure so we stop paying the latency every scan */
let usable = true;

export function storeConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** The shared pool, for modules that persist alongside the price store.
 *  Exported rather than duplicated so there is one connection pool and one
 *  place that decides the store is unusable. */
export function storePool(): Pool | null {
  return getPool();
}

function getPool(): Pool | null {
  if (!storeConfigured()) return null;
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    // Neon terminates idle connections; letting the pool retire them quietly
    // avoids noisy unhandled errors on long-lived dev servers.
    allowExitOnIdle: true,
  });
  pool.on("error", (err) => {
    console.warn(`[store] idle client error: ${err.message}`);
  });
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS card_prices (
  cache_key        TEXT PRIMARY KEY,
  provider         TEXT        NOT NULL DEFAULT 'pokemonpricetracker',

  -- what we asked for
  query_name       TEXT,
  query_number     TEXT,
  query_set        TEXT,

  -- what the provider says this card is
  provider_card_id TEXT,
  card_name        TEXT,
  set_name         TEXT,
  card_number      TEXT,
  rarity           TEXT,
  image_url        TEXT,

  -- the numbers we render
  raw_usd          NUMERIC,
  psa8             NUMERIC,
  psa9             NUMERIC,
  psa10            NUMERIC,

  -- the evidence behind them: sample size and spread per grade
  psa8_count       INTEGER,
  psa9_count       INTEGER,
  psa10_count      INTEGER,
  psa8_min         NUMERIC,
  psa8_max         NUMERIC,
  psa9_min         NUMERIC,
  psa9_max         NUMERIC,
  psa10_min        NUMERIC,
  psa10_max        NUMERIC,
  last_sale_date   TIMESTAMPTZ,

  estimated        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- true when the provider genuinely had nothing, so we don't re-buy a miss
  is_miss          BOOLEAN     NOT NULL DEFAULT FALSE,

  -- the complete provider response, so a new field later costs a migration
  -- rather than another round of paid lookups
  payload          JSONB,

  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (card, grader, grade, qualifier, label). This is the composite
-- key: a price is meaningless without the company that issued the grade.
--
-- The columns on card_prices above are psa8/psa9/psa10 — a shape that cannot
-- represent a Beckett 9.5 at all, which is how a BGS card came to be shown
-- with a PSA figure. Here a Beckett price simply occupies a BGS row, and if we
-- hold no Beckett data for a card there is no row: the query returns nothing,
-- rather than the nearest PSA number wearing a Beckett label.
CREATE TABLE IF NOT EXISTS grade_prices (
  catalog_id     TEXT        NOT NULL,   -- our catalog id, e.g. ex15-100
  grader         TEXT        NOT NULL,   -- PSA | BGS | BVG | BCCG | CGC | SGC | TAG …
  grade          NUMERIC(3,1) NOT NULL,  -- 8, 8.5, 9, 10 — half grades are real
  qualifier      TEXT        NOT NULL DEFAULT '',  -- PSA OC/ST/MK/PD/MC
  label_variant  TEXT        NOT NULL DEFAULT '',  -- black | gold | pristine | gem
  tier           TEXT,                   -- premium | emerging | discount

  price          NUMERIC(12,2),
  sample_size    INTEGER,
  confidence     TEXT,                   -- high | medium | low
  method         TEXT,                   -- how the source computed it
  low            NUMERIC(12,2),
  high           NUMERIC(12,2),
  median         NUMERIC(12,2),          -- unfiltered, for sanity-checking
  currency       CHAR(3)     NOT NULL DEFAULT 'USD',

  source         TEXT        NOT NULL,
  last_sale_at   TIMESTAMPTZ,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- qualifier and label_variant default to '' rather than NULL so the primary
  -- key actually constrains: in Postgres NULL never equals NULL, and a
  -- nullable key column would let duplicate rows accumulate silently.
  PRIMARY KEY (catalog_id, grader, grade, qualifier, label_variant)
);

CREATE INDEX IF NOT EXISTS grade_prices_lookup_idx ON grade_prices (catalog_id, grader);
CREATE INDEX IF NOT EXISTS grade_prices_fetched_idx ON grade_prices (fetched_at DESC);

CREATE INDEX IF NOT EXISTS card_prices_provider_card_id_idx ON card_prices (provider_card_id);
CREATE INDEX IF NOT EXISTS card_prices_name_idx             ON card_prices (lower(card_name));
CREATE INDEX IF NOT EXISTS card_prices_set_number_idx       ON card_prices (lower(set_name), card_number);
CREATE INDEX IF NOT EXISTS card_prices_fetched_at_idx       ON card_prices (fetched_at DESC);
`;

/** Create the schema once per process. Resolves false if the store is unusable. */
export function initStore(): Promise<boolean> {
  ready ??= (async () => {
    const p = getPool();
    if (!p) return false;
    try {
      await p.query(SCHEMA);
      console.log("[store] card_prices ready");
      return true;
    } catch (err) {
      usable = false;
      console.warn(`[store] unavailable, falling back to local cache :: ${(err as Error).message}`);
      return false;
    }
  })();
  return ready;
}

export type StoredCard = {
  /** the provider's full response, as stored */
  payload?: unknown;
  cacheKey: string;
  provider: string;
  providerCardId: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  rarity: string | null;
  imageUrl: string | null;
  rawUsd: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  counts: { psa8: number | null; psa9: number | null; psa10: number | null };
  estimated: boolean;
  isMiss: boolean;
  fetchedAt: Date;
};

const n = (v: unknown): number | null => {
  if (v == null) return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Look a card up. Returns null on miss, on staleness, or on any failure —
 *  every one of those means "go ask the API". */
export async function readCard(
  cacheKey: string,
  maxAgeMs: number,
  missMaxAgeMs: number,
): Promise<StoredCard | null> {
  if (!usable || !(await initStore())) return null;
  const p = getPool();
  if (!p) return null;
  try {
    const { rows } = await p.query(
      `SELECT * FROM card_prices WHERE cache_key = $1 LIMIT 1`,
      [cacheKey],
    );
    const r = rows[0];
    if (!r) return null;
    const age = Date.now() - new Date(r.fetched_at).getTime();
    if (age > (r.is_miss ? missMaxAgeMs : maxAgeMs)) return null;
    return {
      cacheKey: r.cache_key,
      provider: r.provider,
      providerCardId: r.provider_card_id ?? null,
      cardName: r.card_name ?? null,
      setName: r.set_name ?? null,
      cardNumber: r.card_number ?? null,
      rarity: r.rarity ?? null,
      imageUrl: r.image_url ?? null,
      rawUsd: n(r.raw_usd),
      psa8: n(r.psa8),
      psa9: n(r.psa9),
      psa10: n(r.psa10),
      counts: { psa8: n(r.psa8_count), psa9: n(r.psa9_count), psa10: n(r.psa10_count) },
      estimated: Boolean(r.estimated),
      isMiss: Boolean(r.is_miss),
      // The whole provider response, kept so a cache hit is as good as a live
      // call. Without handing it back, a cached card lost every grade outside
      // the three legacy PSA columns — which is most of them.
      payload: r.payload ?? null,
      fetchedAt: new Date(r.fetched_at),
    };
  } catch (err) {
    console.warn(`[store] read failed for "${cacheKey}": ${(err as Error).message}`);
    return null;
  }
}

export type CardWrite = {
  cacheKey: string;
  provider?: string;
  query: { name: string; number?: string | null; set?: string | null };
  providerCardId?: string | null;
  cardName?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  rarity?: string | null;
  imageUrl?: string | null;
  rawUsd?: number | null;
  psa8?: number | null;
  psa9?: number | null;
  psa10?: number | null;
  counts?: { psa8?: number | null; psa9?: number | null; psa10?: number | null };
  spread?: {
    psa8?: { min?: number | null; max?: number | null };
    psa9?: { min?: number | null; max?: number | null };
    psa10?: { min?: number | null; max?: number | null };
  };
  lastSaleDate?: string | null;
  estimated?: boolean;
  isMiss?: boolean;
  payload?: unknown;
};

/** Write what the paid API gave us. Fire-and-forget: never blocks a scan. */
export async function writeCard(c: CardWrite): Promise<void> {
  if (!usable || !(await initStore())) return;
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO card_prices (
         cache_key, provider, query_name, query_number, query_set,
         provider_card_id, card_name, set_name, card_number, rarity, image_url,
         raw_usd, psa8, psa9, psa10,
         psa8_count, psa9_count, psa10_count,
         psa8_min, psa8_max, psa9_min, psa9_max, psa10_min, psa10_max,
         last_sale_date, estimated, is_miss, payload, fetched_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,$9,$10,$11,
         $12,$13,$14,$15,
         $16,$17,$18,
         $19,$20,$21,$22,$23,$24,
         $25,$26,$27,$28, now(), now()
       )
       ON CONFLICT (cache_key) DO UPDATE SET
         provider = excluded.provider,
         provider_card_id = COALESCE(excluded.provider_card_id, card_prices.provider_card_id),
         card_name   = COALESCE(excluded.card_name,   card_prices.card_name),
         set_name    = COALESCE(excluded.set_name,    card_prices.set_name),
         card_number = COALESCE(excluded.card_number, card_prices.card_number),
         rarity      = COALESCE(excluded.rarity,      card_prices.rarity),
         image_url   = COALESCE(excluded.image_url,   card_prices.image_url),
         raw_usd = excluded.raw_usd,
         psa8 = excluded.psa8, psa9 = excluded.psa9, psa10 = excluded.psa10,
         psa8_count = excluded.psa8_count, psa9_count = excluded.psa9_count, psa10_count = excluded.psa10_count,
         psa8_min = excluded.psa8_min, psa8_max = excluded.psa8_max,
         psa9_min = excluded.psa9_min, psa9_max = excluded.psa9_max,
         psa10_min = excluded.psa10_min, psa10_max = excluded.psa10_max,
         last_sale_date = COALESCE(excluded.last_sale_date, card_prices.last_sale_date),
         estimated = excluded.estimated,
         is_miss = excluded.is_miss,
         payload = COALESCE(excluded.payload, card_prices.payload),
         fetched_at = now(),
         updated_at = now()`,
      [
        c.cacheKey,
        c.provider ?? "pokemonpricetracker",
        c.query.name,
        c.query.number ?? null,
        c.query.set ?? null,
        c.providerCardId ?? null,
        c.cardName ?? null,
        c.setName ?? null,
        c.cardNumber ?? null,
        c.rarity ?? null,
        c.imageUrl ?? null,
        c.rawUsd ?? null,
        c.psa8 ?? null,
        c.psa9 ?? null,
        c.psa10 ?? null,
        c.counts?.psa8 ?? null,
        c.counts?.psa9 ?? null,
        c.counts?.psa10 ?? null,
        c.spread?.psa8?.min ?? null,
        c.spread?.psa8?.max ?? null,
        c.spread?.psa9?.min ?? null,
        c.spread?.psa9?.max ?? null,
        c.spread?.psa10?.min ?? null,
        c.spread?.psa10?.max ?? null,
        c.lastSaleDate ?? null,
        c.estimated ?? false,
        c.isMiss ?? false,
        c.payload == null ? null : JSON.stringify(c.payload),
      ],
    );
  } catch (err) {
    console.warn(`[store] write failed for "${c.cacheKey}": ${(err as Error).message}`);
  }
}

export type GradeRow = {
  grader: string;
  grade: number;
  qualifier?: string | null;
  labelVariant?: string | null;
  tier?: string | null;
  price: number | null;
  sampleSize?: number | null;
  confidence?: string | null;
  method?: string | null;
  low?: number | null;
  high?: number | null;
  median?: number | null;
  source: string;
  lastSaleAt?: string | null;
};

/** Persist prices under the composite key. Best-effort like everything here. */
export async function writeGradePrices(
  catalogId: string,
  rows: GradeRow[],
): Promise<void> {
  if (!catalogId || rows.length === 0) return;
  if (!usable || !(await initStore())) return;
  const p = getPool();
  if (!p) return;
  try {
    for (const r of rows) {
      await p.query(
        `INSERT INTO grade_prices (
           catalog_id, grader, grade, qualifier, label_variant, tier,
           price, sample_size, confidence, method, low, high, median,
           source, last_sale_at, fetched_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
         ON CONFLICT (catalog_id, grader, grade, qualifier, label_variant) DO UPDATE SET
           tier = excluded.tier,
           price = excluded.price,
           sample_size = excluded.sample_size,
           confidence = excluded.confidence,
           method = excluded.method,
           low = excluded.low, high = excluded.high, median = excluded.median,
           source = excluded.source,
           last_sale_at = COALESCE(excluded.last_sale_at, grade_prices.last_sale_at),
           fetched_at = now()`,
        [
          catalogId, r.grader, r.grade, r.qualifier ?? "", r.labelVariant ?? "",
          r.tier ?? null, r.price, r.sampleSize ?? null, r.confidence ?? null,
          r.method ?? null, r.low ?? null, r.high ?? null, r.median ?? null,
          r.source, r.lastSaleAt ?? null,
        ],
      );
    }
  } catch (err) {
    console.warn(`[store] grade_prices write failed for ${catalogId}: ${(err as Error).message}`);
  }
}

/** Everything we hold for a card, grouped by the company that graded it.
 *  A grader with no data is simply absent — never substituted. */
export async function readGradePrices(
  catalogId: string,
  maxAgeMs: number,
): Promise<Record<string, Record<string, GradeRow>> | null> {
  if (!catalogId || !usable || !(await initStore())) return null;
  const p = getPool();
  if (!p) return null;
  try {
    const { rows } = await p.query(
      `SELECT * FROM grade_prices
       WHERE catalog_id = $1 AND fetched_at > now() - ($2::bigint * interval '1 millisecond')`,
      [catalogId, Math.round(maxAgeMs)],
    );
    if (rows.length === 0) return null;
    const out: Record<string, Record<string, GradeRow>> = {};
    for (const r of rows) {
      const grader = String(r.grader);
      const grade = String(Number(r.grade));
      (out[grader] ??= {})[grade] = {
        grader,
        grade: Number(r.grade),
        qualifier: r.qualifier || null,
        labelVariant: r.label_variant || null,
        tier: r.tier ?? null,
        price: n(r.price),
        sampleSize: r.sample_size ?? null,
        confidence: r.confidence ?? null,
        method: r.method ?? null,
        low: n(r.low), high: n(r.high), median: n(r.median),
        source: String(r.source),
        lastSaleAt: r.last_sale_at ? new Date(r.last_sale_at).toISOString() : null,
      };
    }
    return out;
  } catch (err) {
    console.warn(`[store] grade_prices read failed for ${catalogId}: ${(err as Error).message}`);
    return null;
  }
}

/** How much of the catalogue we have bought so far — surfaced in /market/quota. */
export async function storeStats(): Promise<{
  configured: boolean;
  online: boolean;
  cards: number | null;
  withGraded: number | null;
}> {
  const configured = storeConfigured();
  if (!configured || !usable || !(await initStore())) {
    return { configured, online: false, cards: null, withGraded: null };
  }
  const p = getPool();
  if (!p) return { configured, online: false, cards: null, withGraded: null };
  try {
    const { rows } = await p.query(
      `SELECT count(*)::int AS cards,
              count(*) FILTER (WHERE NOT is_miss AND psa10 IS NOT NULL)::int AS with_graded
       FROM card_prices`,
    );
    return { configured, online: true, cards: rows[0].cards, withGraded: rows[0].with_graded };
  } catch {
    return { configured, online: false, cards: null, withGraded: null };
  }
}

export const STORE_QUERY_TIMEOUT_MS = QUERY_TIMEOUT_MS;
