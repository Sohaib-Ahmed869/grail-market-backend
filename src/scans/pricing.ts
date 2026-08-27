import { fetchGradedPrices, gradePointsFromStore, type GradePoint } from "./gradedprices.js";
import { readGradePrices, readRawPrice, writeRawPrice } from "../cards.store.js";
import { priceForGrade, sanityCheck, gradeIsInverted, type LadderResult } from "./ladder.js";

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
      return {
        byGrader,
        byGrade: byGrader.PSA ?? null,
        rawUsd: await readRawPrice(catalogId, STORE_TTL_MS),
        source: "store",
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
  ask?: { median: number | null; count: number; filteredToGrade: boolean } | null,
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
    gradeIsInverted(byGrader[G] ?? {}, grade)
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
