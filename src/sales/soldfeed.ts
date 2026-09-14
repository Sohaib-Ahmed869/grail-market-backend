import { recordSale } from "./ledger.js";
import { demandedCards } from "../scans/demand.js";
import {
  soldComps, theCardApiStatus, type CompTarget, type MatchedSale,
} from "../scans/thecardapi.js";

// Filling the sales ledger from outside our own trades.
//
// `sales/ledger.ts` was written on the assumption that itemised sales are not
// purchasable — "the one source we control completely is our own completed
// trades". That was true of every provider we had: PPT sells per-grade
// rollups, JustTCG sells a trend line, eBay's Marketplace Insights was never
// approved. The Card API sells the rows themselves, so the ledger can now
// fill with market evidence instead of only with our own handful of deals.
//
// Two rules shape everything here, and both come from the house rules rather
// than from anything the provider does:
//
//   The budget is rows per day, so the job spends against the SAME counter a
//   live scan draws from. It therefore reserves a share and stops, in the
//   same spirit as the refresh job reserving a quarter of PPT's credits.
//
//   It runs off request traffic through the maintenance list, never a cron —
//   a scheduled job spends money whether or not anybody opened the app.

/** The share of the day's rows this job may spend. The rest is held for
 *  scans, which are the thing a person is waiting on. */
const JOB_SHARE = 0.5;

/** Rows to examine per card. Low deliberately: the guards reject most of what
 *  a name query returns, but paying for 200 rows to keep 6 is how a row
 *  budget disappears in an afternoon. */
const ROWS_PER_CARD = 20;

/** How far back to ask. The free plan's lookback is three days and a longer
 *  window is silently truncated rather than refused, so asking for more is
 *  not an error — it just costs nothing extra and gets what exists. */
const WINDOW_DAYS = 30;

export type SoldFeedResult = {
  cards: number;
  examined: number;
  recorded: number;
  rejected: number;
  /** cards skipped because the row budget ran out mid-pass */
  skipped: number;
};

/** Pull completed sales for the cards people actually touch, and write the
 *  ones that survive the match guards into the ledger.
 *
 *  Idempotent: the sale id is the provider's, so the same eBay item seen on
 *  five consecutive days is one ledger row, not five. Without that a sample
 *  size — the number the whole confidence model rests on — would grow every
 *  day on no new evidence at all. */
export async function ingestSoldComps(limit = 25): Promise<SoldFeedResult> {
  const out: SoldFeedResult = { cards: 0, examined: 0, recorded: 0, rejected: 0, skipped: 0 };

  const status = theCardApiStatus();
  if (!status.enabled) return out;

  // What is left for this job specifically, not what is left overall.
  let rowsLeft = Math.max(
    0,
    Math.floor(status.dailyRows * JOB_SHARE) - status.rowsUsedToday,
  );
  if (rowsLeft < ROWS_PER_CARD) return out;

  const cards = await demandedCards(limit);
  for (const c of cards) {
    if (rowsLeft < ROWS_PER_CARD) { out.skipped++; continue; }

    const want: CompTarget = {
      catalogId: c.catalogId,
      name: c.name,
      setName: c.setName,
      number: c.number ?? null,
      game: c.game,
    };

    const r = await soldComps(want, { limit: ROWS_PER_CARD, sinceDays: WINDOW_DAYS });
    rowsLeft -= r.examined;
    out.cards++;
    out.examined += r.examined;
    out.rejected += r.rejected;

    for (const s of r.sales) {
      if (await write(want.catalogId, s)) out.recorded++;
    }
  }
  return out;
}

/** One sale, written under its full price key.
 *
 *  `key.grader` null means the guards read the title as a raw card — which is
 *  a real answer and a priceable one, not a failure. What must never happen
 *  is a null grader alongside a non-null grade, and `saleGrade` cannot
 *  produce that pair. */
async function write(catalogId: string, s: MatchedSale): Promise<boolean> {
  try {
    await recordSale({
      // Namespaced, so a provider id can never collide with one of our own
      // trade ids or with a future provider's.
      saleId: `tca:${s.id}`,
      catalogId,
      grader: s.key.grader,
      grade: s.key.grade,
      qualifier: s.key.qualifier,
      labelVariant: s.key.labelVariant,
      price: s.price,
      currency: s.currency,
      soldAt: new Date(s.soldAt),
      source: `thecardapi:${s.platform.toLowerCase()}`,
      sourceUrl: s.url,
      // Stored whole, per invariant 5, so the whole history can be reparsed
      // when the title parser improves — which it will, because the eBay half
      // of this feed is nothing but titles.
      rawTitle: s.title,
    });
    return true;
  } catch (e: any) {
    console.warn(`[soldfeed] ${catalogId} ${s.id}: ${e?.message ?? e}`);
    return false;
  }
}
