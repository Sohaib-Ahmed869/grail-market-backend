import { Controller, Get, Query } from "@nestjs/common";
import { countSales, recentSales } from "./ledger.js";
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
    } catch {
      // a missing price is not a reason to withhold the sales we do hold
    }

    return {
      sales,
      itemised,
      known,
      lastSaleAt,
      // Said plainly rather than left for the client to infer from two numbers.
      note:
        known != null && known > itemised
          ? `We can itemise ${itemised} of ${known} recorded sales. Our price source reports totals, not individual sales.`
          : null,
    };
  }
}
