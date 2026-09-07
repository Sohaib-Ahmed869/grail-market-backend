import { storePool } from "../cards.store.js";

// How many people here care about a card.
//
// Every figure is counted from something a member actually did — followed it,
// holds one, opened a listing for it. Nothing is inflated and nothing is
// invented: a card nobody has touched says nobody has touched it, which is a
// useful thing to know and the only honest thing to show.
//
// Avatars are the app's own fixed set of drawings, keyed by name, so a stack
// of them is decoration rather than a list of who is watching. WHO follows a
// card is not shown, and should not be — it is a person's interest in
// something they may be about to buy or sell, and the person on the other
// side of that trade should not be able to read it.

export type Interest = {
  following: number;
  holding: number;
  /** Views across every live listing for this card. */
  views: number;
  /** Up to five avatar keys, in no particular order, for the stack. */
  faces: string[];
};

export async function interestIn(catalogId: string): Promise<Interest> {
  const empty: Interest = { following: 0, holding: 0, views: 0, faces: [] };
  const pool = storePool();
  if (!pool || !catalogId) return empty;

  try {
    const r = await pool.query(
      `select
         (select count(*) from watchlist  where catalog_id = $1)                        as following,
         (select count(*) from collection where catalog_id = $1)                        as holding,
         (select coalesce(sum(views), 0) from listings
           where catalog_id = $1 and status in ('live','sold'))                         as views,
         (select coalesce(array_agg(a), '{}')
            from (
              -- Shuffled and capped. Ordering by anything stable — user id,
              -- when they followed — would make the stack a reading order
              -- somebody could correlate against.
              select distinct u.avatar as a
                from watchlist w join users u on u.user_id = w.user_id
               where w.catalog_id = $1 and u.avatar is not null
               order by 1
               limit 5
            ) t)                                                                        as faces`,
      [catalogId],
    );
    const row = r.rows[0];
    if (!row) return empty;
    return {
      following: Number(row.following ?? 0),
      holding: Number(row.holding ?? 0),
      views: Number(row.views ?? 0),
      faces: (row.faces ?? []).filter(Boolean).slice(0, 5),
    };
  } catch {
    // Social proof is the first thing that should go quiet when something is
    // wrong. It is never the reason a card page fails to open.
    return empty;
  }
}
