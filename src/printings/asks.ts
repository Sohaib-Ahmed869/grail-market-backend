import { TtlCache } from "../scans/ttlcache.js";

/** Listed prices per PRINTING, from the feed we already pay for.
 *
 *  TCGplayer's market price is derived from sales, which makes it the better
 *  number — and it does not exist for the cards that matter most. Product
 *  657401, the Red Super Alternate Art Luffy, carries no market price and a
 *  99999 "none listed" sentinel on every field, because nobody lists a card
 *  that scarce on TCGplayer. eBay's asking pool does not contain one either:
 *  a search for OP13-118 comes back entirely as the base Secret Rare at
 *  thirteen to twenty-five dollars. So the card the client asked about had no
 *  price anywhere we could read, and the app said A$197.
 *
 *  JustTCG has it, and has had all along. It returns the five printings as
 *  five cards, each carrying `tcgplayerId` — so this joins to the printings
 *  table on an EXACT id with no name matching anywhere in it, which is the
 *  property that makes it safe to trust. The Red Super Alternate Art comes
 *  back at US$19,999.
 *
 *  What comes back is an ASK, not a sale: the lowest Near Mint copy someone
 *  is listing. It is labelled that way all the way to the screen and never
 *  merged into a figure called a market price. A card with no sales has an
 *  asking price and no market price, and saying so is the honest shape of it.
 */

const GAME_SLUG: Record<string, string> = {
  pokemon: "pokemon",
  mtg: "magic-the-gathering",
  yugioh: "yugioh",
  onepiece: "one-piece-card-game",
  lorcana: "disney-lorcana",
  digimon: "digimon-card-game",
  swu: "star-wars-unlimited",
};

export type Ask = { usd: number; condition: string | null };

const cache = new TtlCache<Map<number, Ask>>(6 * 3600_000, 500);

/** Conditions worst to best. A Near Mint ask is the one worth quoting; a
 *  Damaged copy of a twenty-thousand-dollar card is a different product and
 *  quoting it would understate by an order of magnitude. */
const RANK: Record<string, number> = {
  "near mint": 5, "lightly played": 4, "moderately played": 3,
  "heavily played": 2, damaged: 1,
};

/** Listed prices for one collector number, keyed by TCGplayer product id. */
export async function asksByProduct(game: string, number: string): Promise<Map<number, Ask>> {
  const slug = GAME_SLUG[game];
  const key = process.env.JUSTTCG_API_KEY;
  const out = new Map<number, Ask>();
  if (!slug || !key || !number) return out;

  const ck = `${game}:${number}`;
  const hit = cache.get(ck);
  if (hit) return hit;

  try {
    const r = await fetch(
      `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(number)}&game=${slug}&limit=20`,
      { headers: { "x-api-key": key }, signal: AbortSignal.timeout(15_000) },
    );
    if (!r.ok) return out;
    const body = (await r.json()) as any;

    for (const card of body?.data ?? []) {
      const pid = Number(card?.tcgplayerId);
      // No id, no join. A name is not an identity here — five of these cards
      // differ by one word and two thousand dollars.
      if (!Number.isFinite(pid) || pid <= 0) continue;
      // Only this exact collector number: the feed answers a number query
      // with anything that mentions it.
      if (String(card?.number ?? "").toUpperCase() !== number.toUpperCase()) continue;

      let best: Ask | null = null;
      for (const v of card?.variants ?? []) {
        const usd = Number(v?.price);
        if (!Number.isFinite(usd) || usd <= 0) continue;
        const cond = v?.condition ? String(v.condition) : null;
        const rank = RANK[(cond ?? "").toLowerCase()] ?? 0;
        const bestRank = RANK[(best?.condition ?? "").toLowerCase()] ?? 0;
        // Best condition wins; among equals, the cheapest ask.
        if (!best || rank > bestRank || (rank === bestRank && usd < best.usd)) {
          best = { usd, condition: cond };
        }
      }
      if (best) out.set(pid, best);
    }
  } catch {
    // A feed that is slow or down costs freshness, never a page.
    return out;
  }

  if (out.size) cache.set(ck, out);
  return out;
}
