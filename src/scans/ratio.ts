import { storePool, initStore } from "../cards.store.js";

// Cross-grader ratios, MEASURED.
//
// The rule this exists to satisfy is invariant 2: cross-grader ratios may be
// used only as an explicitly labelled low-confidence fallback, and must be
// measured from our own sales data, never hand-written. A hand-written ratio
// is the thing that turns a $13,000 card into $1,700 — the published rule of
// thumb for Black Label is "30-60% over PSA 10", and the card that prompted
// all of this trades at eleven times PSA 10.
//
// Method, and why each piece is there:
//
//   LOG SPACE. Prices are multiplicative. The mean of 0.5x and 2x is 1x, not
//   1.25x, and only logs give you that.
//
//   MEDIAN, not mean. One mistitled listing or one lot sale sits in the
//   sample at full weight. A median ignores it; a mean does not.
//
//   SHRINKAGE. With eight overlapping cards, the per-pair estimate is mostly
//   noise. Shrinking it toward the pooled estimate for the same grader pair
//   (empirical Bayes, the James-Stein idea) trades a little bias for a lot of
//   variance, which is the right trade when a wrong number moves money. As
//   the sample grows the estimate is allowed to speak for itself.
//
//   AN INTERVAL, never a point. A number with no spread reads as a fact.
//   These are estimates and they must arrive looking like estimates.

export type RatioEstimate = {
  from: { grader: string; grade: number };
  to: { grader: string; grade: number };
  /** price(to) ≈ price(from) × factor */
  factor: number;
  low: number;
  high: number;
  /** cards that had BOTH figures and so contributed to the estimate */
  sampleSize: number;
  /** 1 = the pair's own data decided it, 0 = fully shrunk to the pooled prior */
  weight: number;
  method: string;
};

/** How much data a pair needs before it outweighs the pooled prior.
 *  At n = k the estimate is half its own, half the prior. */
const SHRINK_K = Number(process.env.RATIO_SHRINK_K ?? 8);
/** Below this we will not offer a ratio at all — two cards is an anecdote. */
const MIN_SAMPLE = Number(process.env.RATIO_MIN_SAMPLE ?? 4);

const ln = Math.log;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation, scaled to be comparable to a standard deviation
 *  on normal data. Robust where a standard deviation is not: one outlier moves
 *  an SD a long way and a MAD barely at all. */
function madSd(xs: number[], centre: number): number {
  if (xs.length < 2) return 0;
  return 1.4826 * median(xs.map((x) => Math.abs(x - centre)));
}

type Pair = { catalogId: string; fromPrice: number; toPrice: number };

async function pairsFor(
  from: { grader: string; grade: number },
  to: { grader: string; grade: number },
): Promise<Pair[]> {
  if (!(await initStore())) return [];
  const p = storePool();
  if (!p) return [];
  try {
    const { rows } = await p.query(
      `SELECT a.catalog_id, a.price AS from_price, b.price AS to_price
         FROM grade_prices a
         JOIN grade_prices b USING (catalog_id)
        WHERE a.grader = $1 AND a.grade = $2
          AND b.grader = $3 AND b.grade = $4
          AND a.price > 0 AND b.price > 0
          -- a figure drawn from one or two sales is not evidence about a
          -- ratio, whatever it is evidence about
          AND COALESCE(a.sample_size, 0) >= 3
          AND COALESCE(b.sample_size, 0) >= 3`,
      [from.grader, from.grade, to.grader, to.grade],
    );
    return rows.map((r: any) => ({
      catalogId: String(r.catalog_id),
      fromPrice: Number(r.from_price),
      toPrice: Number(r.to_price),
    }));
  } catch {
    return [];
  }
}

/** The pooled log ratio for a grader pair across ALL grades.
 *
 *  The prior a thin pair shrinks toward. It is deliberately coarse — it says
 *  "this is roughly what Beckett does to a PSA price in general" — because a
 *  coarse answer from a lot of data beats a sharp one from eight cards. */
async function pooledPrior(fromGrader: string, toGrader: string): Promise<number | null> {
  if (!(await initStore())) return null;
  const p = storePool();
  if (!p) return null;
  try {
    const { rows } = await p.query(
      `SELECT a.price AS from_price, b.price AS to_price
         FROM grade_prices a
         JOIN grade_prices b USING (catalog_id)
        WHERE a.grader = $1 AND b.grader = $2
          AND a.price > 0 AND b.price > 0
          AND COALESCE(a.sample_size, 0) >= 3
          AND COALESCE(b.sample_size, 0) >= 3
          -- compare like with like: an 8 against a 10 says nothing about the
          -- GRADER, only about the grade
          AND a.grade = b.grade`,
      [fromGrader, toGrader],
    );
    if (rows.length < MIN_SAMPLE) return null;
    return median(rows.map((r: any) => ln(Number(r.to_price) / Number(r.from_price))));
  } catch {
    return null;
  }
}

/** Estimate price(to) / price(from) from cards where we hold both.
 *  Returns null when there is not enough to say anything honest. */
export async function estimateRatio(
  from: { grader: string; grade: number },
  to: { grader: string; grade: number },
): Promise<RatioEstimate | null> {
  const pairs = await pairsFor(from, to);
  if (pairs.length < MIN_SAMPLE) return null;

  const logs = pairs.map((p) => ln(p.toPrice / p.fromPrice));
  const own = median(logs);
  const sd = madSd(logs, own);
  const n = logs.length;

  // shrink toward what this grader pair does in general
  const prior = (await pooledPrior(from.grader, to.grader)) ?? 0;
  const weight = n / (n + SHRINK_K);
  const centre = weight * own + (1 - weight) * prior;

  // Standard error of the median, widened by how much we had to lean on the
  // prior. A heavily shrunk estimate is a guess wearing a number, and the
  // interval is where that has to show.
  const se = n > 1 ? (1.2533 * sd) / Math.sqrt(n) : Math.abs(own) || 0.5;
  const spread = 1.96 * se + (1 - weight) * 0.35;

  return {
    from,
    to,
    factor: Math.exp(centre),
    low: Math.exp(centre - spread),
    high: Math.exp(centre + spread),
    sampleSize: n,
    weight,
    method: `log-median-shrunk(k=${SHRINK_K}) n=${n}`,
  };
}

export type ModelledPrice = {
  price: number;
  low: number;
  high: number;
  sampleSize: number;
  /** the figure this was derived FROM, so the chain is auditable */
  basis: { grader: string; grade: number; price: number };
  method: string;
  confidence: "low";
};

/** Price a (grader, grade) we hold nothing for, from one we do.
 *
 *  Always low confidence, always an interval, always labelled with what it was
 *  derived from. The alternative on offer was printing a PSA number under a
 *  Beckett badge with no marking at all. */
export async function modelPrice(
  basis: { grader: string; grade: number; price: number },
  want: { grader: string; grade: number },
): Promise<ModelledPrice | null> {
  const r = await estimateRatio(
    { grader: basis.grader, grade: basis.grade },
    want,
  );
  if (!r) return null;
  return {
    price: basis.price * r.factor,
    low: basis.price * r.low,
    high: basis.price * r.high,
    sampleSize: r.sampleSize,
    basis,
    method: r.method,
    confidence: "low",
  };
}
