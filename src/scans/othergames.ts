import type { Identification, Valuation } from "@grailcard/shared";
import { bestAgainst } from "./similarity.js";

const MIN_SCORE = 0.6;

export type CatalogMatch = {
  identification: Identification;
  valuation: Valuation | null;
};

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "grailcard/0.1" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Magic: The Gathering via Scryfall (free, no key). */
export async function identifyScryfall(names: string[]): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const q = encodeURIComponent(names[0]);
  const body = (await fetchJson(
    `https://api.scryfall.com/cards/search?q=${q}&unique=cards&order=relevance`,
  )) as { data?: Record<string, any>[] } | null;
  const cards = body?.data ?? [];
  let best: { card: Record<string, any>; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const m = bestAgainst(names, card.name as string);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;

  const c = best.card;
  const identification: Identification = {
    cardId: `scryfall-${c.id}`,
    name: c.name,
    setId: c.set ?? "",
    setName: c.set_name ?? "",
    localId: String(c.collector_number ?? ""),
    rarity: c.rarity ?? null,
    imageUrl: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
    matchScore: Math.min(best.score, 1),
    ocrName: best.name,
    game: "mtg",
  };
  const usd = c.prices?.usd ? Number(c.prices.usd) : null;
  const eur = c.prices?.eur ? Number(c.prices.eur) : null;
  const valuation: Valuation | null =
    usd != null || eur != null
      ? {
          source: "scryfall",
          updatedAt: null,
          tcgplayer:
            usd != null
              ? { unit: "USD", variant: "normal", low: null, mid: null, high: null, market: usd }
              : null,
          cardmarket: eur != null ? { unit: "EUR", low: null, trend: eur, avg30: null } : null,
        }
      : null;
  return { identification, valuation };
}

/** Disney Lorcana via Lorcast (free, no key, includes USD prices). */
export async function identifyLorcana(names: string[]): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const body = (await fetchJson(
    `https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent(names[0])}`,
  )) as any;
  const cards = (body?.results ?? []) as any[];
  let best: { card: any; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const full = [card.name, card.version].filter(Boolean).join(" ");
    const m = bestAgainst(names, full);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;
  const c = best.card;
  const usd = c.prices?.usd ? Number(c.prices.usd) : null;
  return {
    identification: {
      cardId: `lorcana-${c.id}`,
      name: [c.name, c.version].filter(Boolean).join(" — "),
      setId: c.set?.code ?? "",
      setName: c.set?.name ?? "",
      localId: String(c.collector_number ?? ""),
      rarity: c.rarity ?? null,
      imageUrl: c.image_uris?.digital?.normal ?? c.image_uris?.digital?.small ?? null,
      matchScore: Math.min(best.score, 1),
      ocrName: best.name,
      game: "lorcana",
    },
    valuation:
      usd != null
        ? {
            source: "lorcast",
            updatedAt: null,
            tcgplayer: { unit: "USD", variant: "normal", low: null, mid: null, high: null, market: usd },
            cardmarket: null,
          }
        : null,
  };
}

/** Digimon Card Game via digimoncard.io (free, no key, no prices). */
export async function identifyDigimon(names: string[]): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const body = await fetchJson(
    `https://digimoncard.io/api-public/search.php?n=${encodeURIComponent(names[0])}`,
  );
  const cards = (Array.isArray(body) ? body : []) as any[];
  let best: { card: any; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const m = bestAgainst(names, card.name as string);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;
  const c = best.card;
  return {
    identification: {
      cardId: `digimon-${c.id}`,
      name: c.name,
      setId: String(c.id ?? "").split("-")[0],
      setName: String(c.id ?? "").split("-")[0],
      localId: String(c.id ?? ""),
      rarity: c.rarity ?? null,
      imageUrl: c.id ? `https://images.digimoncard.io/images/cards/${c.id}.jpg` : null,
      matchScore: Math.min(best.score, 1),
      ocrName: best.name,
      game: "digimon",
    },
    valuation: null,
  };
}

/** Star Wars: Unlimited via swu-db (free, no key, includes market prices). */
export async function identifySwu(names: string[]): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const body = (await fetchJson(
    `https://api.swu-db.com/cards/search?q=${encodeURIComponent(names[0])}`,
  )) as any;
  const cards = (body?.data ?? []) as any[];
  let best: { card: any; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const full = [card.Name, card.Subtitle].filter(Boolean).join(" ");
    const m = bestAgainst(names, full);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;
  const c = best.card;
  const market = c.MarketPrice != null ? Number(c.MarketPrice) : null;
  return {
    identification: {
      cardId: `swu-${c.Set}-${c.Number}`,
      name: [c.Name, c.Subtitle].filter(Boolean).join(" — "),
      setId: c.Set ?? "",
      setName: c.Set ?? "",
      localId: String(c.Number ?? ""),
      rarity: c.Rarity ?? null,
      imageUrl: c.FrontArt ?? null,
      matchScore: Math.min(best.score, 1),
      ocrName: best.name,
      game: "starwars",
    },
    valuation:
      market != null && Number.isFinite(market)
        ? {
            source: "swu-db",
            updatedAt: null,
            tcgplayer: { unit: "USD", variant: "normal", low: null, mid: null, high: null, market },
            cardmarket: null,
          }
        : null,
  };
}

/** One Piece TCG via optcgapi (free, no key). Looked up by the set code
 *  printed on the card (e.g. OP07-109), which works even on Japanese
 *  printings where the name can't be OCR'd. */
export async function identifyOnePiece(setCode: string | null | undefined): Promise<CatalogMatch | null> {
  if (!setCode || !/^(OP|ST|EB|PRB)\d{2}-\d{3}$/i.test(setCode)) return null;
  const list = (await fetchJson(
    `https://optcgapi.com/api/sets/card/${encodeURIComponent(setCode.toUpperCase())}/`,
  )) as Record<string, any>[] | null;
  const c = list?.[0];
  if (!c?.card_name) return null;

  const identification: Identification = {
    cardId: `optcg-${c.card_set_id}`,
    name: String(c.card_name).replace(/\s*\(\d+\)\s*$/, ""),
    setId: c.set_id ?? "",
    setName: c.set_name ?? "",
    localId: c.card_set_id ?? setCode,
    rarity: c.rarity ?? null,
    imageUrl: c.card_image ?? null,
    matchScore: 1, // exact set-code match
    ocrName: setCode.toUpperCase(),
    game: "onepiece",
  };
  const market = c.market_price != null ? Number(c.market_price) : null;
  const valuation: Valuation | null =
    market != null
      ? {
          source: "optcgapi",
          updatedAt: c.date_scraped ?? null,
          tcgplayer: {
            unit: "USD",
            variant: "normal",
            low: c.inventory_price != null ? Number(c.inventory_price) : null,
            mid: null,
            high: null,
            market,
          },
          cardmarket: null,
        }
      : null;
  return { identification, valuation };
}

/** Yu-Gi-Oh! via YGOPRODeck (free, no key). */
export async function identifyYgo(names: string[]): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const q = encodeURIComponent(names[0]);
  const body = (await fetchJson(
    `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${q}`,
  )) as { data?: Record<string, any>[] } | null;
  const cards = body?.data ?? [];
  let best: { card: Record<string, any>; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const m = bestAgainst(names, card.name as string);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;

  const c = best.card;
  const prices = c.card_prices?.[0] ?? {};
  const tp = prices.tcgplayer_price ? Number(prices.tcgplayer_price) : null;
  const cm = prices.cardmarket_price ? Number(prices.cardmarket_price) : null;
  const identification: Identification = {
    cardId: `ygo-${c.id}`,
    name: c.name,
    setId: c.card_sets?.[0]?.set_code ?? "",
    setName: c.card_sets?.[0]?.set_name ?? "",
    localId: String(c.card_sets?.[0]?.set_code ?? ""),
    rarity: c.card_sets?.[0]?.set_rarity ?? null,
    imageUrl: c.card_images?.[0]?.image_url ?? null,
    matchScore: Math.min(best.score, 1),
    ocrName: best.name,
    game: "yugioh",
  };
  const valuation: Valuation | null =
    tp != null || cm != null
      ? {
          source: "ygoprodeck",
          updatedAt: null,
          tcgplayer:
            tp != null
              ? { unit: "USD", variant: "normal", low: null, mid: null, high: null, market: tp }
              : null,
          cardmarket: cm != null ? { unit: "EUR", low: null, trend: cm, avg30: null } : null,
        }
      : null;
  return { identification, valuation };
}
