import { gradedPricesFor } from "../scans/pricing.js";
import { send } from "../push/expo.js";
import { tokensFor } from "../push/store.js";
import { recordPrice, watchedCards } from "./store.js";

export { addWatch, listWatches, removeWatch, setAlert } from "./store.js";

// The sweep: price everything anyone is watching, and tell the people whose
// rule was crossed.
//
// Prices come from the same `gradedPricesFor` the scan path uses — store
// first, provider only on a miss — so a hundred watchers of one card cost one
// lookup, and the sweep cannot quietly become a second, more expensive
// pricing path. Cards are deduplicated before pricing for the same reason.

export type SweepResult = { cards: number; fired: number; sent: number; dropped: number };

export async function sweep(): Promise<SweepResult> {
  const cards = await watchedCards();
  const messages: { to: string; title: string; body: string; data: Record<string, unknown> }[] = [];
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
      const tokens = await tokensFor(hit.userId);
      for (const to of tokens) {
        messages.push({
          to,
          title: `${hit.cardName}${grade} ${up ? "up" : "down"} ${Math.abs(hit.pct).toFixed(1)}%`,
          // The figures are in the alert itself. A notification that says
          // "a card you watch has moved" makes the person open the app to
          // learn something we already knew.
          body: `US$${Math.round(hit.from).toLocaleString()} → US$${Math.round(hit.to).toLocaleString()} since we last told you.`,
          data: { kind: "watch", watchId: hit.watchId, catalogId: c.catalog_id },
        });
      }
    }
  }

  const { sent, dropped } = await send(messages);
  return { cards: cards.length, fired, sent, dropped };
}
