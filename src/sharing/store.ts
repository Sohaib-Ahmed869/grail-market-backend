import { randomBytes } from "node:crypto";
import { storePool } from "../cards.store.js";

/** A link that shows a collection to somebody who is not signed in.
 *
 *  Collectors want to show the binder — that is most of what a collection is
 *  for — and the only way to do it today is a screenshot. A link is better on
 *  both counts: it is current, and it is revocable.
 *
 *  Two rules shape it.
 *
 *  ONE TOKEN PER PERSON, reused. Minting a new one every time Share is tapped
 *  leaves a trail of live links nobody can see or count, and revoking becomes
 *  a thing you cannot actually do. Tapping Share twice gives the same link;
 *  revoking kills every copy of it at once.
 *
 *  WHAT THEY PAID IS NOT SHARED. The value of a collection is a fact about
 *  cards; the cost is a fact about the person's finances, and the gain is a
 *  statement about their judgement. A shared view carries the first and
 *  neither of the others — including per card, where `paid` would otherwise
 *  leak one purchase at a time.
 */
export const SHARES_SCHEMA = `
CREATE TABLE IF NOT EXISTS collection_shares (
  token       text PRIMARY KEY,
  user_id     text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  views       integer NOT NULL DEFAULT 0
);
`;

export async function initShares(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(SHARES_SCHEMA);
}

/** The caller's link, minted once and reused. */
export async function shareToken(userId: string): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  // Base64url of 12 bytes: short enough to read out, long enough that it
  // cannot be guessed, and it is a capability rather than an identifier —
  // so it never contains the user id.
  const fresh = randomBytes(12).toString("base64url");
  const r = await pool.query(
    `insert into collection_shares (token, user_id) values ($1, $2)
     on conflict (user_id) do update set revoked_at = null
     returning token`,
    [fresh, userId],
  );
  return r.rows[0]?.token ?? null;
}

export async function revokeShare(userId: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update collection_shares set revoked_at = now() where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function currentShare(userId: string): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select token from collection_shares where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return r.rows[0]?.token ?? null;
}

/** Who a token belongs to, and a view counted. Null once revoked. */
export async function ownerOf(token: string): Promise<{ userId: string; name: string } | null> {
  const pool = storePool();
  if (!pool || !token) return null;
  const r = await pool.query(
    `select s.user_id, u.name
       from collection_shares s join users u on u.user_id = s.user_id
      where s.token = $1 and s.revoked_at is null`,
    [token],
  );
  const row = r.rows[0];
  if (!row) return null;
  pool.query(`update collection_shares set views = views + 1 where token = $1`, [token])
    .catch(() => {});
  return { userId: row.user_id, name: row.name };
}
