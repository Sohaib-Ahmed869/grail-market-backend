import type { SetDetail, SetSummary } from "./sets.js";

// Four more catalogues, all free, none needing a key.
//
// These were on the "not yet wired" list for no better reason than that
// `games.ts` was built with five sources hardcoded into it and nobody went
// back. Each one below was called and its response shape read before this file
// was written — not taken from documentation.
//
//   Star Wars Unlimited   api.swu-db.com      sets endpoint + cards by set
//   Sorcery               api.sorcerytcg.com  every card in one call
//   Digimon               digimoncard.io      every card in one call
//   Grand Archive         api.gatcg.com       search only, sets crawled out
//
// What is NOT here, and why: apitcg.com, which our scan path already calls for
// Dragon Ball, Union Arena, Gundam and Riftbound. It authenticates and then
// answers "Datos no encontrados" to every query — including Pokemon/Pikachu
// and One Piece/Luffy, which certainly exist. It is serving nothing at all, so
// there is nothing to wire. See the note on `identifyApiTcg`.

const UA = { "User-Agent": "GrailMarket/1.0 (+https://grailmarket.com)" };

async function json<T>(url: string, ms = 20_000): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const iso = (d: unknown): string | null => {
  const s = String(d ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // swu-db writes dates as 7/11/25
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, mo, day, yr] = m;
  const y = yr!.length === 2 ? `20${yr}` : yr!;
  return `${y}-${mo!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
};

// ------------------------------------------------- Star Wars Unlimited (swu)

export async function swuSets(): Promise<SetSummary[]> {
  const raw = await json<any[]>("https://api.swu-db.com/sets");
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s?.setId)
    .map((s) => ({
      setId: `swu:${String(s.setId).toLowerCase()}`,
      name: String(s.fullName ?? s.setId),
      logo: null,
      symbol: null,
      total: Number(s.numberCards ?? 0) || 0,
      official: Number(s.numberCards ?? 0) || 0,
      releasedAt: iso(s.releaseDate),
    }));
}

export async function swuSetDetail(code: string, base: Omit<SetDetail, "cards">): Promise<SetDetail | null> {
  const r = await json<any>(
    `https://api.swu-db.com/cards/search?q=set:${encodeURIComponent(code)}`,
  );
  const list = r?.data;
  if (!Array.isArray(list) || !list.length) return null;
  return {
    ...base,
    total: list.length,
    cards: list.map((c: any) => ({
      cardId: `swu-${String(c.Set ?? code).toLowerCase()}-${c.Number ?? ""}`,
      name: String(c.Name ?? ""),
      localId: String(c.Number ?? ""),
      // Their card rows carry no image field; the tile falls back to the
      // placeholder rather than to a URL guessed from an id.
      imageUrl: null,
    })),
  };
}

// ------------------------------------------------------------------ Sorcery

/** Every Sorcery card in one call, with its set inside each printing.
 *
 *  1,100 cards, so it is fetched whole and pivoted here rather than asked for
 *  once per set. The set list and the set detail therefore cost one request
 *  between them, which is why both go through this. */
async function sorceryAll(): Promise<any[] | null> {
  return json<any[]>("https://api.sorcerytcg.com/api/cards", 25_000);
}

export async function sorcerySets(): Promise<SetSummary[]> {
  const all = await sorceryAll();
  if (!Array.isArray(all)) return [];
  const byCode = new Map<string, { name: string; released: string | null; n: number }>();
  for (const card of all) {
    for (const p of card?.printings ?? []) {
      const code = String(p?.set?.code ?? "").trim();
      const name = String(p?.set?.name ?? "").trim();
      if (!code || !name) continue;
      const row = byCode.get(code) ?? { name, released: iso(p?.set?.releasedAt), n: 0 };
      row.n += 1;
      byCode.set(code, row);
    }
  }
  return [...byCode.entries()].map(([code, r]) => ({
    setId: `sorcery:${code}`,
    name: r.name,
    logo: null,
    symbol: null,
    total: r.n,
    official: r.n,
    releasedAt: r.released,
  }));
}

export async function sorcerySetDetail(code: string, base: Omit<SetDetail, "cards">): Promise<SetDetail | null> {
  const all = await sorceryAll();
  if (!Array.isArray(all)) return null;
  const cards: SetDetail["cards"] = [];
  for (const card of all) {
    for (const p of card?.printings ?? []) {
      if (String(p?.set?.code ?? "") !== code) continue;
      cards.push({
        cardId: `sorcery-${p?.id ?? p?.slug ?? ""}`,
        name: String(card?.name ?? ""),
        // Their slug leads with the collector number — "004-13_treasures…".
        localId: String(p?.slug ?? "").split("-")[0] ?? "",
        imageUrl: null,
      });
    }
  }
  return cards.length ? { ...base, total: cards.length, cards } : null;
}

// ------------------------------------------------------------------ Digimon

/** Digimon publishes every card and no sets at all.
 *
 *  A card number carries its set — "BT5-103" is card 103 of Booster Set 5 — so
 *  the sets are derived from the prefix. The names are the codes themselves,
 *  because the source has no set names to give and inventing "Booster Set 5"
 *  for BT5 would be us guessing at a product name. */
async function digimonAll(): Promise<any[] | null> {
  return json<any[]>(
    "https://digimoncard.io/api-public/getAllCards?sort=name&series=Digimon%20Card%20Game",
    25_000,
  );
}

const digimonSetOf = (cardnumber: string): string | null => {
  const m = String(cardnumber).match(/^([A-Z]+\d*)-/i);
  return m ? m[1]!.toUpperCase() : null;
};

export async function digimonSets(): Promise<SetSummary[]> {
  const all = await digimonAll();
  if (!Array.isArray(all)) return [];
  const counts = new Map<string, number>();
  for (const c of all) {
    const code = digimonSetOf(c?.cardnumber ?? "");
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, n]) => ({
    setId: `digimon:${code}`,
    name: code,
    logo: null,
    symbol: null,
    total: n,
    official: n,
    releasedAt: null,
  }));
}

export async function digimonSetDetail(code: string, base: Omit<SetDetail, "cards">): Promise<SetDetail | null> {
  const all = await digimonAll();
  if (!Array.isArray(all)) return null;
  const cards = all
    .filter((c) => digimonSetOf(c?.cardnumber ?? "") === code)
    .map((c: any) => ({
      cardId: `digimon-${c.cardnumber}`,
      name: String(c?.name ?? ""),
      localId: String(c?.cardnumber ?? "").split("-")[1] ?? "",
      imageUrl: null,
    }));
  return cards.length ? { ...base, total: cards.length, cards } : null;
}

// ------------------------------------------------------------ Grand Archive

/** Grand Archive answers searches and publishes no set index.
 *
 *  So the sets are crawled out of the cards: a search per letter, and every
 *  edition's set collected. Thirty-six requests, cached for a day by the
 *  caller — the alternative is a game we cannot browse at all. */
async function gatcgCrawl(): Promise<any[]> {
  const out: any[] = [];
  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
  for (const letter of alphabet) {
    const r = await json<any>(
      `https://api.gatcg.com/cards/search?name=${letter}&page_size=100`,
      15_000,
    );
    if (Array.isArray(r?.data)) out.push(...r.data);
  }
  return out;
}

export async function gatcgSets(): Promise<SetSummary[]> {
  const cards = await gatcgCrawl();
  const byPrefix = new Map<string, { name: string; released: string | null; ids: Set<string> }>();
  for (const c of cards) {
    for (const e of c?.editions ?? []) {
      const prefix = String(e?.set?.prefix ?? "").trim();
      const name = String(e?.set?.name ?? "").trim();
      if (!prefix || !name) continue;
      const row = byPrefix.get(prefix)
        ?? { name, released: iso(e?.set?.release_date), ids: new Set<string>() };
      // Deduped: the crawl asks 26 overlapping questions and the same card
      // comes back under several letters.
      row.ids.add(String(e?.uuid ?? e?.slug ?? e?.card_id ?? ""));
      byPrefix.set(prefix, row);
    }
  }
  return [...byPrefix.entries()].map(([prefix, r]) => ({
    setId: `gatcg:${prefix}`,
    name: r.name,
    logo: null,
    symbol: null,
    total: r.ids.size,
    official: r.ids.size,
    releasedAt: r.released,
  }));
}

export async function gatcgSetDetail(prefix: string, base: Omit<SetDetail, "cards">): Promise<SetDetail | null> {
  const cards = await gatcgCrawl();
  const seen = new Set<string>();
  const out: SetDetail["cards"] = [];
  for (const c of cards) {
    for (const e of c?.editions ?? []) {
      if (String(e?.set?.prefix ?? "") !== prefix) continue;
      const id = String(e?.uuid ?? e?.slug ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        cardId: `gatcg-${id}`,
        name: String(c?.name ?? ""),
        localId: String(e?.collector_number ?? ""),
        imageUrl: e?.image ? `https://api.gatcg.com${e.image}` : null,
      });
    }
  }
  return out.length ? { ...base, total: out.length, cards: out } : null;
}
