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

  // A counter is written BESIDE the offer, never over it.
  //
  // This used to set `amount` to the counter, which destroyed the only record
  // of what the buyer had offered: an A$11,800 offer countered at A$120,000
  // read back forever as an A$120,000 offer from the buyer. The screen needs
  // both numbers to say what is actually on the table.
  //
  // A countered offer is also NOT settled. It is the seller's move made and
  // the ball back in the buyer's court, so `settled_at` stays null and the
  // offer keeps its place at the top of both queues.
  await pool.query(
    action === "countered"
      ? `update offers set status = 'countered', counter_amount = $1 where offer_id = $2`
      : `update offers set status = $1, settled_at = now() where offer_id = $2`,
    action === "countered" ? [counterAmount ?? null, offerId] : [action, offerId],
  );

  // Recorded in the conversation as well as on the offer: the thread is
  // where both people will look for what was agreed.
  const money = `${o.currency === "AUD" ? "A$" : "$"}${Math.round(
    action === "countered" ? (counterAmount ?? Number(o.amount)) : Number(o.amount),
  ).toLocaleString()}`;
  await noteEvent(o.listing_id, o.buyer_id, {
    accepted: `Offer accepted at ${money}. Arrange the handover here.`,
    declined: `Offer of ${money} declined.`,
    countered: `Seller countered at ${money}. Answer it under Offers.`,
  }[action]).catch(() => null);

  await notify({
    userId: o.buyer_id, kind: "offer-settled", actorId: sellerId,
    title: {
      accepted: `Your ${money} offer was accepted`,
      declined: `Your ${money} offer was declined`,
      countered: `Countered at ${money}`,
    }[action],
    body: {
      accepted: "Arrange the handover in your messages.",
      declined: null,
      countered: "Take it, decline it, or come back with a number.",
    }[action],
    // Where the thing can be ACTED on. A counter sent the buyer to their
    // messages, which is where the news was but not where the three buttons
    // are — so the notification announced a decision and then led away from
    // the only screen that could make it.
    href: action === "accepted" ? `/messages` : `/offers`,
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


export type ReplyResult =
  | { ok: true; status: string; dealId?: string | null; offerId?: string }
  | { ok: false; why: "not-found" | "not-yours" | "not-countered" | "invalid" };

/** The buyer answering a counter.
 *
 *  The other half of `settleOffer`, and it did not exist. A seller could
 *  counter and the buyer was then looking at a number with nothing to do about
 *  it — no accept, no decline, no way to come back with one of their own. The
 *  negotiation had exactly one move in it.
 *
 *  Countering back does not mutate the offer. It closes this one and opens a
 *  fresh offer from the buyer, which lands in the seller's queue as an ordinary
 *  open offer and can be countered again. The chain is kept through `replaces`,
 *  so the whole negotiation is readable afterwards. */
export async function replyToCounter(
  offerId: string, buyerId: string, action: "accepted" | "declined" | "countered",
  counterAmount?: number,
): Promise<ReplyResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "not-found" };
  const r = await pool.query("select * from offers where offer_id = $1", [offerId]);
  const o = r.rows[0];
  if (!o) return { ok: false, why: "not-found" };
  if (o.buyer_id !== buyerId) return { ok: false, why: "not-yours" };
  if (o.status !== "countered") return { ok: false, why: "not-countered" };

  // What the seller asked for. Rows countered before `counter_amount` existed
  // carry it in `amount`, because that is where the old code put it.
  const asked = Number(o.counter_amount ?? o.amount);
  const sym = o.currency === "AUD" ? "A$" : "$";
  const cash = (n: number) => `${sym}${Math.round(n).toLocaleString()}`;

  if (action === "declined") {
    await pool.query(
      "update offers set status = 'declined', settled_at = now() where offer_id = $1",
      [offerId],
    );
    await noteEvent(o.listing_id, buyerId, `Counter of ${cash(asked)} declined.`).catch(() => null);
    await notify({
      userId: o.seller_id, kind: "offer-settled", actorId: buyerId,
      title: `Your ${cash(asked)} counter was declined`,
      body: null, href: `/offers/${o.listing_id}`,
    });
    return { ok: true, status: "declined" };
  }

  if (action === "countered") {
    const amount = Number(counterAmount);
    if (!(amount > 0)) return { ok: false, why: "invalid" };
    const id = `o_${randomUUID().slice(0, 12)}`;
    // The old offer closes and a new one opens, in one transaction: two open
    // offers from the same buyer on the same card is two prices the seller can
    // both accept.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "update offers set status = 'declined', settled_at = now() where offer_id = $1",
        [offerId],
      );
      await client.query(
        `insert into offers (offer_id, listing_id, buyer_id, seller_id, amount, currency, note, replaces)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, o.listing_id, o.buyer_id, o.seller_id, amount, o.currency, o.note ?? null, offerId],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => null);
      throw e;
    } finally {
      client.release();
    }
    await noteEvent(o.listing_id, buyerId, `Countered back at ${cash(amount)}.`).catch(() => null);
    await notify({
      userId: o.seller_id, kind: "offer", actorId: buyerId,
      title: `${cash(amount)} offered back on your card`,
      body: `You asked ${cash(asked)}.`,
      href: `/offers/${o.listing_id}`,
    });
    return { ok: true, status: "countered", offerId: id };
  }

  // Accepted. The deal is struck at the SELLER's number, which is the one on
  // the table — accepting a counter at the buyer's original figure would be
  // agreeing to something nobody offered.
  await pool.query(
    "update offers set status = 'accepted', amount = $1, settled_at = now() where offer_id = $2",
    [asked, offerId],
  );
  await pool.query(
    `update offers set status = 'declined', settled_at = now()
      where listing_id = $1 and offer_id <> $2 and status in ('open','countered')`,
    [o.listing_id, offerId],
  );
  await noteEvent(o.listing_id, buyerId,
    `Counter of ${cash(asked)} accepted. Arrange the handover here.`).catch(() => null);
  await notify({
    userId: o.seller_id, kind: "offer-settled", actorId: buyerId,
    title: `Your ${cash(asked)} counter was accepted`,
    body: "Arrange the handover in your messages.",
    href: `/messages`,
  });
  const { startDeal } = await import("./deals.js");
  const dealId = await startDeal({
    offerId, listingId: o.listing_id, buyerId: o.buyer_id,
    sellerId: o.seller_id, amount: asked, currency: o.currency,
  });
  return { ok: true, status: "accepted", dealId };
}
