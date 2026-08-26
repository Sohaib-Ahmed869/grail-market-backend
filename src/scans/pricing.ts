import { fetchGradedPrices, gradePointsFromStore, type GradePoint } from "./gradedprices.js";
import { readGradePrices, readRawPrice, writeRawPrice } from "../cards.store.js";

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
