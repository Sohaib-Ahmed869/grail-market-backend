import type { Identification } from "@grailcard/shared";

// "More from this set" — sibling cards with live prices, all from the free
// catalog APIs already in use. Best-effort: any failure returns null and the
// UI simply omits the section.

export type RelatedCard = {
  name: string;
  localId: string;
  imageUrl: string | null;
  price: number | null;
  unit: string;
};

const LIMIT = 8;

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "grailcard/0.1" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function relatedPokemon(idn: Identification): Promise<RelatedCard[] | null> {
  const set = await fetchJson(`https://api.tcgdex.net/v2/en/sets/${idn.setId}`);
  const cards = (set?.cards ?? []) as any[];
  const siblings = cards.filter((c) => c.id !== idn.cardId).slice(0, LIMIT);
  const detailed = await Promise.all(
    siblings.map((c) => fetchJson(`https://api.tcgdex.net/v2/en/cards/${c.id}`)),
  );
  return siblings.map((c, i) => {
    const tp = detailed[i]?.pricing?.tcgplayer;
    let price: number | null = null;
    if (tp) {
      for (const variant of ["holofoil", "normal", "reverseHolofoil"]) {
        if (tp[variant]?.marketPrice != null) {
          price = tp[variant].marketPrice;
          break;
        }
      }
    }
    return {
      name: c.name,
      localId: String(c.localId ?? ""),
      imageUrl: c.image ? `${c.image}/low.png` : null,
      price,
      unit: "USD",
    };
  });
}

async function relatedMtg(idn: Identification): Promise<RelatedCard[] | null> {
  const body = await fetchJson(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`e:${idn.setId}`)}&order=collector_number`,
  );
  const cards = (body?.data ?? []) as any[];
  return cards
    .filter((c) => `scryfall-${c.id}` !== idn.cardId)
    .slice(0, LIMIT)
    .map((c) => ({
      name: c.name,
      localId: String(c.collector_number ?? ""),
      imageUrl: c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small ?? null,
      price: c.prices?.usd ? Number(c.prices.usd) : null,
      unit: "USD",
    }));
}

async function relatedYgo(idn: Identification): Promise<RelatedCard[] | null> {
  if (!idn.setName) return null;
  const body = await fetchJson(
    `https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=${encodeURIComponent(idn.setName)}`,
  );
  const cards = (body?.data ?? []) as any[];
  return cards
    .filter((c) => `ygo-${c.id}` !== idn.cardId)
    .slice(0, LIMIT)
    .map((c) => ({
      name: c.name,
      localId: String(c.card_sets?.[0]?.set_code ?? ""),
      imageUrl: c.card_images?.[0]?.image_url_small ?? null,
      price: c.card_prices?.[0]?.tcgplayer_price
        ? Number(c.card_prices[0].tcgplayer_price)
        : null,
      unit: "USD",
    }));
}

async function relatedOnePiece(idn: Identification): Promise<RelatedCard[] | null> {
  const body = await fetchJson(
    `https://optcgapi.com/api/sets/${encodeURIComponent(idn.setId)}/`,
  );
  const cards = (Array.isArray(body) ? body : []) as any[];
  return cards
    .filter((c) => c.card_set_id !== idn.localId)
    .slice(0, LIMIT)
    .map((c) => ({
      name: String(c.card_name ?? "").replace(/\s*\(\d+\)\s*$/, ""),
      localId: String(c.card_set_id ?? ""),
      imageUrl: c.card_image ?? null,
      price: c.market_price != null ? Number(c.market_price) : null,
      unit: "USD",
    }));
}

export async function fetchRelated(idn: Identification): Promise<RelatedCard[] | null> {
  try {
    const list =
      idn.game === "pokemon"
        ? await relatedPokemon(idn)
        : idn.game === "mtg"
          ? await relatedMtg(idn)
          : idn.game === "yugioh"
            ? await relatedYgo(idn)
            : idn.game === "onepiece"
              ? await relatedOnePiece(idn)
              : null;
    return list && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}
