import { storePool } from "../cards.store.js";

// Which cards this product is actually about.
//
// The pulse used to run off a list of eight card names typed into a file:
// Charizard, Pikachu, Sol Ring. It was a stand-in for a market and it never
// changed, so "what moved this week" was the same eight cards forever, none of
// which anybody here necessarily owns or wants.
//
// Demand is a thing we can measure. Every one of these is a person doing
// something deliberate with a card, and the weights are the order of how much
// each one costs them:
//
//   listed      3  putting it up for sale
//   watched     2  asking to be told when it moves
//   held        2  keeping it in a collection
//   scanned     1  pointing a camera at it
//
// A card nobody has touched scores nothing and is not in the list, which is
// the whole point — the board is made of what this market is trading.

export type Demanded = {
  catalogId: string;
  name: string;
  setName: string | null;
  game: string | null;
  imageUrl: string | null;
  /** The collector number, when a row carried one. The card page needs it to
   *  price, and it is the one field the board itself never used. */
  number?: string | null;
  demand: number;
};

export async function demandedCards(limit = 12): Promise<Demanded[]> {
  const pool = storePool();
  if (!pool) return [];

  const r = await pool.query(
    `
    with signal as (
      select catalog_id, card_name as name, set_name, game, image_url, 3 as w
        from listings
       where catalog_id is not null and status in ('live','sold')
      union all
      select catalog_id, card_name, set_name, null::text, image_url, 2
        from watchlist where catalog_id is not null
      union all
      select catalog_id, card_name, set_name, null::text, image_url, 2
        from collection where catalog_id is not null
      union all
      -- seen_count is how many times a scan landed on this card, so it is
      -- already a tally rather than one row per event. Capped, or one card
      -- scanned two hundred times during testing owns the board forever.
      select catalog_id, name, set_name, game, null::text, least(seen_count, 5)
        from catalog_cards where catalog_id is not null
    )
    select
      catalog_id,
      -- The longest name wins the tie. Rows disagree about punctuation and
      -- suffixes, and the fuller one is nearly always the real title.
      (array_agg(name order by length(name) desc))[1] as name,
      (array_agg(set_name order by (set_name is null), length(set_name) desc))[1] as set_name,
      (array_agg(game order by (game is null)))[1] as game,
      (array_agg(image_url order by (image_url is null)))[1] as image_url,
      sum(w)::int as demand
      from signal
     group by catalog_id
     order by demand desc, name
     limit $1
    `,
    [limit],
  );

  return r.rows.map((x) => ({
    catalogId: String(x.catalog_id),
    name: String(x.name),
    setName: x.set_name ?? null,
    game: x.game ?? null,
    imageUrl: x.image_url ?? null,
    demand: Number(x.demand),
  }));
}

/** One card's identity, by catalogue id.
 *
 *  The card page used to work this out on the phone by cutting the id at its
 *  last hyphen and asking for that as a set — `swsh7-215` gives `swsh7`, which
 *  is right, and it is right for nothing else. A One Piece id is
 *  `optcg-OP13-119`, so the cut produced `optcg-OP13`, while the set endpoint
 *  wants `optcg:OP13` with a colon; every One Piece card opened onto an empty
 *  page, including Portgas D Ace, which is the first card on the board. A
 *  Magic id is `mtg-<uuid>` and the set cannot be recovered from it at all, so
 *  no amount of fixing the cut would have finished the job.
 *
 *  An identity is not something to re-derive from a string when we already
 *  store it. This is the same union `demandedCards` runs on, narrowed to one
 *  id: anything the market can show has been listed, watched, held or
 *  scanned, so it is in here by construction.
 *
 *  Returns null for an id we hold nothing about, which is a real answer — the
 *  caller falls back to reading the set. */
export async function cardMeta(catalogId: string): Promise<Demanded | null> {
  const pool = storePool();
  if (!pool || !catalogId) return null;

  const r = await pool.query(
    `
    with signal as (
      select catalog_id, card_name as name, set_name, game, image_url, card_number
        from listings where catalog_id = $1
      union all
      select catalog_id, card_name, set_name, null::text, image_url, card_number
        from watchlist where catalog_id = $1
      union all
      select catalog_id, card_name, set_name, null::text, image_url, card_number
        from collection where catalog_id = $1
      union all
      select catalog_id, name, set_name, game, null::text, card_number
        from catalog_cards where catalog_id = $1
    )
    select
      catalog_id,
      -- Same tie-break as the board: the longest name wins, because rows
      -- disagree about punctuation and suffixes and the fuller one is nearly
      -- always the real title.
      (array_agg(name order by length(name) desc))[1] as name,
      (array_agg(set_name order by (set_name is null), length(set_name) desc))[1] as set_name,
      (array_agg(game order by (game is null)))[1] as game,
      -- Only a picture another device can actually fetch. A phone that saved
      -- a scan wrote its own ImagePicker path into the row -- a file:// URL
      -- under /var/mobile/Containers -- which resolves on exactly one handset
      -- and is a broken image everywhere else, including the one being
      -- demonstrated. Ordered so an http(s) row wins; a local path survives
      -- here only when nothing else exists, and is dropped in TypeScript.
      (array_agg(image_url order by (image_url is null), (image_url not like 'http%')))[1] as image_url,
      (array_agg(card_number order by (card_number is null)))[1] as card_number
      from signal
     where catalog_id is not null
     group by catalog_id
    `,
    [catalogId],
  );

  const x = r.rows[0];
  if (!x) return null;
  return {
    catalogId: String(x.catalog_id),
    name: String(x.name),
    setName: x.set_name ?? null,
    game: x.game ?? null,
    imageUrl:
      typeof x.image_url === "string" && x.image_url.startsWith("http")
        ? x.image_url
        : null,
    number: x.card_number ?? null,
    demand: 0,
  };
}
