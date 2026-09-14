import { storePool } from "../cards.store.js";
import { asEdition, asFinish, asLanguage, type Sku } from "./sku.js";

// The two entities GM001-13 asks to keep apart, and the axes that make a
// catalogue entry a product.
//
// GRADE TIER vs GRADE INSTANCE is the distinction that matters. `grade_prices`
// holds tiers: (card, grader, grade, qualifier, label) with a price on it, and
// there are thousands of cards at PSA 10. A grade INSTANCE is one physical
// slab, identified by the certificate number the company issued to it. A
// population count counts instances. A price describes a tier. Conflating them
// is what let the same cert number sit on two listings with nothing noticing.

export const CATALOG_SCHEMA = `
-- One physical slab. The certificate number is the identity, because that is
-- what the grading company issued and what a buyer can check.
CREATE TABLE IF NOT EXISTS grade_instances (
  grader        TEXT NOT NULL,
  cert_number   TEXT NOT NULL,
  catalog_id    TEXT,
  grade         TEXT,
  qualifier     TEXT NOT NULL DEFAULT '',
  label_variant TEXT NOT NULL DEFAULT '',
  -- the SKU axes as they were on this slab, which is the only place they are
  -- ever certain: the label says what was graded
  language      TEXT,
  edition       TEXT,
  finish        TEXT,
  -- where we saw it, so a second sighting can be reconciled rather than
  -- overwritten
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sightings     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (grader, cert_number)
);
CREATE INDEX IF NOT EXISTS grade_instances_card ON grade_instances (catalog_id, grader, grade);

-- How many of a card exist at each grade, per company. A TIER-level fact:
-- it counts instances but it is not one.
CREATE TABLE IF NOT EXISTS grade_population (
  catalog_id  TEXT NOT NULL,
  grader      TEXT NOT NULL,
  grade       TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT '',
  edition     TEXT NOT NULL DEFAULT '',
  finish      TEXT NOT NULL DEFAULT '',
  count       INTEGER NOT NULL,
  -- higher grades of the same card, which is what "pop 12, 3 higher" means
  higher      INTEGER,
  source      TEXT NOT NULL,
  as_of       DATE,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_id, grader, grade, language, edition, finish)
);
`;

/** Added to catalog_cards, listings and collection so the axes are first-class
 *  rather than parsed out of a name every time they are needed. Appended to
 *  MIGRATIONS, never edited — same rule as cards.store.ts. */
export const CATALOG_MIGRATIONS = [
  `ALTER TABLE catalog_cards ADD COLUMN IF NOT EXISTS language TEXT`,
  `ALTER TABLE catalog_cards ADD COLUMN IF NOT EXISTS edition  TEXT`,
  `ALTER TABLE catalog_cards ADD COLUMN IF NOT EXISTS finish   TEXT`,
  `ALTER TABLE listings      ADD COLUMN IF NOT EXISTS language TEXT`,
  `ALTER TABLE listings      ADD COLUMN IF NOT EXISTS edition  TEXT`,
  `ALTER TABLE listings      ADD COLUMN IF NOT EXISTS finish   TEXT`,
  `ALTER TABLE collection    ADD COLUMN IF NOT EXISTS language TEXT`,
  `ALTER TABLE collection    ADD COLUMN IF NOT EXISTS edition  TEXT`,
  `ALTER TABLE collection    ADD COLUMN IF NOT EXISTS finish   TEXT`,
];

export async function initCatalog(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(CATALOG_SCHEMA);
  for (const m of CATALOG_MIGRATIONS) {
    try {
      await pool.query(m);
    } catch (e) {
      console.warn(`[catalog] migration skipped :: ${(e as Error).message}`);
    }
  }
}

/** Record a slab we have seen.
 *
 *  Upsert on (grader, cert), because seeing the same slab twice is normal —
 *  it gets scanned, listed, sold and scanned again by its new owner. What must
 *  NOT happen is a second row, which would double it in any population count
 *  derived from this table.
 *
 *  Null axes never overwrite known ones: a later sighting that could not read
 *  the edition must not erase an earlier sighting that could. */
export async function recordGradeInstance(i: {
  grader: string;
  certNumber: string;
  catalogId?: string | null;
  grade?: string | null;
  qualifier?: string | null;
  labelVariant?: string | null;
  language?: unknown;
  edition?: unknown;
  finish?: unknown;
}): Promise<boolean> {
  const pool = storePool();
  if (!pool || !i.grader || !i.certNumber) return false;
  try {
    await pool.query(
      `insert into grade_instances
         (grader, cert_number, catalog_id, grade, qualifier, label_variant,
          language, edition, finish)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (grader, cert_number) do update set
         last_seen_at = now(),
         sightings    = grade_instances.sightings + 1,
         catalog_id   = coalesce(excluded.catalog_id, grade_instances.catalog_id),
         grade        = coalesce(excluded.grade,      grade_instances.grade),
         language     = coalesce(excluded.language,   grade_instances.language),
         edition      = coalesce(excluded.edition,    grade_instances.edition),
         finish       = coalesce(excluded.finish,     grade_instances.finish)`,
      [
        i.grader.toUpperCase(), String(i.certNumber), i.catalogId ?? null,
        i.grade == null ? null : String(i.grade),
        i.qualifier ?? "", i.labelVariant ?? "",
        asLanguage(i.language), asEdition(i.edition), asFinish(i.finish),
      ],
    );
    return true;
  } catch (e) {
    console.warn(`[catalog] grade instance not recorded :: ${(e as Error).message}`);
    return false;
  }
}

/** Every slab we have seen carrying this certificate number.
 *
 *  More than one row is impossible by the primary key; more than one LISTING
 *  is not, which is what `admin/repeat.ts` checks. This answers the other
 *  half: have we seen this cert on a different CARD? */
export async function instancesOfCert(grader: string, cert: string) {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select grader, cert_number, catalog_id, grade, language, edition, finish,
            sightings, first_seen_at, last_seen_at
       from grade_instances where grader = $1 and cert_number = $2`,
    [grader.toUpperCase(), cert],
  );
  return r.rows[0] ?? null;
}

export type Population = {
  count: number;
  higher: number | null;
  source: string;
  asOf: string | null;
};

/** Population for one grade tier of one SKU.
 *
 *  Keyed on the SKU axes as well as the grade, because PSA reports Japanese
 *  and English populations separately and adding them together answers a
 *  question nobody asked. */
export async function populationFor(
  sku: Sku,
  grader: string,
  grade: string,
): Promise<Population | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select count, higher, source, as_of from grade_population
      where catalog_id = $1 and grader = $2 and grade = $3
        and language = $4 and edition = $5 and finish = $6`,
    [
      sku.catalogId, grader.toUpperCase(), String(grade),
      sku.language ?? "", sku.edition ?? "", sku.finish ?? "",
    ],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    count: Number(x.count),
    higher: x.higher == null ? null : Number(x.higher),
    source: x.source,
    asOf: x.as_of ? new Date(x.as_of).toISOString().slice(0, 10) : null,
  };
}
