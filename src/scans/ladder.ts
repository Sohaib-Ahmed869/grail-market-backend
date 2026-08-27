import type { GradePoint } from "./gradedprices.js";
import { modelPrice, type ModelledPrice } from "./ratio.js";

// What to answer when we hold no sale at the exact (grader, grade) asked for.
//
// The old answer was to reach straight across to PSA, because PSA is where the
// volume is. That is the wrong first move and it is wrong in a specific way: a
// PSA 10 sale is evidence about PSA 10. It is not evidence about a Beckett
// 9.5, and presenting it as one is how a Black Label got quoted at a PSA
// price. We are not a PSA-label company with a Beckett tab; the grader is part
// of the identity of the thing being priced.
//
// So the ladder goes, in order:
//
//   1. The exact key. A sale of this card, at this grade, from this company.
//   2. The SAME grader at neighbouring grades, bracketing where we can. A BGS
//      9 and a BGS 10 say a great deal about a BGS 9.5; they are the same
//      company's scale and the same buyers.
//   3. A MODELLED cross-grader figure, measured from cards where we hold both
//      — never a hand-written multiplier — labelled, with an interval.
//   4. Nothing, said plainly.
//
// Step 2 before step 3 is the whole point. A six-month-old sale from the right
// company beats a fresh one from the wrong company.

export type LadderResult = {
  price: number;
  low: number | null;
  high: number | null;
  sampleSize: number | null;
  confidence: "high" | "medium" | "low";
  /** observed = a real sale at this exact key; the rest are derived */
  basis: "observed" | "same-grader-interpolated" | "same-grader-nearest" | "modelled-cross-grader";
  method: string;
  /** human-readable provenance, for the "how this number was reached" list */
  explain: string;
  /** true when a sanity check failed and this figure should not be presented
   *  as though it were sound */
  suspect?: boolean;
  suspectReason?: string | null;
};

const num = (g: string): number => Number(g);

/** Same grader, nearest grades either side. */
function bracket(
  grades: Record<string, GradePoint>,
  want: number,
): { below: [number, GradePoint] | null; above: [number, GradePoint] | null } {
  let below: [number, GradePoint] | null = null;
  let above: [number, GradePoint] | null = null;
  for (const [k, pt] of Object.entries(grades)) {
    const g = num(k);
    if (!Number.isFinite(g) || pt.price == null) continue;
    if (g < want && (!below || g > below[0])) below = [g, pt];
    if (g > want && (!above || g < above[0])) above = [g, pt];
  }
  return { below, above };
}

export async function priceForGrade(
  byGrader: Record<string, Record<string, GradePoint>>,
  grader: string,
  grade: number,
): Promise<LadderResult | null> {
  const own = byGrader[grader] ?? {};
  const key = String(grade).replace(/\.0$/, "");

  // 1. the exact key
  const exact = own[key];
  if (exact?.price != null) {
    return {
      price: exact.price,
      low: exact.low ?? null,
      high: exact.high ?? null,
      sampleSize: exact.count ?? null,
      confidence: (exact.confidence as LadderResult["confidence"]) ?? "medium",
      basis: "observed",
      method: exact.method ?? "sold-comps",
      explain: `Completed sales of this card at ${grader} ${key}.`,
    };
  }

  // 2. the same grader, either side
  const { below, above } = bracket(own, grade);
  if (below && above) {
    // linear in log space — prices step multiplicatively up a grade ladder,
    // not additively
    const [gLo, ptLo] = below;
    const [gHi, ptHi] = above;
    const t = (grade - gLo) / (gHi - gLo);
    const price = Math.exp(
      Math.log(ptLo.price) * (1 - t) + Math.log(ptHi.price) * t,
    );
    return {
      price,
      low: Math.min(ptLo.price, ptHi.price),
      high: Math.max(ptLo.price, ptHi.price),
      sampleSize: (ptLo.count ?? 0) + (ptHi.count ?? 0) || null,
      confidence: "low",
      basis: "same-grader-interpolated",
      method: `log-interpolated between ${grader} ${gLo} and ${grader} ${gHi}`,
      explain:
        `No recorded sale at ${grader} ${key}. Interpolated between this ` +
        `company's own ${gLo} and ${gHi} sales — the same scale and the same buyers.`,
    };
  }
  if (below || above) {
    const [g, pt] = (below ?? above)!;
    return {
      price: pt.price,
      low: null,
      high: null,
      sampleSize: pt.count ?? null,
      confidence: "low",
      basis: "same-grader-nearest",
      method: `nearest ${grader} grade (${g})`,
      explain:
        `No recorded sale at ${grader} ${key}. Nearest figure we hold from the ` +
        `same company is ${grader} ${g}${g < grade ? ", so this is a floor" : ", so this is a ceiling"}.`,
    };
  }

  // 3. modelled across graders, from whatever we hold most of
  const donors: { grader: string; grade: number; price: number; count: number }[] = [];
  for (const [gr, grades] of Object.entries(byGrader)) {
    if (gr === grader) continue;
    for (const [k, pt] of Object.entries(grades)) {
      if (pt.price == null) continue;
      donors.push({ grader: gr, grade: num(k), price: pt.price, count: pt.count ?? 0 });
    }
  }
  donors.sort((a, b) => b.count - a.count);

  for (const d of donors.slice(0, 6)) {
    const modelled: ModelledPrice | null = await modelPrice(d, { grader, grade });
    if (!modelled) continue;
    return {
      price: modelled.price,
      low: modelled.low,
      high: modelled.high,
      sampleSize: modelled.sampleSize,
      confidence: "low",
      basis: "modelled-cross-grader",
      method: modelled.method,
      explain:
        `We hold no ${grader} sales for this card. Estimated from ${d.grader} ${d.grade} ` +
        `using a ratio measured across ${modelled.sampleSize} cards where we hold both — ` +
        `modelled, not observed.`,
    };
  }

  // 4. nothing
  return null;
}

/** A grade should not be worth less than a lower grade of the same card, and a
 *  cross-grader estimate should sit inside the envelope its neighbours set.
 *
 *  This is the last gate before a number is shown. It does not correct the
 *  figure — a silently corrected number is its own kind of lie — it marks it,
 *  so the interface can decline to lead with it. */
export function sanityCheck(
  result: LadderResult,
  byGrader: Record<string, Record<string, GradePoint>>,
  grader: string,
  grade: number,
): LadderResult {
  if (result.basis === "observed") return result;

  const psa = byGrader.PSA ?? {};
  const psaPrices = Object.entries(psa)
    .filter(([, pt]) => pt.price != null)
    .map(([k, pt]) => ({ grade: num(k), price: pt.price }));
  if (psaPrices.length < 2) return result;

  // The envelope: this card's cheapest and dearest PSA figures, widened. A
  // derived figure landing far outside what the same card does across an
  // entire grade ladder is far more likely to be a broken ratio than a real
  // market fact.
  const lo = Math.min(...psaPrices.map((p) => p.price)) * 0.25;
  const hi = Math.max(...psaPrices.map((p) => p.price)) * 6;
  if (result.price < lo || result.price > hi) {
    return {
      ...result,
      suspect: true,
      suspectReason:
        `Estimate of ${result.price.toFixed(2)} sits outside the ${lo.toFixed(0)}–${hi.toFixed(0)} ` +
        `envelope this card's own grade ladder suggests. Shown as a flag, not a price.`,
    };
  }
  return result;
}


export type Inversion = {
  lower: number;
  higher: number;
  lowerPrice: number;
  higherPrice: number;
};

/** Places where a HIGHER grade is worth LESS than a lower one, same card,
 *  same company.
 *
 *  This is not a market fact. Within one grader's own scale a better card does
 *  not sell for less, so an inversion means the underlying comps are thin,
 *  drawn from different windows, or contaminated. On the Dragon Frontiers Gold
 *  Star, BGS 8.5 came back at $10,500 from 9 sales while BGS 8 came back at
 *  $12,400 from 7 — and the 8.5 is the one people were asking $17,500 to
 *  $30,000 for.
 *
 *  Worth checking precisely because it needs no outside data: the card's own
 *  ladder contradicts itself, and that is visible from the numbers alone.
 */
export function findInversions(grades: Record<string, GradePoint>): Inversion[] {
  const rungs = Object.entries(grades)
    .filter(([, pt]) => pt.price != null)
    .map(([k, pt]) => ({ grade: num(k), price: pt.price }))
    .filter((r) => Number.isFinite(r.grade))
    .sort((a, b) => a.grade - b.grade);

  const out: Inversion[] = [];
  for (let i = 0; i + 1 < rungs.length; i++) {
    const lo = rungs[i];
    const hi = rungs[i + 1];
    // a little tolerance: near-identical figures on adjacent grades are noise,
    // not a contradiction worth shouting about
    if (hi.price < lo.price * 0.95) {
      out.push({
        lower: lo.grade,
        higher: hi.grade,
        lowerPrice: lo.price,
        higherPrice: hi.price,
      });
    }
  }
  return out;
}

/** Does the asking market disagree with the sold comps badly enough to say so?
 *
 *  Asks sit above sold prices normally — that is the whole point of the
 *  distinction and it is stated all over the interface. But when the asks sit
 *  MULTIPLES above, one of two things is true and both matter to a reader: the
 *  market has moved since our comps were gathered, or our comps are not this
 *  card. Neither is served by quietly picking one number. */
export function soldVsAsk(
  sold: number | null | undefined,
  askMedian: number | null | undefined,
): { diverged: boolean; ratio: number | null; note: string | null } {
  if (sold == null || askMedian == null || sold <= 0 || askMedian <= 0) {
    return { diverged: false, ratio: null, note: null };
  }
  const ratio = askMedian / sold;
  if (ratio >= 1.6) {
    return {
      diverged: true,
      ratio,
      note:
        `Sellers are currently asking around ${askMedian.toFixed(0)} while our completed-sale ` +
        `figure is ${sold.toFixed(0)} — ${ratio.toFixed(1)}x. Asks normally sit above sold ` +
        `prices, but not by this much: either the market has moved since these sales, or the ` +
        `sales we hold are not all this exact card.`,
    };
  }
  return { diverged: false, ratio, note: null };
}
