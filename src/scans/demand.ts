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
