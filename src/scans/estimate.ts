import type { Listing } from "./ebaylistings.js";

// Estimating a price from the live market, when no sale exists to read.
//
// Full reasoning in docs/pricing-algorithm.md. The short version, because the
// three decisions here are the ones that matter:
//
//   Asks sit ABOVE sales, so we take a low quantile rather than the median.
//   An unsold listing is evidence against its own price, so age downweights it.
//   Disagreeing inputs produce NO number, because the alternative is averaging
//   a $4 sleeve with a $94,000 prize card and reporting the mean.
//
// This runs only where we have no sold comp — every game except English
// Pokemon, today. It should be deleted for any market where we get sold data.

export type Weighted = {
  listing: Listing;
  weight: number;
  /** why it weighs what it does, for the audit trail */
  why: { age: number; seller: number; match: number };
};

export type Estimate = {
  estimate: number;
  low: number;
  high: number;
  /** 1-5, Card Ladder's scale: how much a reader should lean on this */
  confidence: 1 | 2 | 3 | 4 | 5;
  sampleSize: number;
  /** the ask-to-sold factor applied, and whether it was measured or assumed */
  askToSold: { factor: number; measured: boolean };
  method: string;
  explain: string;
  /** listings that failed weighting but are worth showing anyway */
  notable: Listing[];
};

export type Refusal = {
  refused: true;
  reason: "too-few" | "too-wide" | "no-product-match";
  low: number | null;
  high: number | null;
  sampleSize: number;
  explain: string;
};

/** Below this a "market" is a couple of people guessing. */
const MIN_LISTINGS = 3;
/** Above this spread the listings are not one product. */
const MAX_SPREAD = 8;
/** Asks are biased high, so the sale sits low in their distribution. */
const QUANTILE = 0.3;
/** Measured, not borrowed.
 *
 *  This started as 0.85, reasoned across from property data where ~84% of
 *  listings sell below asking. It is now 0.83, measured from a backtest of 26
 *  (sold comp, live asks) pairs across six cards and six grading companies —
 *  the median sold price came to 0.827 of the weighted p30 of asks. Close to
 *  the borrowed figure, which is reassuring, but this one is ours.
 *
 *  Still a pool-wide constant rather than a per-card measurement, so callers
 *  are told it is assumed unless they pass a measured factor of their own. */
const ASK_TO_SOLD_PRIOR = 0.83;

/** A fresh listing is a live claim; an old one has been refuted by the market.
 *
 *  Full weight for a fortnight, then a 60-day half-life. Floored rather than
 *  zeroed: a year-old ask is weak evidence, but it is evidence, and what it is
 *  evidence OF is that the price is too high. */
export function ageWeight(ageDays: number | null): number {
  if (ageDays == null) return 0.6; // unknown age: neither fresh nor stale
  if (ageDays <= 14) return 1;
  return Math.max(0.15, Math.pow(0.5, (ageDays - 14) / 60));
}

/** Who is making the claim.
 *
 *  An established account at high feedback is a real offer. A new account
 *  asking five figures is the cheapest thing to produce on the internet, and
 *  weighting it equally is how one fantasy listing moves a valuation. */
export function sellerWeight(pct: number | null, count: number | null): number {
  if (pct == null && count == null) return 0.6; // unknown, not assumed bad
  const p = pct ?? 98;
  const n = count ?? 0;
  if (p < 95) return 0.35;
  // trust grows with volume and flattens: 500 feedbacks and 50,000 are both
  // "established", and pretending otherwise just favours the biggest shops
  const volume = Math.min(1, Math.log10(Math.max(n, 1) + 1) / Math.log10(501));
  return 0.35 + 0.65 * volume;
}

/** Is this even the same product?
 *
 *  A listing that carries the label's own words is the card in hand. One that
 *  merely shares a collector number might be the base print, a sleeve, or a
 *  figurine — this is what separates the $4 result from the $94,000 one. */
export function matchWeight(l: Listing, opts: { labelTokens?: string[] | null }): number {
  const toks = opts.labelTokens ?? [];
  if (toks.length === 0) return 1; // nothing to match on; do not punish
  const t = l.title.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return toks.some((k) => k.length >= 6 && t.includes(k)) ? 1 : 0.45;
}

function weightedQuantile(items: { v: number; w: number }[], q: number): number {
  const s = [...items].sort((a, b) => a.v - b.v);
  const total = s.reduce((a, x) => a + x.w, 0);
  if (total <= 0) return s[Math.floor(s.length * q)]?.v ?? 0;
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total * q) return x.v;
  }
  return s[s.length - 1].v;
}

export function weighListings(
  listings: Listing[],
  opts: { labelTokens?: string[] | null } = {},
): Weighted[] {
  return listings
    .filter((l) => l.price != null && l.price > 0)
    .map((l) => {
      const why = {
        age: ageWeight(l.ageDays),
        seller: sellerWeight(l.sellerFeedbackPct ?? null, l.sellerFeedbackCount ?? null),
        match: matchWeight(l, opts),
      };
      return { listing: l, weight: why.age * why.seller * why.match, why };
    });
}

/** Estimate what this card is worth from what is currently listed, or refuse.
 *
 *  Refusing is a real outcome and not a failure: the caller shows the listings
 *  and the range instead, which is more use than an average of things that are
 *  not the same object. */
export function estimateFromListings(
  listings: Listing[],
  opts: {
    labelTokens?: string[] | null;
    /** measured where we hold both a sale and asks for the same key */
    askToSold?: { factor: number; measured: boolean } | null;
    grader?: string | null;
    grade?: number | null;
  } = {},
): Estimate | Refusal {
  const weighted = weighListings(listings, opts);
  // Above the age floor, not above it plus a margin. ageWeight() bottoms out
  // at 0.15 deliberately, so that a year-old ask still counts a little — and a
  // cut at 0.2 discarded exactly those, which made the floor dead code and
  // meant a card whose every listing was stale produced no estimate rather
  // than a low-confidence one.
  const usable = weighted.filter((w) => w.weight >= 0.1);
  const prices = usable.map((w) => ({ v: w.listing.price as number, w: w.weight }));

  const label =
    opts.grader && opts.grade != null ? `${opts.grader} ${opts.grade}` : "this card";

  if (prices.length < MIN_LISTINGS) {
    const all = weighted.map((w) => w.listing.price as number).sort((a, b) => a - b);
    return {
      refused: true,
      reason: "too-few",
      low: all[0] ?? null,
      high: all[all.length - 1] ?? null,
      sampleSize: prices.length,
      explain:
        `Only ${prices.length} usable listing${prices.length === 1 ? "" : "s"} for ${label}. ` +
        `That is an anecdote rather than a market, so we are not turning it into a price.`,
    };
  }

  const p10 = weightedQuantile(prices, 0.1);
  const p90 = weightedQuantile(prices, 0.9);
  const spread = p10 > 0 ? p90 / p10 : Infinity;
  if (spread > MAX_SPREAD) {
    return {
      refused: true,
      reason: "too-wide",
      low: p10,
      high: p90,
      sampleSize: prices.length,
      explain:
        `Listings for ${label} run from ${p10.toFixed(0)} to ${p90.toFixed(0)} — ` +
        `${spread.toFixed(0)}x. A spread that wide almost always means several different ` +
        `versions share this card's name, and averaging them would describe none of them. ` +
        `The listings below are the honest answer.`,
    };
  }

  const anchor = weightedQuantile(prices, QUANTILE);
  const ratio = opts.askToSold ?? { factor: ASK_TO_SOLD_PRIOR, measured: false };
  const estimate = anchor * ratio.factor;

  // Recency and sample size decide how much to lean on this, which is what
  // Card Ladder's meter is for and why it is worth copying.
  const freshest = Math.min(...usable.map((w) => w.listing.ageDays ?? 999));
  let confidence: Estimate["confidence"] = 2;
  if (prices.length >= 8 && freshest <= 30 && ratio.measured) confidence = 4;
  else if (prices.length >= 5 && freshest <= 60) confidence = 3;
  if (prices.length >= 12 && freshest <= 14 && ratio.measured && spread < 3) confidence = 5;
  if (prices.length < 4 || freshest > 180) confidence = 1;

  // Extremes are shown, never deleted. The dearest listing is often the only
  // one that is actually the card in hand.
  const sorted = [...weighted].sort(
    (a, b) => (b.listing.price ?? 0) - (a.listing.price ?? 0),
  );
  const notable = sorted
    .filter((w) => (w.listing.price ?? 0) > anchor * 3)
    .slice(0, 3)
    .map((w) => w.listing);

  return {
    estimate,
    low: weightedQuantile(prices, 0.15) * ratio.factor,
    high: weightedQuantile(prices, 0.6) * ratio.factor,
    confidence,
    sampleSize: prices.length,
    askToSold: ratio,
    method:
      `weighted p${QUANTILE * 100} of ${prices.length} asks × ${ratio.factor.toFixed(2)} ` +
      `ask-to-sold (${ratio.measured ? "measured" : "assumed"})`,
    explain:
      `No completed sale for ${label}, so this is estimated from ${prices.length} live ` +
      `listings — weighted so that fresh listings from established sellers count for more ` +
      `than old ones, and taken from the low end because asking prices sit above what ` +
      `cards actually sell for.`,
    notable,
  };
}

export const isRefusal = (r: Estimate | Refusal): r is Refusal =>
  (r as Refusal).refused === true;
