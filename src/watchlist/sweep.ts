import { gradedPricesFor } from "../scans/pricing.js";
import { notify } from "../notifications/store.js";
import { recordPrice, watchedCards } from "./store.js";

export { addWatch, listWatches, removeWatch, setAlert } from "./store.js";

// The sweep: price everything anyone is watching, and tell the people whose
// rule was crossed.
//
// Prices come from the same `gradedPricesFor` the scan path uses — store
// first, provider only on a miss — so a hundred watchers of one card cost one
// lookup, and the sweep cannot quietly become a second, more expensive
// pricing path. Cards are deduplicated before pricing for the same reason.

export type SweepResult = { cards: number; fired: number };

export async function sweep(): Promise<SweepResult> {
  const cards = await watchedCards();
  let fired = 0;

  for (const c of cards) {
    let price: number | null = null;
    try {
      const p = await gradedPricesFor({
        catalogId: c.catalog_id, name: c.card_name,
        number: c.card_number, setName: c.set_name,
      });
      price = c.grader && c.grade
        ? p.byGrader?.[c.grader]?.[String(c.grade)]?.price ?? null
        : p.rawUsd ?? null;
    } catch {
      price = null;
    }
    // No price is not a price of zero. Skipping keeps the baseline intact so
    // the next real reading is measured against the last real one.
    if (price == null || !(price > 0)) continue;

    for (const watchId of c.watch_ids as string[]) {
      const hit = await recordPrice(watchId, price);
      if (!hit) continue;
      fired++;

      const up = hit.pct > 0;
      const grade = hit.grader ? ` ${hit.grader} ${hit.grade ?? ""}`.trim() : "";
      // notify() writes the row and sends the push. It used to do the push
      // here as well, which would have delivered every price alert twice.
      await notify({
        userId: hit.userId, kind: "price",
        title: `${hit.cardName}${grade} ${up ? "up" : "down"} ${Math.abs(hit.pct).toFixed(1)}%`,
        body: `US$${Math.round(hit.from).toLocaleString()} → US$${Math.round(hit.to).toLocaleString()} since we last told you.`,
        href: c.catalog_id ? `/card/${c.catalog_id}` : "/watchlist",
      });

    }
  }

  return { cards: cards.length, fired };
}
