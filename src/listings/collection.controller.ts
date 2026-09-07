import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { storePool } from "../cards.store.js";
import { callerId } from "../auth/auth.controller.js";
import { gradedPricesFor } from "../scans/pricing.js";
import { valueOfEntry, type Unpriced } from "./collectionvalue.js";
import { marketStatusForOwner } from "./deals.js";

@Controller("collection")
export class CollectionController {
  /** What a member owns, valued at today's market rather than what they paid.
   *
   *  The figure is recomputed on read, not stored. A collection value written
   *  at the moment of adding is wrong by the next morning, and the whole
   *  reason to open the app twice a day is that the number moves. */
  @Get()
  async list(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const pool = storePool();
    if (!pool) return { entries: [], value: 0, cost: 0, gain: 0 };

    const r = await pool.query(
      "select * from collection where user_id = $1 order by added_at desc", [me],
    );

    // What each of these cards is doing on the market. A collection that
    // cannot tell you a card is listed — or that it has already gone — is a
    // list of things you might still own, which is not what it says it is.
    const market = await marketStatusForOwner(me);

    const entries = await Promise.all(
      r.rows.map(async (e: any) => {
        let value: number | null = null;
        let unpriced: Unpriced | null = null;
        try {
          const p = await gradedPricesFor({
            catalogId: e.catalog_id, name: e.card_name,
            number: e.card_number, setName: e.set_name,
          });
          // Invariant 1, and its inverse: priced at its own grader and its own
          // grade, never a grade-only lookup, never another company's figure,
          // and never the RAW price standing in for a slab whose grade we do
          // not have. See collectionvalue.ts for why that last one is the
          // whole reason this moved out of here.
          ({ value, unpriced } = valueOfEntry(
            { grader: e.grader, grade: e.grade }, p,
          ));
        } catch {
          value = null;         // a missing price is a blank, not a zero
          unpriced = "price";
        }
        return {
          entryId: e.entry_id, catalogId: e.catalog_id, cardName: e.card_name,
          setName: e.set_name, cardNumber: e.card_number, imageUrl: e.image_url,
          grader: e.grader, grade: e.grade, variant: e.variant ?? null,
          quantity: e.quantity ?? 1,
          paid: e.paid == null ? null : Number(e.paid),
          // `unpriced` says WHY there is no figure. "grade" is the owner's to
          // fix and the screen offers the edit; the other two are ours.
          value, unpriced, addedAt: e.added_at,
          // Listed, agreed, or gone. Named rather than left as the listing's
          // own status word, because `in_review` and `reserved` mean nothing
          // to the person who owns the card — what they want to know is
          // whether it is still theirs and whether the money has happened.
          market: describe(market.get(`${e.catalog_id}|${e.grader ?? ""}|${e.grade ?? ""}`)),
        };
      }),
    );

    // Quantity multiplies both sides. Four of the same card is four cards in
    // the total, and a paid price is per card — the earlier version counted
    // one of each and quietly under-reported anyone holding playsets.
    //
    // A card that has SOLD is not in the total. It is not owned any more, and
    // counting it means a collection value that goes up when you sell and
    // never comes down — the one number in this product people check daily,
    // wrong in their own favour. The row stays, marked sold, because the
    // history is worth keeping; the money is not theirs to still be holding.
    const held = entries.filter((e) => !e.market?.settled);
    const value = held.reduce((a, e) => a + (e.value ?? 0) * (e.quantity ?? 1), 0);
    const cost = held.reduce((a, e) => a + (e.paid ?? 0) * (e.quantity ?? 1), 0);
    // What the sold ones went for, which is a different and also interesting
    // number rather than something to hide.
    const realised = entries
      .filter((e) => e.market?.settled)
      .reduce((a, e) => a + (e.market?.price ?? 0), 0);
    return {
      entries, value, cost, gain: value - cost, realised,
      held: held.length, sold: entries.length - held.length,
      // Said plainly: a total that silently skips unpriced cards reads as the
      // whole collection and is not.
      priced: held.filter((e) => e.value != null).length,
    };
  }

  @Post()
  async add(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to save a collection." };
    const pool = storePool();
    if (!pool) return { error: "no-store" };
    if (!b?.cardName) return { error: "invalid", message: "A card is required." };

    const id = `c_${randomUUID().slice(0, 12)}`;
    await pool.query(
      `insert into collection
         (entry_id, user_id, catalog_id, card_name, set_name, card_number,
          image_url, grader, grade, variant, quantity, paid, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, me, b.catalogId ?? null, String(b.cardName), b.setName ?? null,
       b.cardNumber ?? null, b.imageUrl ?? null, b.grader ?? null,
       b.grade != null ? String(b.grade) : null, b.variant ?? null,
       Math.max(1, Math.min(999, Number(b.quantity) || 1)),
       b.paid != null ? Number(b.paid) : null, b.currency ?? "AUD"],
    );
    return { entryId: id };
  }

  /** Take a card out of the collection.
   *
   *  The user id is in the WHERE clause, not checked beforehand: one statement
   *  that cannot delete somebody else's row is safer than two that could race.
   *
   *  It reports whether a row actually went. Answering ok to a delete that
   *  matched nothing is indistinguishable from a real one, so a screen holding
   *  a stale entry id would show the card disappear and then find it still
   *  there on the next load. */
  @Delete(":entryId")
  async remove(@Param("entryId") entryId: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const pool = storePool();
    if (!pool) return { error: "no-store" };
    const r = await pool.query(
      "delete from collection where entry_id = $1 and user_id = $2",
      [entryId, me],
    );
    if (!r.rowCount) {
      return { error: "not-found", message: "That card is no longer in your collection." };
    }
    return { ok: true };
  }
}

/** How a card's market state reads to the person who owns it. */
function describe(
  m: { status: string; price: number; currency: string; listingId: string;
       dealId?: string | null; dealState?: string | null;
       buyerName?: string | null } | undefined,
) {
  if (!m) return null;
  const base = {
    listingId: m.listingId, dealId: m.dealId ?? null,
    price: m.price, currency: m.currency,
  };
  // A completed deal is the only thing that means SOLD. A listing marked sold
  // whose deal is still open is a card the seller has sent and the buyer has
  // not confirmed — which is not the same fact, and telling an owner their
  // card is sold before the other side has said so is how a collection total
  // ends up wrong in the owner's favour.
  if (m.dealState === "complete") {
    // Named, because "Sold" is a state and "Sold to Sohaib" is the record of
    // what happened — which is what somebody looking at a card that has left
    // their collection actually wants to see.
    return {
      ...base,
      state: "sold",
      label: m.buyerName ? `Sold to ${m.buyerName}` : "Sold",
      settled: true,
    };
  }
  if (m.dealState === "handed_over") {
    // Still reserved, not sold — the listing only sells when the buyer
    // confirms. The owner is told it is in transit, which is the true thing.
    return {
      ...base, state: "sent", settled: false,
      label: m.buyerName ? `Sent to ${m.buyerName} · awaiting confirmation`
                         : "Sent · awaiting confirmation",
    };
  }
  if (m.dealState === "agreed" || m.status === "reserved") {
    return {
      ...base, state: "agreed", settled: false,
      label: m.buyerName ? `Agreed with ${m.buyerName} · not sold yet`
                         : "Offer accepted · not sold yet",
    };
  }
  if (m.status === "live" || m.status === "paused") {
    return {
      ...base,
      state: "listed",
      label: m.status === "paused" ? "Listed · paused" : "Listed · not sold yet",
      settled: false,
    };
  }
  if (m.status === "draft" || m.status === "in_review" || m.status === "info_requested") {
    return { ...base, state: "pending", label: "Awaiting review", settled: false };
  }
  // A listing marked sold with no completed deal behind it — the old
  // seller-only path. Honest about which of the two facts we actually have.
  if (m.status === "sold") {
    return { ...base, state: "sent", label: "Marked sold", settled: false };
  }
  return null;
}
