import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { note as noteEvent } from "../messages/store.js";
import { notify } from "../notifications/store.js";

// Offers.
//
// Accepting one marks a deal agreed. It is not a contract of sale and it moves
// no money — nothing in this system can, because nothing in this system holds
// any. The wording on screen says so, and so does this file, because the first
// person to add a payment step here should have to delete this comment first.

export type Offer = Record<string, any>;

export async function makeOffer(o: {
  listingId: string; buyerId: string; sellerId: string;
  amount: number; currency?: string; note?: string | null;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `o_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into offers (offer_id, listing_id, buyer_id, seller_id, amount, currency, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, o.listingId, o.buyerId, o.sellerId, o.amount, o.currency ?? "AUD", o.note ?? null],
  );
  return id;
}

export async function offersFor(listingId: string): Promise<Offer[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select o.*, u.name as buyer_name
       from offers o left join users u on u.user_id = o.buyer_id
      where o.listing_id = $1 order by o.created_at desc`,
    [listingId],
  );
  return r.rows;
}

export async function offersByBuyer(buyerId: string): Promise<Offer[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select o.*, l.card_name, l.image_url, l.price as asking,
            l.grader, l.grade, l.set_name
       from offers o join listings l using (listing_id)
      where o.buyer_id = $1 order by o.created_at desc`,
    [buyerId],
  );
  return r.rows;
}

/** Every offer on anything I am selling.
 *
 *  The mirror of `offersByBuyer`, and it did not exist. A seller could only
 *  see offers by opening one listing at a time, so there was nowhere to
 *  answer "has anybody offered on anything of mine" — and the app's only
 *  offers screen shows the ones you MADE, which for a seller is empty and
 *  reads as "nobody has offered". */
export async function offersToSeller(sellerId: string): Promise<Offer[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select o.*, l.card_name, l.image_url, l.price as asking,
            l.grader, l.grade, l.set_name, l.status as listing_status
       from offers o join listings l using (listing_id)
      where l.seller_id = $1
      -- Unanswered first. The status is 'open' — there is no 'pending' in
      -- this schema, and sorting on one silently degraded this to
      -- newest-first, burying live offers under settled ones.
      order by (o.status = 'open') desc, o.created_at desc`,
    [sellerId],
  );
  return r.rows;
}

/** Does this person have a claim on this listing?
 *
 *  True for the buyer whose offer was accepted, and for either party to a
 *  deal on it. That is the set of people a listing must stay visible to after
 *  it stops being live — they bought it, or they are in the middle of handing
 *  it over, and a page that answers "not available" to them is the app
 *  losing track of a sale in progress. */
export async function hasStakeIn(listingId: string, userId: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `select 1
       from offers
      where listing_id = $1 and buyer_id = $2 and status = 'accepted'
      union all
     select 1
       from deals
      where listing_id = $1 and (buyer_id = $2 or seller_id = $2)
      limit 1`,
    [listingId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export type SettleResult =
  | { ok: true; status: string; dealId?: string | null }
  | { ok: false; why: "not-found" | "not-yours" | "already-settled" };

/** Accept, counter or decline. Only the seller may.
 *
 *  Accepting also declines every other open offer on that listing: two people
 *  each told they have a deal on one card is the worst outcome this screen can
 *  produce, and it is trivially avoidable. */
export async function settleOffer(
  offerId: string, sellerId: string, action: "accepted" | "declined" | "countered",
  counterAmount?: number,
): Promise<SettleResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "not-found" };
  const r = await pool.query("select * from offers where offer_id = $1", [offerId]);
  const o = r.rows[0];
  if (!o) return { ok: false, why: "not-found" };
  if (o.seller_id !== sellerId) return { ok: false, why: "not-yours" };
  if (o.status !== "open") return { ok: false, why: "already-settled" };

  await pool.query(
    `update offers set status = $1, amount = coalesce($2, amount), settled_at = now()
      where offer_id = $3`,
    [action, action === "countered" ? counterAmount ?? null : null, offerId],
  );

  // Recorded in the conversation as well as on the offer: the thread is
  // where both people will look for what was agreed.
  const money = `${o.currency === "AUD" ? "A$" : "$"}${Math.round(
    action === "countered" ? (counterAmount ?? Number(o.amount)) : Number(o.amount),
  ).toLocaleString()}`;
  await noteEvent(o.listing_id, o.buyer_id, {
    accepted: `Offer accepted at ${money}. Arrange the handover here.`,
    declined: `Offer of ${money} declined.`,
    countered: `Seller countered at ${money}.`,
  }[action]).catch(() => null);

  await notify({
    userId: o.buyer_id, kind: "offer-settled", actorId: sellerId,
    title: {
      accepted: `Your ${money} offer was accepted`,
      declined: `Your ${money} offer was declined`,
      countered: `Countered at ${money}`,
    }[action],
    body: action === "accepted" ? "Arrange the handover in your messages." : null,
    href: `/messages`,
  });

  if (action === "accepted") {
    await pool.query(
      `update offers set status = 'declined', settled_at = now()
        where listing_id = $1 and offer_id <> $2 and status = 'open'`,
      [o.listing_id, offerId],
    );
    // And open the deal. Accepting used to end here — one word changed on a
    // row, the listing left live and still collecting offers, and the two of
    // them sent to a message thread to work the rest out between themselves.
    // Imported here rather than at the top because deals.ts imports this
    // module's neighbours and a cycle at load time takes the server down.
    const { startDeal } = await import("./deals.js");
    const dealId = await startDeal({
      offerId, listingId: o.listing_id, buyerId: o.buyer_id,
      sellerId: o.seller_id, amount: Number(o.amount), currency: o.currency,
    });
    return { ok: true, status: action, dealId };
  }
  return { ok: true, status: action };
}
