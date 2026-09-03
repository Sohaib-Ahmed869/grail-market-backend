// Turning a list of dated prices into something a chart can draw.
//
// Pure, and away from SQL, because the awkward parts are all about missing
// days and small samples — and both are much easier to get right against a
// fixture than against whatever the ingest job happened to write last week.

export type Point = { day: string; price: number; sampleSize?: number | null };

export const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A price for every day in the range, carrying the last known figure forward.
 *
 *  The alternative — a gap — draws a chart that dives to zero every time the
 *  refresh job skipped a card, which is most days for most cards. Carrying
 *  forward says "as far as we know it is still worth this", which is true and
 *  is what the number on the card in the app already claims.
 *
 *  Nothing is carried BACKWARD: before the first observation we knew nothing,
 *  and inventing a flat line there would be inventing history. */
export function fill(points: Point[], from: string, to: string): Point[] {
  const byDay = new Map(points.map((p) => [p.day, p]));
  const out: Point[] = [];
  let last: Point | null = null;
  for (const day of daysBetween(from, to)) {
    const hit = byDay.get(day);
    if (hit) last = hit;
    if (last) out.push({ ...last, day });
  }
  return out;
}

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // A guard rather than a while(true): a bad range should return nothing, not
  // allocate until the process dies.
  for (let i = 0; d <= end && i < 3700; i++) {
    days.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

export type Move = {
  first: number; last: number;
  change: number; changePct: number;
  low: number; high: number;
  days: number;
};

/** What the chart says in words. Null when there is nothing to compare. */
export function movement(points: Point[]): Move | null {
  if (points.length < 2) return null;
  const prices = points.map((p) => p.price);
  const first = prices[0]!;
  const last = prices[prices.length - 1]!;
  return {
    first, last,
    change: last - first,
    // A first price of zero is not a 100% rise, it is missing data.
    changePct: first > 0 ? ((last - first) / first) * 100 : 0,
    low: Math.min(...prices),
    high: Math.max(...prices),
    days: points.length,
  };
}

/** Thin a series to at most `max` points, keeping the ends.
 *
 *  A phone drawing 365 points into 340 pixels is drawing sub-pixel noise. This
 *  keeps the first and last — the two the caption quotes — so the summary and
 *  the picture cannot disagree. */
export function downsample(points: Point[], max = 90): Point[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  // Rounding can land on the same index twice at the ends; keep it honest.
  out[out.length - 1] = points[points.length - 1]!;
  return out;
}

/** A basket, rebased so it starts at 100.
 *
 *  An index of card prices in dollars is dominated by whichever card is most
 *  expensive — one Charizard moving 5% swamps forty cards moving 40%. Rebasing
 *  each series to its own start and then averaging asks the question people
 *  actually mean: is the market up or down. */
export function indexOf(series: Point[][], from: string, to: string): Point[] {
  const filled = series.map((s) => fill(s, from, to)).filter((s) => s.length > 0);
  if (!filled.length) return [];

  const days = daysBetween(from, to);
  const out: Point[] = [];
  for (const day of days) {
    const ratios: number[] = [];
    for (const s of filled) {
      const base = s[0]!.price;
      const hit = s.find((p) => p.day === day);
      if (!hit || base <= 0) continue;
      ratios.push(hit.price / base);
    }
    // A day covered by two cards out of forty is not the market. Below a
    // quarter of the basket the honest answer is no point at all.
    if (ratios.length < Math.max(2, Math.ceil(filled.length / 4))) continue;
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    out.push({ day, price: Math.round(mean * 100 * 100) / 100, sampleSize: ratios.length });
  }
  return out;
}
