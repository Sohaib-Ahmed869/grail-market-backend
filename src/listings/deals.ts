import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { recordSale } from "../sales/ledger.js";
import { notify } from "../notifications/store.js";
import { note } from "../messages/store.js";
import { getListing, moveListing } from "./store.js";

// A deal: the thing that exists between "we agreed" and "it is done".
//
// Accepting an offer used to change one word on the offer row and nothing
// else. The listing stayed live and kept taking offers from other buyers, the
// only way to close was the seller alone tapping "sold", and the buyer was
// never asked whether anything had actually arrived. Disputes and ratings both
// hung off a listing id and had to infer who the counterparty was.
//
// Escrow was going to bring this record with it. Payments are out of scope, so
// the money moves between the two people — but the RECORD is needed either
// way, and without it none of the rest of the trust stack has anything to
// attach to.
//
// Four states, and the only two that close it need BOTH people:
//
//   agreed        an offer was accepted. The listing is reserved: off the
//                 market, not yet gone.
//   handed_over   the seller says they have sent or handed it over.
//   complete      the buyer says they have it. Only now is it a sale, and
//                 only now does it become a comparable.
//   cancelled     either side pulled out. The listing goes back on the market
//                 rather than being destroyed.
//
// The comp is written at `complete` and nowhere else. Marking a card sold used
// to write a seller-supplied price straight into the append-only ledger with
// nothing to check it against, which is a number our own valuations then read
// back. A figure both sides stood behind is a different claim.

export type DealState = "agreed" | "handed_over" | "complete" | "cancelled";

export const DEALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS deals (
  deal_id     text PRIMARY KEY,
  listing_id  text NOT NULL,
  offer_id    text,
  buyer_id    text NOT NULL,
  seller_id   text NOT NULL,
  amount      numeric NOT NULL,
  currency    text NOT NULL DEFAULT 'AUD',
  state       text NOT NULL DEFAULT 'agreed',
  -- Who ended it and why, when somebody did. Kept apart from the state so a
  -- cancelled deal still reads as a history rather than a blank.
  cancelled_by text,
  cancel_reason text,
  agreed_at      timestamptz NOT NULL DEFAULT now(),
  handed_over_at timestamptz,
  completed_at   timestamptz,
  cancelled_at   timestamptz
);
CREATE INDEX IF NOT EXISTS deals_buyer  ON deals (buyer_id, agreed_at DESC);
CREATE INDEX IF NOT EXISTS deals_seller ON deals (seller_id, agreed_at DESC);
-- One live deal per listing. A second agreement on a card already promised to
-- somebody is the worst thing this table could allow, and it is cheap to make
-- impossible rather than to check for.
CREATE UNIQUE INDEX IF NOT EXISTS deals_one_open
  ON deals (listing_id) WHERE state in ('agreed', 'handed_over');
`;

export async function initDeals(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(DEALS_SCHEMA);
}

const money = (n: number, currency: string) =>
  `${currency === "AUD" ? "A$" : "$"}${Math.round(n).toLocaleString()}`;

/** Open a deal, because an offer was accepted.
 *
 *  Also takes the listing off the market. A card two people have agreed on
 *  must stop collecting offers from a third — the seller cannot honour them
 *  and every one of them is a person who thinks they are in with a chance. */
export async function startDeal(o: {
  offerId: string; listingId: string; buyerId: string; sellerId: string;
  amount: number; currency: string;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `d_${randomUUID().slice(0, 12)}`;
  try {
    await pool.query(
      `insert into deals (deal_id, listing_id, offer_id, buyer_id, seller_id, amount, currency)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, o.listingId, o.offerId, o.buyerId, o.sellerId, o.amount, o.currency],
    );
  } catch {
    // The unique index caught a second open deal on this listing. Not an
    // error worth failing the accept over — there is already a deal, and it
    // is the one that counts.
    return null;
  }
  await moveListing(o.listingId, "reserved", { sellerId: o.sellerId });
  return id;
}

export type Deal = Record<string, any>;

export async function dealById(dealId: string, me: string): Promise<Deal | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select d.*, l.card_name, l.set_name, l.card_number, l.image_url,
            l.grader, l.grade, l.photos,
            sb.name as buyer_name, sl.name as seller_name
       from deals d
       join listings l on l.listing_id = d.listing_id
       left join users sb on sb.user_id = d.buyer_id
       left join users sl on sl.user_id = d.seller_id
      where d.deal_id = $1 and (d.buyer_id = $2 or d.seller_id = $2)`,
    [dealId, me],
  );
  return r.rows[0] ?? null;
}

/** Every deal this person is on either side of. */
export async function myDeals(me: string): Promise<Deal[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select d.*, l.card_name, l.set_name, l.image_url, l.photos,
            sb.name as buyer_name, sl.name as seller_name
       from deals d
       join listings l on l.listing_id = d.listing_id
       left join users sb on sb.user_id = d.buyer_id
       left join users sl on sl.user_id = d.seller_id
      where d.buyer_id = $1 or d.seller_id = $1
      order by (d.state in ('agreed','handed_over')) desc, d.agreed_at desc`,
    [me],
  );
  return r.rows;
}

type Moved = { ok: true; state: DealState } | { ok: false; why: string };

/** The seller has sent it, or handed it over.
 *
 *  The listing does NOT become `sold` here. A card in the post is not a card
 *  that has changed hands: the buyer has not seen it, and the deal can still
 *  collapse. It stays `reserved` — off the market, not yet gone — and becomes
 *  sold at the moment the buyer confirms.
 *
 *  This was the other way round first, and two tests that predate the deal
 *  flow caught it: making the listing sold here meant `sold -> live` had to
 *  be opened for a cancellation, which breaks "a sold listing is final". */
export async function markHandedOver(dealId: string, me: string): Promise<Moved> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store" };
  const d = await dealById(dealId, me);
  if (!d) return { ok: false, why: "not-found" };
  if (d.seller_id !== me) return { ok: false, why: "not-yours" };
  if (d.state !== "agreed") return { ok: false, why: `already ${d.state}` };

  await pool.query(
    `update deals set state = 'handed_over', handed_over_at = now() where deal_id = $1`,
    [dealId],
  );
  await note(d.listing_id, me, "Marked as handed over. Confirm when it reaches you.")
    .catch(() => null);
  await notify({
    userId: d.buyer_id, kind: "deal", actorId: me,
    title: `${d.card_name} is on its way`,
    body: "Confirm when it arrives so the deal can close.",
    href: `/deals/${dealId}`,
  });
  return { ok: true, state: "handed_over" };
}

/** The buyer has it. This is the only place a sale becomes a comparable.
 *
 *  Both sides have now said the same thing about the same card at the same
 *  price, which is the whole difference between a confirmed sale and a number
 *  one person typed. */
export async function markReceived(dealId: string, me: string): Promise<Moved> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store" };
  const d = await dealById(dealId, me);
  if (!d) return { ok: false, why: "not-found" };
  if (d.buyer_id !== me) return { ok: false, why: "not-yours" };
  if (d.state !== "handed_over") {
    return {
      ok: false,
      why: d.state === "agreed" ? "not-sent-yet" : `already ${d.state}`,
    };
  }

  await pool.query(
    `update deals set state = 'complete', completed_at = now() where deal_id = $1`,
    [dealId],
  );
  // NOW it is sold: the buyer has it, and `reserved -> sold` is the only way
  // a listing reaches that state through this flow.
  await moveListing(d.listing_id, "sold", { sellerId: d.seller_id });

  const l = await getListing(d.listing_id);
  if (l?.catalog_id) {
    // The agreed amount, not anything either side can retype here. It is what
    // the offer was accepted at and both of them have now stood behind it.
    await recordSale({
      catalogId: l.catalog_id, grader: l.grader, grade: l.grade,
      price: Number(d.amount), currency: d.currency,
      soldAt: new Date(), source: "grailmarket",
      sourceUrl: `grailmarket://deal/${dealId}`,
      rawTitle: `${l.card_name}${l.set_name ? ` · ${l.set_name}` : ""}`,
    }).catch(() => null);
  }

  await notify({
    userId: d.seller_id, kind: "deal", actorId: me,
    title: `${d.card_name} arrived`,
    body: `${money(Number(d.amount), d.currency)} · the deal is closed. Rate ${d.buyer_name ?? "your buyer"}.`,
    href: `/deals/${dealId}`,
  });
  return { ok: true, state: "complete" };
}

/** Either side pulls out before it completes.
 *
 *  The listing goes back on the market. A withdrawal is final and this is not
 *  — the card still exists and the seller still wants to sell it. */
export async function cancelDeal(
  dealId: string, me: string, reason?: string | null,
): Promise<Moved> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store" };
  const d = await dealById(dealId, me);
  if (!d) return { ok: false, why: "not-found" };
  if (d.state === "complete") return { ok: false, why: "already-complete" };
  if (d.state === "cancelled") return { ok: false, why: "already-cancelled" };

  await pool.query(
    `update deals set state = 'cancelled', cancelled_at = now(),
            cancelled_by = $2, cancel_reason = $3
      where deal_id = $1`,
    [dealId, me, reason ?? null],
  );

  // Back on the market. The listing is still `reserved` at every point a deal
  // can be cancelled — which is exactly why it must not have been marked sold
  // on dispatch — so this is a `reserved -> live` move and nothing more.
  await moveListing(d.listing_id, "live", { sellerId: d.seller_id });

  const other = me === d.buyer_id ? d.seller_id : d.buyer_id;
  await notify({
    userId: other, kind: "deal", actorId: me,
    title: `The deal on ${d.card_name} was called off`,
    body: reason ? String(reason).slice(0, 140) : "It is back on the market.",
    href: `/deals/${dealId}`,
  });
  return { ok: true, state: "cancelled" };
}

/** What a member's own cards are doing on the market.
 *
 *  A collection row and a listing are not joined by anything — there is no
 *  foreign key in this schema and a listing is not created FROM an entry. They
 *  are the same card when they are the same catalogue id at the same grade
 *  from the same grading company, which is the identity the whole pricing
 *  chain already uses.
 *
 *  Returned as a LIST rather than one-per-card, because a listing is one
 *  physical card and a collector can own several of the same. Keyed by card
 *  identity, selling one of two identical PSA 10s marked BOTH of them sold and
 *  took both out of the collection value — the owner loses a card they still
 *  have. The caller hands these out one to an entry.
 */
export type OwnerMarket = {
  key: string;
  status: string;
  price: number;
  currency: string;
  listingId: string;
  dealId: string | null;
  dealState: string | null;
  buyerName: string | null;
};

export async function marketStatusForOwner(userId: string): Promise<OwnerMarket[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select l.listing_id, l.catalog_id, l.grader, l.grade, l.currency, l.status,
            d.deal_id, d.state as deal_state,
            -- Who it went to. "Sold" on its own is a state; "Sold to Sohaib"
            -- is the record of what happened, and it is the thing the owner
            -- actually wants to see against a card that has left.
            b.name as buyer_name,
            -- What it actually went for once there is a deal, and only the ASK
            -- until then. These are different numbers — the listing said
            -- 25,000 and the accepted offer was 24,500 — and reporting the ask
            -- as the realised figure overstates every sale by the discount the
            -- seller agreed to.
            coalesce(d.amount, l.price) as price
       from listings l
       left join deals d
         on d.listing_id = l.listing_id and d.state in ('agreed','handed_over','complete')
       left join users b on b.user_id = d.buyer_id
      where l.seller_id = $1
        and l.catalog_id is not null
        and l.status in ('draft','in_review','info_requested','live','paused','reserved','sold')
      -- Live business before history, so an owner holding two of a card sees
      -- the one that is still going against the copy they still have.
      order by (l.status = 'sold') asc, l.created_at desc`,
    [userId],
  );
  return r.rows.map((x: any) => ({
    key: `${x.catalog_id}|${x.grader ?? ""}|${x.grade ?? ""}`,
    status: x.status,
    price: Number(x.price),
    currency: x.currency,
    listingId: x.listing_id,
    dealId: x.deal_id ?? null,
    dealState: x.deal_state ?? null,
    buyerName: x.buyer_name ?? null,
  }));
}
