import { storePool } from "../cards.store.js";
import { downsample, fill, indexOf, iso, movement, type Point } from "./series.js";

// Reading the time series. Everything here is a read over price_points, which
// is written by the one funnel every price passes through — see
// writeGradePrices in cards.store.ts.

const dayOffset = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return iso(d);
};

export type History = {
  points: Point[];
  movement: ReturnType<typeof movement>;
  from: string; to: string;
  /** How many days we actually observed, as against how many we drew. A
   *  90-day line built from four observations is a different claim from one
   *  built from ninety, and the caller should be able to say so. */
  observed: number;
};

/** One card, one grader, one grade. The composite key, as always — there is
 *  no grade-only series here any more than there is a grade-only price. */
export async function cardHistory(k: {
  catalogId: string; grader: string; grade: number;
  qualifier?: string | null; labelVariant?: string | null; days?: number;
}): Promise<History | null> {
  const pool = storePool();
  if (!pool) return null;
  const days = Math.min(Math.max(k.days ?? 90, 7), 730);
  const from = dayOffset(days);
  const to = iso(new Date());

  const r = await pool.query(
    `select to_char(day, 'YYYY-MM-DD') as day, price, sample_size
       from price_points
      where catalog_id = $1 and grader = $2 and grade = $3
        and qualifier = $4 and label_variant = $5
        and day >= $6::date
      order by day`,
    [k.catalogId, k.grader.toUpperCase(), k.grade,
     k.qualifier ?? "", k.labelVariant ?? "", from],
  );
  const raw: Point[] = r.rows.map((x) => ({
    day: x.day, price: Number(x.price), sampleSize: x.sample_size ?? null,
  }));
  if (!raw.length) return null;

  const filled = fill(raw, raw[0]!.day, to);
  return {
    points: downsample(filled),
    movement: movement(filled),
    from: raw[0]!.day, to,
    observed: raw.length,
  };
}

/** The market as one line.
 *
 *  The basket is the cards we have the most history for, which is a proxy for
 *  the cards that get traded — a card nobody looks at is a card the refresh
 *  job deprioritises, so it drops out on its own without a hand-kept list.
 *  PSA 10 only, because mixing graders and grades into one index would be
 *  averaging things that are not the same product. */
export async function marketIndex(days = 90, basketSize = 40): Promise<{
  points: Point[]; basket: number; from: string; to: string;
} | null> {
  const pool = storePool();
  if (!pool) return null;
  const from = dayOffset(Math.min(Math.max(days, 7), 730));
  const to = iso(new Date());

  const picks = await pool.query(
    `select catalog_id, count(*) as n
       from price_points
      where grader = 'PSA' and grade = 10 and day >= $1::date
      group by catalog_id
      having count(*) >= 2
      order by n desc
      limit $2`,
    [from, basketSize],
  );
  if (!picks.rows.length) return null;

  const ids = picks.rows.map((r) => r.catalog_id);
  const r = await pool.query(
    `select catalog_id, to_char(day, 'YYYY-MM-DD') as day, price
       from price_points
      where grader = 'PSA' and grade = 10 and day >= $2::date
        and catalog_id = any($1::text[])
      order by day`,
    [ids, from],
  );

  const byCard = new Map<string, Point[]>();
  for (const row of r.rows) {
    const list = byCard.get(row.catalog_id) ?? [];
    list.push({ day: row.day, price: Number(row.price) });
    byCard.set(row.catalog_id, list);
  }

  const points = indexOf([...byCard.values()], from, to);
  return points.length ? { points: downsample(points), basket: byCard.size, from, to } : null;
}

/** What a collection has been worth, day by day.
 *
 *  Computed rather than stored. A stored daily snapshot per member would be a
 *  row per person per day forever, and it would be wrong the moment somebody
 *  added a card they have owned for a year — this way the past redraws with
 *  what we now know, which is the honest answer to "what was it worth then".
 *
 *  Holdings acquired later do not appear earlier: `added_at` bounds each one,
 *  so the line does not claim you owned something before you did. */
export async function collectionHistory(userId: string, days = 90): Promise<{
  points: Point[]; movement: ReturnType<typeof movement>;
  from: string; to: string; priced: number; total: number;
} | null> {
  const pool = storePool();
  if (!pool) return null;
  const window = Math.min(Math.max(days, 7), 730);
  const from = dayOffset(window);
  const to = iso(new Date());

  const held = await pool.query(
    `select catalog_id, grader, grade, coalesce(quantity, 1) as quantity,
            to_char(added_at, 'YYYY-MM-DD') as added_day
       from collection
      where user_id = $1 and catalog_id is not null and grader is not null`,
    [userId],
  );
  const total = held.rows.length;
  if (!total) return null;

  const series = await Promise.all(
    held.rows.map(async (h) => {
      const r = await pool.query(
        `select to_char(day, 'YYYY-MM-DD') as day, price
           from price_points
          where catalog_id = $1 and grader = $2 and grade = $3 and day >= $4::date
          order by day`,
        [h.catalog_id, String(h.grader).toUpperCase(), h.grade, from],
      );
      if (!r.rows.length) return null;
      const raw: Point[] = r.rows.map((x) => ({ day: x.day, price: Number(x.price) }));
      // Never before it was acquired, and never before we first saw a price.
      const start = h.added_day > raw[0]!.day ? h.added_day : raw[0]!.day;
      const qty = Number(h.quantity) || 1;
      return fill(raw, start, to).map((p) => ({ ...p, price: p.price * qty }));
    }),
  );

  const live = series.filter((s): s is Point[] => s != null && s.length > 0);
  if (!live.length) return null;

  const byDay = new Map<string, number>();
  for (const s of live) for (const p of s) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.price);

  const points = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, price]) => ({ day, price: Math.round(price * 100) / 100 }));

  return {
    points: downsample(points),
    movement: movement(points),
    from: points[0]?.day ?? from, to,
    priced: live.length,
    total,
  };
}
