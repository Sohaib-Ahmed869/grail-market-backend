import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { canRate, type Deal } from "./rules.js";
import { notify } from "../notifications/store.js";
import { censor } from "../community/censor.js";

// Reputation, tied to trades that happened.
//
// A rating row points at the listing it came from, so every star on a profile
// can be traced to a card that changed hands. That link is what separates a
// rating system from a comment box.

export const RATINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ratings (
  rating_id  text PRIMARY KEY,
  listing_id text NOT NULL,
  rater_id   text NOT NULL,
  ratee_id   text NOT NULL,
  -- which side the rater was on, so a profile can show "as a seller" apart
  -- from "as a buyer": they are different reputations
  rater_role text NOT NULL,
  stars      smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ratings_once ON ratings (listing_id, rater_id);
CREATE INDEX IF NOT EXISTS ratings_ratee ON ratings (ratee_id, created_at DESC);
`;

export async function initRatings(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(RATINGS_SCHEMA);
}

/** The deal behind a listing, as the rules need to see it. */
async function dealFor(listingId: string, userId: string): Promise<Deal | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select l.status as listing_status, l.seller_id,
            o.buyer_id, o.status as offer_status,
            -- Whether this person has ANY offer here, accepted or not. Without
            -- it, someone whose offer is still open reads as a stranger and
            -- gets told "you weren't part of this deal" — which is both wrong
            -- and the opposite of encouraging: they were, it just is not done.
            exists (select 1 from offers q
                     where q.listing_id = l.listing_id and q.buyer_id = $2) as is_bidder,
            exists (select 1 from ratings x
                     where x.listing_id = l.listing_id and x.rater_id = $2) as already
       from listings l
       left join offers o
         on o.listing_id = l.listing_id and o.status = 'accepted'
      where l.listing_id = $1`,
    [listingId, userId],
  );
  const row = r.rows[0];
  if (!row) return null;

  // If no offer has been accepted there is no buyer yet. Treating the person
  // asking as the buyer — when they have an offer on this listing — is what
  // lets the rules answer "not complete" instead of "not you".
  const buyerId = row.buyer_id ?? (row.is_bidder ? userId : "");
  return {
    listingStatus: row.listing_status,
    sellerId: row.seller_id,
    buyerId,
    offerStatus: row.offer_status ?? "none",
    already: Boolean(row.already),
  };
}

export type RateResult =
  | { ok: true; ratingId: string }
  | { ok: false; why: string; message: string };

export async function rate(
  listingId: string, raterId: string, stars: number, comment: string | null,
): Promise<RateResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store", message: "Unavailable." };

  const deal = await dealFor(listingId, raterId);
  if (!deal) return { ok: false, why: "not-found", message: "That deal doesn't exist." };

  const verdict = canRate(raterId, deal);
  if (!verdict.validStars(stars)) {
    return { ok: false, why: "bad-stars", message: "Pick one to five stars." };
  }
  if (!verdict.ok) {
    const message = {
      "not-party": "You weren't part of this deal.",
      "not-complete": "You can rate once the card has changed hands.",
      "already-rated": "You've already rated this one.",
      self: "You can't rate yourself.",
    }[verdict.why];
    return { ok: false, why: verdict.why, message };
  }

  const id = `r_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into ratings (rating_id, listing_id, rater_id, ratee_id, rater_role, stars, comment)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, listingId, raterId, verdict.counterparty,
     raterId === deal.sellerId ? "seller" : "buyer",
     stars, comment ? censor(comment).text.slice(0, 600) : null],
  );
  await notify({
    userId: verdict.counterparty, kind: "rating", actorId: raterId,
    title: `You were rated ${stars} out of 5`,
    body: comment?.slice(0, 140) ?? null,
    href: `/seller/${verdict.counterparty}`,
  });

  return { ok: true, ratingId: id };
}

export type Reputation = {
  count: number;
  average: number | null;
  /** counted separately: being a good seller and a good buyer are not the
   *  same claim, and a profile that merges them hides which one you are */
  asSeller: { count: number; average: number | null };
  asBuyer: { count: number; average: number | null };
  recent: {
    stars: number; comment: string | null; createdAt: string;
    raterRole: string; raterName: string | null;
  }[];
};

export async function reputationFor(userId: string): Promise<Reputation> {
  const pool = storePool();
  const empty: Reputation = {
    count: 0, average: null,
    asSeller: { count: 0, average: null }, asBuyer: { count: 0, average: null },
    recent: [],
  };
  if (!pool) return empty;

  // The rater's role is theirs; the person being rated held the other one.
  const agg = await pool.query(
    `select rater_role, count(*)::int n, avg(stars)::float avg
       from ratings where ratee_id = $1 group by rater_role`,
    [userId],
  );
  const byRole: Record<string, { n: number; avg: number }> = {};
  for (const r of agg.rows) byRole[r.rater_role] = { n: r.n, avg: r.avg };

  // rated BY a buyer means they were the seller
  const asSeller = byRole.buyer ?? { n: 0, avg: 0 };
  const asBuyer = byRole.seller ?? { n: 0, avg: 0 };
  const count = asSeller.n + asBuyer.n;

  const recent = await pool.query(
    `select r.stars, r.comment, r.created_at, r.rater_role, u.name as rater_name
       from ratings r left join users u on u.user_id = r.rater_id
      where r.ratee_id = $1
      order by r.created_at desc limit 10`,
    [userId],
  );

  return {
    count,
    average: count === 0 ? null
      : (asSeller.n * asSeller.avg + asBuyer.n * asBuyer.avg) / count,
    asSeller: { count: asSeller.n, average: asSeller.n ? asSeller.avg : null },
    asBuyer: { count: asBuyer.n, average: asBuyer.n ? asBuyer.avg : null },
    recent: recent.rows.map((x: any) => ({
      stars: x.stars, comment: x.comment, createdAt: x.created_at,
      raterRole: x.rater_role, raterName: x.rater_name,
    })),
  };
}

/** Deals this person can still rate — the prompt list. */
export async function awaitingRating(userId: string): Promise<any[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select l.listing_id, l.card_name, l.set_name, l.grader, l.grade, l.image_url,
            l.photos, l.sold_at, l.seller_id, o.buyer_id,
            case when l.seller_id = $1 then 'seller' else 'buyer' end as my_role
       from listings l
       join offers o on o.listing_id = l.listing_id and o.status = 'accepted'
      where l.status = 'sold'
        and (l.seller_id = $1 or o.buyer_id = $1)
        and not exists (select 1 from ratings x
                         where x.listing_id = l.listing_id and x.rater_id = $1)
      order by l.sold_at desc nulls last`,
    [userId],
  );
  return r.rows;
}

/** How a seller has behaved, from the record rather than from opinion. */
export async function sellerMetrics(userId: string): Promise<{
  live: number; sold: number; withdrawn: number;
  completionRate: number | null; medianReplyHours: number | null;
}> {
  const pool = storePool();
  if (!pool) return { live: 0, sold: 0, withdrawn: 0, completionRate: null, medianReplyHours: null };

  const c = await pool.query(
    `select
       count(*) filter (where status = 'live')::int      live,
       count(*) filter (where status = 'sold')::int      sold,
       count(*) filter (where status = 'withdrawn')::int withdrawn
     from listings where seller_id = $1`, [userId]);

  // How long offers sit before this seller answers them. Median, not mean:
  // one offer left for a month should not define a seller who usually
  // answers within the hour.
  const t = await pool.query(
    `select percentile_cont(0.5) within group (
              order by extract(epoch from (settled_at - created_at)) / 3600.0
            ) as median_hours
       from offers
      where seller_id = $1 and settled_at is not null`, [userId]);

  const row = c.rows[0] ?? { live: 0, sold: 0, withdrawn: 0 };
  const finished = row.sold + row.withdrawn;
  return {
    live: row.live, sold: row.sold, withdrawn: row.withdrawn,
    completionRate: finished === 0 ? null : row.sold / finished,
    medianReplyHours: t.rows[0]?.median_hours ?? null,
  };
}
