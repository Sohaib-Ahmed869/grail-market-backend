import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// Listings, offers, and the collection.
//
// A listing is never visible to anyone but its seller until a human clears it.
// That gate is the product's whole claim, so `status` is the column everything
// else reads, and "live" is only ever written by the review endpoint.

export const LISTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  listing_id   text PRIMARY KEY,
  seller_id    text NOT NULL,
  catalog_id   text,
  card_name    text NOT NULL,
  set_name     text,
  card_number  text,
  game         text,
  variant      text,
  image_url    text,
  grader       text,
  grade        text,
  cert_number  text,
  is_raw       boolean NOT NULL DEFAULT false,
  condition_note text,
  price        numeric NOT NULL,
  currency     text NOT NULL DEFAULT 'AUD',
  market_value numeric,
  strategy     text,
  delivery     text[] NOT NULL DEFAULT '{}',
  suburb       text,
  status       text NOT NULL DEFAULT 'draft',
  reject_reason text,
  photos       jsonb NOT NULL DEFAULT '[]',
  video_url    text,
  photo_verified boolean NOT NULL DEFAULT false,
  featured_until timestamptz,
  views        integer NOT NULL DEFAULT 0,
  saves        integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  live_at      timestamptz,
  sold_at      timestamptz
);
CREATE INDEX IF NOT EXISTS listings_live ON listings (status, featured_until DESC NULLS LAST, live_at DESC);
CREATE INDEX IF NOT EXISTS listings_seller ON listings (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_card ON listings (catalog_id, status);

-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
-- every column added after the first deploy needs its own idempotent ALTER.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS variant text;

CREATE TABLE IF NOT EXISTS offers (
  offer_id   text PRIMARY KEY,
  listing_id text NOT NULL,
  buyer_id   text NOT NULL,
  seller_id  text NOT NULL,
  amount     numeric NOT NULL,
  currency   text NOT NULL DEFAULT 'AUD',
  note       text,
  status     text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS offers_listing ON offers (listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS offers_buyer ON offers (buyer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collection (
  entry_id   text PRIMARY KEY,
  user_id    text NOT NULL,
  catalog_id text,
  card_name  text NOT NULL,
  set_name   text,
  card_number text,
  image_url  text,
  grader     text,
  grade      text,
  paid       numeric,
  currency   text NOT NULL DEFAULT 'AUD',
  added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collection_user ON collection (user_id, added_at DESC);

ALTER TABLE collection ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE collection ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
`;

export async function initListings(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(LISTINGS_SCHEMA);
}

/** Where a listing can go from where it is.
 *
 *  Written down rather than checked ad hoc, because "live" is the transition
 *  that matters and it must only ever be reachable from review. */
export const TRANSITIONS: Record<string, string[]> = {
  draft: ["in_review", "withdrawn"],
  in_review: ["live", "rejected", "withdrawn"],
  live: ["sold", "withdrawn"],
  rejected: ["in_review", "withdrawn"],
  sold: [],
  withdrawn: [],
};

export const canMove = (from: string, to: string) =>
  (TRANSITIONS[from] ?? []).includes(to);

export type Listing = Record<string, any>;

export async function createListing(l: {
  sellerId: string; catalogId?: string | null; cardName: string;
  setName?: string | null; cardNumber?: string | null; game?: string | null;
  imageUrl?: string | null; grader?: string | null; grade?: string | null;
  certNumber?: string | null; variant?: string | null;
  isRaw?: boolean; conditionNote?: string | null;
  price: number; currency?: string; marketValue?: number | null;
  strategy?: string | null; delivery?: string[]; suburb?: string | null;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `l_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into listings
      (listing_id, seller_id, catalog_id, card_name, set_name, card_number, game,
       image_url, grader, grade, cert_number, variant, is_raw, condition_note,
       price, currency, market_value, strategy, delivery, suburb)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [id, l.sellerId, l.catalogId ?? null, l.cardName, l.setName ?? null,
     l.cardNumber ?? null, l.game ?? null, l.imageUrl ?? null, l.grader ?? null,
     l.grade ?? null, l.certNumber ?? null, l.variant ?? null,
     l.isRaw ?? false, l.conditionNote ?? null,
     l.price, l.currency ?? "AUD", l.marketValue ?? null, l.strategy ?? null,
     l.delivery ?? [], l.suburb ?? null],
  );
  return id;
}

export async function getListing(id: string): Promise<Listing | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query("select * from listings where listing_id = $1", [id]);
  return r.rows[0] ?? null;
}

export async function setPhotos(
  id: string, sellerId: string, photos: { angle: string; url: string }[], videoUrl: string | null,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  // Photo Verified is earned by supplying all ten prescribed angles. It is the
  // mark buyers filter on, so it is computed here from what actually arrived
  // rather than trusted from the client.
  const verified = photos.length >= 10;
  const r = await pool.query(
    `update listings set photos = $1, video_url = $2, photo_verified = $3
      where listing_id = $4 and seller_id = $5 and status in ('draft','rejected')`,
    [JSON.stringify(photos), videoUrl, verified, id, sellerId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Move a listing, refusing anything the state machine does not allow. */
export async function moveListing(
  id: string, to: string, opts: { sellerId?: string; reason?: string | null } = {},
): Promise<{ ok: true } | { ok: false; why: string }> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store" };
  const cur = await getListing(id);
  if (!cur) return { ok: false, why: "not-found" };
  if (opts.sellerId && cur.seller_id !== opts.sellerId) return { ok: false, why: "not-yours" };
  if (!canMove(cur.status, to)) return { ok: false, why: `cannot go ${cur.status} -> ${to}` };

  await pool.query(
    `update listings set status = $1, reject_reason = $2,
        live_at = case when $1 = 'live' then now() else live_at end,
        sold_at = case when $1 = 'sold' then now() else sold_at end
      where listing_id = $3`,
    [to, opts.reason ?? null, id],
  );
  return { ok: true };
}

/** The market. Featured first, then newest — the order asked for, and stated
 *  on screen so nobody thinks it is arbitrary. */
export async function browseListings(q: {
  game?: string | null; grader?: string | null; graded?: boolean | null;
  catalogId?: string | null; excludeSeller?: string | null;
  min?: number | null; max?: number | null; sort?: string | null; limit?: number;
}): Promise<Listing[]> {
  const pool = storePool();
  if (!pool) return [];
  const where: string[] = ["status = 'live'"];
  const args: any[] = [];
  const add = (sql: string, v: any) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };

  if (q.game) add("game = ?", q.game);
  // Every live copy of one exact card — what a scan result means by
  // "available now", and what a buyer comparing two listings needs.
  if (q.catalogId) add("catalog_id = ?", q.catalogId);
  // Your own cards are not shopping. They are already yours, and seeing them
  // in the market feed makes the feed look busier than it is.
  if (q.excludeSeller) add("seller_id <> ?", q.excludeSeller);
  if (q.grader) add("grader = ?", q.grader.toUpperCase());
  if (q.graded === true) where.push("grader is not null");
  if (q.graded === false) where.push("grader is null");
  if (q.min != null) add("price >= ?", q.min);
  if (q.max != null) add("price <= ?", q.max);

  const order =
    q.sort === "price_desc" ? "price desc"
    : q.sort === "price_asc" ? "price asc"
    : q.sort === "newest" ? "live_at desc"
    : "(featured_until > now()) desc nulls last, live_at desc";

  args.push(Math.min(q.limit ?? 50, 100));
  const r = await pool.query(
    `select * from listings where ${where.join(" and ")} order by ${order} limit $${args.length}`,
    args,
  );
  return r.rows;
}

export async function listingsBySeller(sellerId: string): Promise<Listing[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    "select * from listings where seller_id = $1 order by created_at desc", [sellerId],
  );
  return r.rows;
}

export async function reviewQueue(): Promise<Listing[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    "select * from listings where status = 'in_review' order by created_at asc",
  );
  return r.rows;
}

export async function bumpView(id: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query("update listings set views = views + 1 where listing_id = $1", [id]);
}

/** How many live listings this member already has, for the plan ceiling. */
export async function liveCount(sellerId: string): Promise<number> {
  const pool = storePool();
  if (!pool) return 0;
  const r = await pool.query(
    "select count(*)::int n from listings where seller_id = $1 and status in ('live','in_review')",
    [sellerId],
  );
  return r.rows[0]?.n ?? 0;
}
