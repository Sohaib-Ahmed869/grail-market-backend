import {
  extrasFromStore, fetchGradedPrices, gradePointsFromStore,
  type GradePoint, type Printings, type SalesVelocity,
} from "./gradedprices.js";
import { readGradePrices, readRawPrice, writeRawPrice } from "../cards.store.js";
import { priceForGrade, sanityCheck, gradeIsInverted, type LadderResult } from "./ladder.js";
import { estimateFromListings, isRefusal } from "./estimate.js";
import type { Listing } from "./ebaylistings.js";

// One way to get a graded price, used by every caller.
//
// A scan and a search that land on the same card must not quote two figures
// for it. They were already sharing the provider adapter, which was enough
// while the provider was the only source — but the moment the store became the
// primary source, only the scan path was taught to read it. That is exactly
// how the two paths drift: same card, one answer from our store and one bought
// live, differing by however much the market moved in between.
//
// So the order lives here, once: our store first, the provider only when the
// store cannot answer.

/** How old a stored price may be before we are willing to buy a fresh one.
 *
 *  Generous on purpose. The refresh job is what keeps prices current now, and
 *  it re-prices a busy card daily; this is the backstop for a card it has not
 *  reached yet. A price from last week WITH ITS AGE SHOWN is a better answer
 *  than a credit spent on the request path, and far better than a blank. */
export const STORE_TTL_MS =
  Number(process.env.PRICE_STORE_TTL_HOURS ?? 24 * 14) * 3600 * 1000;

export type GradedLookup = {
  byGrader: Record<string, Record<string, GradePoint>> | null;
  byGrade: Record<string, GradePoint> | null;
  rawUsd: number | null;
  /** where the answer came from, so callers can label it honestly */
  source: "store" | "provider" | "none";
  /** which printings exist and what each is worth. Holofoil and Reverse
   *  Holofoil are different markets — on one Charizard the reverse is worth
   *  three times the holo — so pricing one as the other is the same class of
   *  error as pricing the wrong set. */
  printings?: Printings;
  /** how often a copy trades. Liquidity is half of what a price means: a card
   *  that sells weekly has a price, one that sold once in a year has an
   *  anecdote, and the same median should be read differently in each. */
  velocity?: SalesVelocity;
};

export async function gradedPricesFor(card: {
  catalogId?: string | null;
  name: string;
  number?: string | null;
  setName?: string | null;
}): Promise<GradedLookup> {
  const catalogId =
    card.catalogId && card.catalogId !== "llm" && card.catalogId !== "described"
      ? card.catalogId
      : null;

  if (catalogId) {
    const held = await readGradePrices(catalogId, STORE_TTL_MS);
    const byGrader = held ? gradePointsFromStore(held) : null;
    if (byGrader) {
      // The ladders come from grade_prices; the printing and the liquidity are
      // in the provider payload behind them. Reading both keeps a store hit as
      // informative as a live one — otherwise the cheap path is also the
      // ignorant one, and it is the path almost every request takes.
      const [rawUsd, extras] = await Promise.all([
        readRawPrice(catalogId, STORE_TTL_MS),
        extrasFromStore(card.name, card.number ?? null, card.setName ?? null),
      ]);
      return {
        byGrader,
        byGrade: byGrader.PSA ?? null,
        rawUsd,
        source: "store",
        printings: extras.printings,
        velocity: extras.velocity,
      };
    }
  }

  const ppt = await fetchGradedPrices(card.name, card.number ?? null, card.setName ?? null);
  // whatever we just paid for, keep — so the next caller reads it for free
  if (catalogId && ppt.rawUsd != null) void writeRawPrice(catalogId, ppt.rawUsd);
  return {
    byGrader: ppt.byGrader ?? null,
    byGrade: ppt.byGrade ?? null,
    rawUsd: ppt.rawUsd ?? null,
    source: ppt.byGrader || ppt.rawUsd != null ? "provider" : "none",
    printings: ppt.printings ?? null,
    velocity: ppt.velocity ?? null,
  };
}


/** The figure for THIS holder: this card, this company, this grade.
 *
 *  Everything the ladder decides passes through here, including the sanity
 *  band, so no caller can accidentally present a modelled figure as a sale.
 *  Returns null when we genuinely cannot say — which is a real answer and the
 *  only honest one when the alternative is a different company's number. */
export async function priceForSlab(
  byGrader: Record<string, Record<string, GradePoint>> | null,
  grader: string | null | undefined,
  grade: number | null | undefined,
  /** The current asking market for the SAME grader and grade, when we have
   *  one that was genuinely filtered to it. */
  ask?: {
    median: number | null;
    count: number;
    filteredToGrade: boolean;
    /** the listings themselves, so the estimator can weigh them individually */
    listings?: Listing[] | null;
    labelTokens?: string[] | null;
  } | null,
): Promise<LadderResult | null> {
  if (!byGrader || !grader || grade == null) return null;
  const G = grader.toUpperCase();
  const r = await priceForGrade(byGrader, G, grade);
  if (!r) return null;

  // A recorded sale normally outranks an asking price, and that rule is right:
  // an ask is what somebody wants, a sale is what somebody paid, and the whole
  // interface is built on the difference.
  //
  // It stops being right when the recorded figure is demonstrably broken. A
  // Dragon Frontiers Gold Star came back at $10,500 for a BGS 8.5 while its
  // own BGS 8 sat at $12,400 — within one company's scale a better card does
  // not sell for less, so that figure is thin or contaminated comps rather
  // than a market fact. Meanwhile three genuine Gold Star BGS 8.5 listings
  // were asking $17,476, $23,302 and $30,000.
  //
  // Preferring a sale we can see is wrong over asks we can see are right is
  // deference to a rule rather than to the evidence. So: only when the sale
  // FAILED a check, only when the asks were filtered to this exact grader and
  // grade, and always labelled as an asking price.
  if (
    r.basis === "observed" &&
    ask?.median != null &&
    ask.filteredToGrade &&
    ask.count >= 2 &&
    gradeIsInverted(byGrader[G] ?? {}, grade) &&
    // The correction has to go the way the fault points.
    //
    // An inversion says this grade is priced too LOW — below the grade
    // beneath it. So a replacement that is lower STILL cannot be the fix; it
    // is a second, larger error arriving to overwrite the first. Without this
    // test the Gold Star's $10,500 BGS 8.5 was replaced by $430, because the
    // ask pool had filled with Charizards from other hundred-card sets and the
    // cheapest of them was an XY Flashfire. A$14,594 became A$379.44 on a card
    // with three genuine listings above A$24,000.
    //
    // A pure direction test, with no threshold to tune: if the asking market
    // does not clear the figure it claims to be correcting, it is not
    // describing this card and we keep the sale, flagged, instead.
    ask.median > r.price
  ) {
    return {
      price: ask.median,
      low: null,
      high: null,
      sampleSize: ask.count,
      confidence: "low",
      basis: "ask-over-suspect-sale",
      method: `median ask, ${ask.count} live ${G} ${grade} listings`,
      explain:
        `Our recorded ${G} ${grade} sales price this below the ${G} grade beneath it, ` +
        `which cannot be right and means those comps are too thin or not all this card. ` +
        `Using the current asking market for ${G} ${grade} instead — ${ask.count} live ` +
        `listings. This is what sellers want, not what one sold for.`,
      suspect: r.suspect,
      suspectReason: r.suspectReason ?? null,
    };
  }

  return sanityCheck(r, byGrader, G, grade);
}

/** What a holder is worth when no sale exists to read.
 *
 *  Deliberately separate from priceForSlab: that walks a ladder of RECORDED
 *  evidence and this does not have any, so keeping them apart stops an
 *  estimate ever being returned wearing the same shape as a sale. See
 *  docs/pricing-algorithm.md for the method and why each choice is made. */
export async function estimateForSlab(
  listings: Listing[],
  opts: {
    grader?: string | null;
    grade?: number | null;
    labelTokens?: string[] | null;
  },
): Promise<LadderResult | null> {
  const out = estimateFromListings(listings, {
    labelTokens: opts.labelTokens ?? null,
    grader: opts.grader ?? null,
    grade: opts.grade ?? null,
  });

  // A refusal is a real answer and travels as one: no price, the range, and
  // the reason. The caller shows the listings underneath it.
  if (isRefusal(out)) return null;

  return {
    price: out.estimate,
    low: out.low,
    high: out.high,
    sampleSize: out.sampleSize,
    confidence: out.confidence >= 4 ? "medium" : "low",
    basis: "estimated-from-listings",
    method: out.method,
    explain: out.explain,
  };
}
