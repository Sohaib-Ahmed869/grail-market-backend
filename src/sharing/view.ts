import { storePool } from "../cards.store.js";
import { gradedPricesFor } from "../scans/pricing.js";
import { ownerOf } from "./store.js";

export type SharedEntry = {
  entryId: string; catalogId: string | null; cardName: string;
  setName: string | null; cardNumber: string | null; imageUrl: string | null;
  grader: string | null; grade: string | null; variant: string | null;
  quantity: number; value: number | null;
};

export type SharedView = {
  owner: string; entries: SharedEntry[];
  priced: number; cards: number; value: number;
};

/** Somebody else's collection, by link. No sign-in.
 *
 *  Deliberately NOT the same payload as the owner's own view: what a person
 *  paid, and therefore whether they are up or down, is theirs. This carries
 *  the cards and what they are worth and nothing else.
 *
 *  Shared by the JSON route the app reads and the HTML page a browser opens,
 *  so the two can never come to disagree about what a link shows. */
export async function sharedView(token: string): Promise<SharedView | null> {
  const owner = await ownerOf(String(token));
  if (!owner) return null;
  const pool = storePool();
  if (!pool) return null;

  const r = await pool.query(
    `select entry_id, catalog_id, card_name, set_name, card_number, image_url,
            grader, grade, variant, quantity, added_at
       from collection where user_id = $1 order by added_at desc`,
    [owner.userId],
  );

  const entries: SharedEntry[] = await Promise.all(r.rows.map(async (e: any) => {
    const p = await gradedPricesFor({
      catalogId: e.catalog_id, name: e.card_name,
      number: e.card_number, setName: e.set_name,
    }).catch(() => null);
    const value = e.grader && e.grade
      ? p?.byGrader?.[e.grader]?.[String(e.grade)]?.price ?? null
      : p?.rawUsd ?? null;
    return {
      entryId: e.entry_id, catalogId: e.catalog_id, cardName: e.card_name,
      setName: e.set_name, cardNumber: e.card_number, imageUrl: e.image_url,
      grader: e.grader, grade: e.grade != null ? String(e.grade) : null,
      variant: e.variant, quantity: e.quantity ?? 1,
      // US dollars, like every other price this API serves. The app converts.
      value,
    };
  }));

  return {
    owner: owner.name,
    entries,
    priced: entries.filter((e) => e.value != null).length,
    cards: entries.length,
    value: entries.reduce((a, e) => a + (e.value ?? 0) * (e.quantity ?? 1), 0),
  };
}
