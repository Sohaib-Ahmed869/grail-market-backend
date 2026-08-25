import type { Valuation } from "@grailcard/shared";
import { similarity } from "./similarity.js";
import { recordUsage } from "./usage.js";

// JustTCG: prices for 18 TCGs — fills gaps where the free catalog has no
// prices (Digimon, Union Arena, Dragon Ball, ...). FREE tier: 1,000 req/mo.
// Dormant until JUSTTCG_API_KEY is set in apps/api/.env.

const GAME_MAP: Record<string, string> = {
  pokemon: "pokemon",
  mtg: "magic-the-gathering",
  yugioh: "yugioh",
  onepiece: "one-piece-card-game",
  lorcana: "disney-lorcana",
  digimon: "digimon-card-game",
  starwars: "star-wars-unlimited",
  dragonball: "dragon-ball-super-fusion-world",
  gundam: "gundam-card-game",
  unionarena: "union-arena",
  riftbound: "riftbound-league-of-legends-trading-card-game",
};

async function search(key: string, q: string, gameSlug?: string): Promise<any[]> {
  const game = gameSlug ? `&game=${gameSlug}` : "";
  recordUsage("justtcg");
  const res = await fetch(
    `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(q)}${game}&limit=8`,
    { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as any;
  return (body?.data ?? body?.cards ?? []) as any[];
}

const priceCache = new Map<string, { at: number; v: Valuation | null }>();
const CACHE_TTL = 12 * 3600 * 1000;

export async function fetchJustTcgPrice(
  cardName: string,
  game: string,
  setName?: string | null,
): Promise<Valuation | null> {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return null;

  const cacheKey = `${game}|${cardName}|${setName ?? ""}`;
  const hit = priceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.v;

  try {
    const mapped = GAME_MAP[game];
    let items = mapped ? await search(key, cardName, mapped) : [];
    if (items.length === 0) {
      items = await search(key, cardName);
    }
    // on EVERY path, only a STRONG name match may be priced — and when we
    // know the SET, it must match too. Symbol-stripped names collide
    // ("Charizard ☆ δ" ≈ "Charizard"), and a $93 Arceus-set Charizard price
    // was attached to a $10k+ Dragon Frontiers Gold Star.
    items = items.filter((it) => {
      if (similarity(cardName, String(it.name ?? "")) < 0.8) return false;
      if (setName && it.set_name && similarity(setName, String(it.set_name)) < 0.5) return false;
      return true;
    });
    const first = items[0];
    if (!first) {
      priceCache.set(cacheKey, { at: Date.now(), v: null });
      return null;
    }
    const variant = (first.variants ?? [])[0] ?? first;
    const price =
      variant.price ?? variant.marketPrice ?? variant.nm ?? first.price ?? null;
    if (price == null) return null;
    const v: Valuation = {
      source: "justtcg",
      updatedAt: null,
      tcgplayer: {
        unit: "USD",
        variant: String(variant.condition ?? variant.printing ?? "normal"),
        low: null,
        mid: null,
        high: null,
        market: Number(price),
      },
      cardmarket: null,
    };
    priceCache.set(cacheKey, { at: Date.now(), v });
    return v;
  } catch {
    return null;
  }
}
