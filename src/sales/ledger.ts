import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// Individual completed sales — one row per sale, never an average.
//
// Append-only, per invariant 5: never UPDATE, never DELETE. raw_title and
// parser_version are stored beside every row so the whole history can be
// reparsed when the parser improves, rather than being frozen at whatever we
// understood on the day it arrived.
//
// This exists because the price providers do not sell it. PokemonPriceTracker
// returns per-grade rollups — count, median, min, max, a last-sale date — and
// no itemised sales at all. So a screen promising "the last five confirmed
// sales, with dates and where they sold" cannot be filled from a provider; it
// has to be accumulated, and the one source we control completely is our own
// completed trades.

export const SALES_SCHEMA = `
CREATE TABLE IF NOT EXISTS sales_ledger (
  sale_id        text PRIMARY KEY,
  catalog_id     text NOT NULL,
  grader         text,
  grade          text,
  qualifier      text,
  label_variant  text,
  price          numeric NOT NULL,
  currency       text NOT NULL DEFAULT 'USD',
  sold_at        timestamptz NOT NULL,
  source         text NOT NULL,
  source_url     text,
  raw_title      text,
  parser_version text NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_ledger_key
  ON sales_ledger (catalog_id, grader, grade, sold_at DESC);
CREATE INDEX IF NOT EXISTS sales_ledger_source ON sales_ledger (source, sold_at DESC);
`;

/** Bumped whenever the parsing of a raw title changes meaning. Stored per row
 *  so a later version can find and reinterpret what an earlier one wrote. */
export const PARSER_VERSION = "1";

export async function initSales(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(SALES_SCHEMA);
}

export type Sale = {
  saleId: string;
  catalogId: string;
  grader: string | null;
  grade: string | null;
  price: number;
  currency: string;
  soldAt: string;
  source: string;
  sourceUrl: string | null;
  rawTitle: string | null;
};

/** Record one completed sale.
 *
 *  Deliberately has no update sibling. A sale that was wrong is corrected by
 *  recording the correction, not by editing history — which is what makes the
 *  ledger answerable when somebody disputes a price months later. */
export async function recordSale(s: {
  catalogId: string;
  grader?: string | null;
  grade?: string | number | null;
  qualifier?: string | null;
  labelVariant?: string | null;
  price: number;
  currency?: string;
  soldAt: Date;
  source: string;
  sourceUrl?: string | null;
  rawTitle?: string | null;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const saleId = randomUUID();
  await pool.query(
    `insert into sales_ledger
       (sale_id, catalog_id, grader, grade, qualifier, label_variant,
        price, currency, sold_at, source, source_url, raw_title, parser_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      saleId, s.catalogId, s.grader ?? null,
      s.grade == null ? null : String(s.grade),
      s.qualifier ?? null, s.labelVariant ?? null,
      s.price, s.currency ?? "USD", s.soldAt, s.source,
      s.sourceUrl ?? null, s.rawTitle ?? null, PARSER_VERSION,
    ],
  );
  return saleId;
}

/** The most recent confirmed sales for one exact key.
 *
 *  Keyed on (catalog_id, grader, grade) per invariant 1 — there is no
 *  grade-only lookup, and a PSA 9 never answers for a BGS 9. */
export async function recentSales(
  catalogId: string,
  grader: string | null,
  grade: string | null,
  limit = 5,
): Promise<Sale[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select sale_id, catalog_id, grader, grade, price::float, currency,
            sold_at, source, source_url, raw_title
       from sales_ledger
      where catalog_id = $1
        and ($2::text is null or grader = $2)
        and ($3::text is null or grade  = $3)
      order by sold_at desc
      limit $4`,
    [catalogId, grader, grade, Math.min(limit, 50)],
  );
  return r.rows.map((x: any) => ({
    saleId: x.sale_id, catalogId: x.catalog_id, grader: x.grader, grade: x.grade,
    price: x.price, currency: x.currency, soldAt: x.sold_at,
    source: x.source, sourceUrl: x.source_url, rawTitle: x.raw_title,
  }));
}

export async function countSales(
  catalogId: string, grader: string | null, grade: string | null,
): Promise<number> {
  const pool = storePool();
  if (!pool) return 0;
  const r = await pool.query(
    `select count(*)::int n from sales_ledger
      where catalog_id = $1
        and ($2::text is null or grader = $2)
        and ($3::text is null or grade  = $3)`,
    [catalogId, grader, grade],
  );
  return r.rows[0]?.n ?? 0;
}
