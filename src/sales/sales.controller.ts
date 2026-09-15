import { Controller, Get, Query } from "@nestjs/common";
import { countSales, recentSales, salesSince } from "./ledger.js";
import { salesWindows, type SalesWindows } from "../history/windows.js";
import { dailyPricesFor } from "../history/store.js";
import { TtlCache } from "../scans/ttlcache.js";

/** Windows per key, briefly. A card page asks again on every grade switch and
 *  a sale lands at most a few times a day, so five minutes costs nothing in
 *  freshness and saves two queries per tap. */
const windowCache = new TtlCache<SalesWindows>(5 * 60_000, 2_000);
import { guidanceKey, hasGuidance, listingGuidance } from "./guidance.js";
import { fxRates } from "../scans/fx.js";
import { gradedPricesFor } from "../scans/pricing.js";

@Controller("market")
export class SalesController {
  /** The confirmed sales behind a price.
   *
   *  Two numbers, and they are not the same. `itemised` is what we can show a
   *  person — real rows, with a date and a source. `known` is how many sales
   *  the price provider counted, which is usually larger because it reports a
   *  rollup and sells no itemisation at any price.
   *
   *  Saying both is the honest shape. A screen that shows five rows and calls
   *  them "the last five of twenty-three" when it only holds two is inventing
   *  three sales, and this is the one figure a member will check against
   *  reality before parting with a thousand dollars. */
  @Get("sales")
  async sales(
    @Query("cardId") cardId?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
    @Query("name") name?: string,
    @Query("number") number?: string,
    @Query("set") setName?: string,
  ) {
    if (!cardId) return { error: "cardId required", sales: [], itemised: 0, known: null };

    const g = grader ? grader.toUpperCase() : null;
    const gr = grade ? String(grade).replace(/\.0$/, "") : null;

    const [sales, itemised] = await Promise.all([
      recentSales(cardId, g, gr, 5),
      countSales(cardId, g, gr),
    ]);

    // What the provider counted, for the same key. Read from our own store, so
    // this costs nothing and cannot be a surprise bill.
    let known: number | null = null;
    let lastSaleAt: string | null = null;
    let aggregate: {
      price: number | null; median: number | null; low: number | null;
      high: number | null; confidence: string | null; asOf: string | null;
    } | null = null;
    try {
      const p = await gradedPricesFor({
        catalogId: cardId, name: name ?? "", number: number ?? null, setName: setName ?? null,
      });
      // Read the fields GradePoint actually has. These were `as any` casts on
      // `sampleSize` and `lastSaleAt`, and GradePoint calls them `count` and
      // `lastSaleDate` — so both were silently undefined and the panel said
      // "no itemised sale on record" while the store held nine of them. A cast
      // is how a rename stops being a compile error and starts being a blank
      // screen.
      const point = g && gr ? p.byGrader?.[g]?.[gr] ?? null : null;
      known = point?.count ?? null;
      lastSaleAt = point?.lastSaleDate ?? null;
      // The evidence BEHIND those sales, not just how many there were.
      //
      // Without it the screen could only say "no itemised sale on record" —
      // while the block above it said "middle of 9 completed sales". Both were
      // reading the same card and only one of them was telling the truth. We
      // cannot list the nine rows, but we can say what they add up to, and
      // that is a world away from claiming there are none.
      if (point) {
        aggregate = {
          price: point.price ?? null,
          median: point.median ?? null,
          low: point.low ?? null,
          high: point.high ?? null,
          confidence: point.confidence ?? null,
          asOf: point.asOf ?? null,
        };
      }
    } catch {
      // a missing price is not a reason to withhold the sales we do hold
    }

    return {
      sales,
      itemised,
      known,
      lastSaleAt,
      aggregate,
      // Said plainly rather than left for the client to infer from two numbers.
      note:
        known != null && known > itemised
          ? `We can itemise ${itemised} of ${known} recorded sales. Our price source reports totals, not individual sales.`
          : null,
    };
  }

  /** What to list this card for, from settled sales only.
   *
   *  The rule is the client's, recorded on GM001-59: settled sales rather than
   *  asking prices, the three most recent PROVIDED they sit close together in
   *  time, and a recommended range the seller may list above or below. The
   *  refusals matter as much as the figures — "too-spread" and "too-few" are
   *  answers, and a seller told plainly that we cannot advise is better served
   *  than one handed a number built from a sale in February.
   *
   *  Keyed on (card, grader, grade) in full, per invariant 1. There is no
   *  grade-only guidance because there is no grade-only price.
   */
  /** Last sale, 7-day and 30-day figures for one exact card, grader and
   *  grade, from our own sales ledger and daily prices — GM001-28.
   *
   *  `grader=RAW` means ungraded only; a missing grader or grade is refused,
   *  the same key rule as `/market/guidance`. Every figure carries its count
   *  and confidence; a window without enough sales says so instead of
   *  printing a number. See history/windows.ts for the rules. */
  @Get("windows")
  async windows(
    @Query("cardId") cardId?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
  ) {
    if (!cardId) return { error: "invalid", message: "cardId required" };
    const key = guidanceKey(grader, grade);
    if (!key) return { error: "invalid", message: "grader and grade required, or grader=RAW" };
    const cacheKey = `${cardId}|${key.rawOnly ? "RAW" : `${key.grader}|${key.grade}`}`;
    const hit = windowCache.get(cacheKey);
    if (hit) return { key: { cardId, grader: key.rawOnly ? "RAW" : key.grader, grade: key.grade }, windows: hit };

    // 60 days of sales: the 30-day window and the 30 days before it, which
    // its change is measured against. 45 days of prices for daily30.
    const [sales, points, fx] = await Promise.all([
      salesSince(cardId, key.grader, key.grade, 60, { rawOnly: key.rawOnly }),
      dailyPricesFor(cardId, key, 45),
      fxRates(),
    ]);
    const out = salesWindows(sales, points, fx);
    windowCache.set(cacheKey, out);
    return { key: { cardId, grader: key.rawOnly ? "RAW" : key.grader, grade: key.grade }, windows: out };
  }

  @Get("guidance")
  async guidance(
    @Query("cardId") cardId?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
    @Query("currency") currency?: string,
  ) {
    if (!cardId) return { error: "invalid", message: "cardId required" };
    // A grader and grade, or RAW. Nothing else is a key — see guidanceKey.
    const key = guidanceKey(grader, grade);
    if (!key) return { error: "invalid", message: "grader and grade required, or grader=RAW" };

    // Asked for more than the three the rule uses, so that a set rejected for
    // being too spread can still report what was there, and so the outlier
    // check has something to compare against.
    const sales = await recentSales(cardId, key.grader, key.grade, 10, { rawOnly: key.rawOnly });
    const fx = await fxRates();
    const out = listingGuidance(sales, fx, currency ?? "AUD");
    return hasGuidance(out) ? { guidance: out } : { guidance: null, ...out };
  }
}
