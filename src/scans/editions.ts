import { TtlCache } from "./ttlcache.js";
import type { SetCard, SetDetail, SetSummary } from "./sets.js";

// Cards that are only what a catalogue says they are, and the language
// editions built out of them.
//
// Two kinds of card id arrive from a set listing rather than from a scan:
//
//   tcg-<game>-<productId>        a tcgcsv product (TCGplayer's catalogue),
//                                 including every Pokémon JAPAN card
//   lng-<code>-<pk|mtg>-<id>      a non-English printing: a TCGdex Pokémon
//                                 card in Chinese, Korean, French..., or a
//                                 Scryfall Magic print in Japanese, Russian...
//
// Both carry exactly one price that is really theirs: the catalogue's own
// figure for that product or that print. EVERY other source on the price chain
// finds a card by NAME — PokemonPriceTracker, JustTCG, The Card API, eBay — and
// a Japanese Pikachu asked for by name is answered with the English Pikachu.
// That is the confident-wrong defect the memory rule is about, and it would be
// written straight into the append-only sales ledger. So these ids are refused
// by name everywhere (pricing.ts, market.ts, thecardapi.ts, the controller),
// and the only figure they get is the one indexed here when their set was read.

// ---- the id test ---------------------------------------------------------------

export const isCatalogueOnlyCard = (id: string | null | undefined): boolean =>
  Boolean(id && /^(tcg|lng)-/.test(id));

// ---- the index -----------------------------------------------------------------

export type IndexedCard = {
  cardId: string;
  game: string;
  setId: string;
  setName: string;
  name: string;
  number: string | null;
  imageUrl: string | null;
  rawUsd: number | null;
};

const DAY = 24 * 3600 * 1000;

/** Everything a card page needs about a catalogue-only card, filled whenever
 *  its set is read. A card page is always opened from a set, so the set has
 *  been read first; after a restart the index is empty and the card answers
 *  with no price until its set is opened again — never with a name lookup. */
const index = new TtlCache<IndexedCard>(DAY, 60_000);

export function indexCatalogueCards(
  detail: Pick<SetDetail, "setId" | "name"> & { cards: SetCard[] },
  meta: { game: string },
): void {
  for (const c of detail.cards) {
    index.set(c.cardId, {
      cardId: c.cardId,
      game: meta.game,
      setId: detail.setId,
      setName: detail.name,
      name: c.name,
      number: c.localId || null,
      imageUrl: c.imageUrl,
      rawUsd: c.rawUsd,
    });
  }
}

export const indexedCard = (id: string): IndexedCard | null => index.get(id) ?? null;

/** What `/market/price` answers for a catalogue-only card: the normal shape,
 *  every name-matched field empty, and the catalogue's own figure where the
 *  index holds one. No figure says why, so the page can say so too. */
export function catalogueFigure(
  a: { name: string; setName?: string | null; number?: string | null; grader?: string | null; grade?: number | null },
  cardId: string,
) {
  const rawUsd = indexedCard(cardId)?.rawUsd ?? null;
  return {
    name: a.name,
    setName: a.setName ?? null,
    number: a.number ?? null,
    grader: a.grader ?? null,
    grade: a.grade ?? null,
    rawUsd,
    variants: [],
    variantsAmbiguous: false,
    byGrader: null,
    printings: null,
    velocity: null,
    sold: null,
    slabPrice: null,
    liveAsk: null,
    listings: [],
    shops: [],
    printingRead: null,
    ...(rawUsd == null ? { unpriceable: "catalogue-price-only" as const } : {}),
  };
}

/** How the asks panel should treat a catalogue-only card.
 *
 *  eBay titles say "Japanese" and "Chinese" often enough to narrow to them;
 *  they do not say "French" or "Korean" often enough to tell those prints
 *  from the English card, so a median over them would be the English price
 *  and is blanked. Without a card number the name alone cannot tell one
 *  product from another, so that median goes too. The rows stay: they are
 *  real asks, and the page labels them as asks. */
export function listingPolicy(
  cardId: string | null | undefined,
  number: string | null | undefined,
): { language: "ja" | "zh" | null; blankMedian: boolean } | null {
  if (!isCatalogueOnlyCard(cardId)) return null;
  const id = String(cardId);
  let language: "ja" | "zh" | null = null;
  let unreadable = false;
  if (id.startsWith("tcg-pokemonjp-")) language = "ja";
  const ed = readEditionCard(id);
  if (ed) {
    const l = ed.edition.language;
    if (l === "ja") language = "ja";
    else if (/^zh/.test(l)) language = "zh";
    else unreadable = true;
  }
  return { language, blankMedian: unreadable || !String(number ?? "").trim() };
}

// ---- editions --------------------------------------------------------------------

export type Edition = {
  /** the game id: `lang:<baseGame>:<code>` */
  id: string;
  baseGame: "pokemon" | "mtg";
  /** the provider's language code: TCGdex's `zh-tw`, Scryfall's `zhs` */
  language: string;
  languageName: string;
  /** the base game's display name — the app labels the language beside it */
  name: string;
  /** `ja` everywhere, id-safe everything else */
  safe: string;
};

const POKEMON_LANGS: [string, string][] = [
  ["zh-tw", "Chinese (Traditional)"], ["zh-cn", "Chinese (Simplified)"], ["ko", "Korean"],
  ["th", "Thai"], ["id", "Indonesian"], ["fr", "French"], ["de", "German"], ["es", "Spanish"],
  ["it", "Italian"], ["pt-br", "Portuguese (Brazil)"],
];

const MTG_LANGS: [string, string][] = [
  ["ja", "Japanese"], ["zhs", "Chinese (Simplified)"], ["zht", "Chinese (Traditional)"], ["ko", "Korean"],
  ["ru", "Russian"], ["de", "German"], ["fr", "French"], ["it", "Italian"], ["es", "Spanish"], ["pt", "Portuguese"],
];

const safeCode = (code: string) => code.replace(/-/g, "_");

/** Japanese Pokémon is not here: it is `pokemonjp`, from tcgcsv, which carries
 *  TCGplayer's prices. A second Japanese Pokémon from TCGdex would be the same
 *  cards twice with one of them unpriced. */
export const EDITIONS: Edition[] = [
  ...MTG_LANGS.filter(([c]) => c === "ja").map(([c, n]) => mk("mtg", c, n)),
  ...POKEMON_LANGS.map(([c, n]) => mk("pokemon", c, n)),
  ...MTG_LANGS.filter(([c]) => c !== "ja").map(([c, n]) => mk("mtg", c, n)),
];

function mk(baseGame: "pokemon" | "mtg", language: string, languageName: string): Edition {
  return {
    id: `lang:${baseGame}:${language}`,
    baseGame, language, languageName,
    name: baseGame === "pokemon" ? "Pokémon" : "Magic: The Gathering",
    safe: safeCode(language),
  };
}

const byId = new Map(EDITIONS.map((e) => [e.id, e]));
const bySafe = new Map(EDITIONS.map((e) => [`${e.safe}|${e.baseGame}`, e]));

export const isEditionGame = (id: string | null | undefined): boolean => Boolean(id && byId.has(id));
export const editionOf = (id: string | null | undefined): Edition | null => (id ? byId.get(id) ?? null : null);

/** The edition fields a games-list row carries. `pokemonjp` is an edition in
 *  every sense but its source, so it answers here too. */
export function editionFields(gameId: string): { name?: string; baseGame: string; language: string; languageName: string } | null {
  // Its catalogue calls it "Pokémon (Japan)"; the tile already carries the
  // language as a label, and every other edition is named as its base game.
  if (gameId === "pokemonjp") return { name: "Pokémon", baseGame: "pokemon", language: "ja", languageName: "Japanese" };
  const e = editionOf(gameId);
  return e ? { baseGame: e.baseGame, language: e.language, languageName: e.languageName } : null;
}

export const editionSetId = (gameId: string, code: string): string => `${gameId}:${code}`;

export function readEditionSetId(setId: string): { edition: Edition; code: string } | null {
  const m = /^(lang:[a-z]+:[a-z-]+):(.+)$/.exec(setId ?? "");
  const edition = m ? editionOf(m[1]) : null;
  return m && edition ? { edition, code: m[2] } : null;
}

const SOURCE = { pokemon: "pk", mtg: "mtg" } as const;

export const editionCardId = (e: Edition, providerId: string): string =>
  `lng-${e.safe}-${SOURCE[e.baseGame]}-${providerId}`;

export function readEditionCard(id: string): { edition: Edition; providerId: string } | null {
  const m = /^lng-([a-z_]+)-(pk|mtg)-(.+)$/.exec(id ?? "");
  if (!m) return null;
  const edition = bySafe.get(`${m[1]}|${m[2] === "pk" ? "pokemon" : "mtg"}`);
  return edition ? { edition, providerId: m[3] } : null;
}

// ---- Pokémon, from TCGdex's language endpoints ------------------------------------

const TCGDEX = "https://api.tcgdex.net/v2";

/** TCGdex lists a language's sets oldest first, with no release date on the
 *  list — the same order its English list has, which sets.ts reverses. */
export function pokemonEditionSetsFrom(raw: any[], e: Edition): SetSummary[] {
  return (raw ?? [])
    .filter((s) => s?.id && s?.name)
    .map((s) => ({
      setId: editionSetId(e.id, String(s.id)),
      name: String(s.name),
      logo: s.logo ? `${s.logo}.png` : null,
      symbol: s.symbol ? `${s.symbol}.png` : null,
      total: Number(s.cardCount?.total ?? 0),
      official: Number(s.cardCount?.official ?? 0),
      releasedAt: null,
    }))
    .reverse();
}

/** No price: TCGdex's pricing block is English TCGplayer and Cardmarket, and
 *  pinning it to a Korean print would be the English card's price again. */
export function pokemonEditionDetailFrom(raw: any, e: Edition): SetDetail {
  const cards: SetCard[] = (raw?.cards ?? []).map((c: any) => ({
    cardId: editionCardId(e, String(c.id)),
    name: String(c.name ?? ""),
    localId: String(c.localId ?? ""),
    imageUrl: c.image ? `${c.image}/low.png` : null,
    rawUsd: null,
    rarity: null,
  }));
  return {
    setId: editionSetId(e.id, String(raw?.id ?? "")),
    name: String(raw?.name ?? ""),
    logo: raw?.logo ? `${raw.logo}.png` : null,
    symbol: raw?.symbol ? `${raw.symbol}.png` : null,
    total: Number(raw?.cardCount?.total ?? cards.length),
    official: Number(raw?.cardCount?.official ?? cards.length),
    releasedAt: raw?.releaseDate ?? null,
    cards,
  };
}

// ---- Magic, from Scryfall ---------------------------------------------------------

const SCRYFALL = "https://api.scryfall.com";

/** Which sets exist in a language, read off the cards that do.
 *
 *  Scryfall's set list has no language field, and listing all 988 paper sets
 *  under "Japanese" would be mostly doors onto nothing — Russian Magic stopped,
 *  Korean paused for years, Alpha was never translated at all. Asking for the
 *  first three collector numbers in a language returns about one card per set
 *  that was printed in it: measured on 2026-09-14 as 255 Japanese sets in 5
 *  pages, 162 Simplified Chinese in 3, 63 Korean in 2, 88 Russian in 2 (number
 *  1 alone missed Adventures in the Forgotten Realms, which starts elsewhere).
 *  Two to five calls per language per day, instead of a guess. */
export function mtgEditionSetsFrom(cards: any[], e: Edition): SetSummary[] {
  const seen = new Map<string, SetSummary>();
  for (const c of cards ?? []) {
    const code = String(c?.set ?? "");
    if (!code || seen.has(code)) continue;
    seen.set(code, {
      setId: editionSetId(e.id, code),
      name: String(c.set_name ?? code),
      logo: null,
      symbol: `https://svgs.scryfall.io/sets/${code}.svg`,
      // How many cards the set has in THIS language is not something any call
      // here measured, so it is not claimed.
      total: 0,
      official: 0,
      releasedAt: c.released_at ?? null,
    });
  }
  return [...seen.values()].sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
}

const usd = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

/** The printed name, the print's own picture, and Scryfall's own USD figure
 *  for that exact print id — the one price here that belongs to this object
 *  and no other. It is null on almost every non-English print, and stays so. */
export function mtgEditionDetailFrom(
  cards: any[],
  e: Edition,
  code: string,
  summary: { name: string; releasedAt: string | null },
): SetDetail & { note?: string } {
  const out: SetCard[] = (cards ?? []).map((c: any) => {
    const faces: any[] = Array.isArray(c.card_faces) ? c.card_faces : [];
    const printed = c.printed_name
      ?? (faces.length && faces.some((f) => f?.printed_name)
        ? faces.map((f) => f?.printed_name ?? f?.name).filter(Boolean).join(" // ")
        : null);
    return {
      cardId: editionCardId(e, String(c.id)),
      name: String(printed ?? c.name ?? ""),
      localId: String(c.collector_number ?? ""),
      imageUrl: c.image_uris?.normal ?? faces[0]?.image_uris?.normal ?? null,
      rawUsd: usd(c.prices?.usd),
      rarity: c.rarity ?? null,
    };
  });
  return {
    setId: editionSetId(e.id, code),
    name: summary.name,
    logo: null,
    symbol: `https://svgs.scryfall.io/sets/${code}.svg`,
    total: out.length,
    official: out.length,
    releasedAt: summary.releasedAt,
    cards: out,
    ...(out.length ? {} : { note: `This set was not printed in ${e.languageName}.` }),
  };
}

// ---- calling out -------------------------------------------------------------------

const UA = { "User-Agent": "GrailMarket/1.0 (+https://grailcard.com.au)", Accept: "application/json" };

/** Scryfall asks for 50–100ms between requests. Ten language editions warming
 *  at once would otherwise arrive together, so their calls queue here. */
let scryfallTail: Promise<unknown> = Promise.resolve();
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = scryfallTail.then(fn, fn);
  scryfallTail = run.then(() => new Promise((r) => setTimeout(r, 110)), () => new Promise((r) => setTimeout(r, 110)));
  return run;
}

/** `null` on failure; `{ status: 404 }` when the source says there is nothing. */
async function getJson(url: string, scryfall = false): Promise<{ status: number; body: any } | null> {
  const go = async () => {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) return { status: 404, body: null };
      if (!r.ok) return null;
      return { status: r.status, body: await r.json() };
    } catch {
      return null;
    }
  };
  return scryfall ? paced(go) : go();
}

/** Every page of a Scryfall search, up to `maxPages`. Null when any page
 *  failed — a half-read list is not cached as the whole of it. */
async function scryfallAll(q: string, maxPages: number): Promise<any[] | null> {
  let url: string | null = `${SCRYFALL}/cards/search?${new URLSearchParams({ q, unique: "prints", order: "set" })}`;
  const out: any[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const r = await getJson(url, true);
    if (!r) return null;
    if (r.status === 404) return out;
    out.push(...(r.body?.data ?? []));
    url = r.body?.has_more ? r.body.next_page : null;
  }
  return out;
}

export async function editionSets(gameId: string): Promise<SetSummary[]> {
  const e = editionOf(gameId);
  if (!e) return [];
  if (e.baseGame === "pokemon") {
    const r = await getJson(`${TCGDEX}/${e.language}/sets`);
    return r?.status === 200 && Array.isArray(r.body) ? pokemonEditionSetsFrom(r.body, e) : [];
  }
  const cards = await scryfallAll(`lang:${e.language} (number:1 or number:2 or number:3)`, 8);
  return cards ? mtgEditionSetsFrom(cards, e) : [];
}

/** A language set, read and indexed. Null means the source could not be
 *  reached (not cached upstream); an empty `cards` means it answered that
 *  the set has no printing in this language, which is a real answer. */
export async function editionSetDetail(
  setId: string,
  known: SetSummary[] | undefined,
): Promise<(SetDetail & { note?: string }) | null> {
  const read = readEditionSetId(setId);
  if (!read) return null;
  const { edition: e, code } = read;
  let detail: (SetDetail & { note?: string }) | null = null;
  if (e.baseGame === "pokemon") {
    const r = await getJson(`${TCGDEX}/${e.language}/sets/${encodeURIComponent(code)}`);
    if (!r) return null;
    detail = r.status === 404
      ? { setId, name: code, logo: null, symbol: null, total: 0, official: 0, releasedAt: null, cards: [], note: `This set was not printed in ${e.languageName}.` }
      : pokemonEditionDetailFrom(r.body, e);
  } else {
    // A set runs to a few hundred prints; 175 a page, capped at six pages so
    // one Secret Lair-sized oddity cannot hold a request for a minute.
    const cards = await scryfallAll(`set:${code} lang:${e.language}`, 6);
    if (!cards) return null;
    const summary = known?.find((s) => s.setId === setId);
    detail = mtgEditionDetailFrom(cards, e, code, {
      name: summary?.name ?? cards[0]?.set_name ?? code,
      releasedAt: summary?.releasedAt ?? cards[0]?.released_at ?? null,
    });
  }
  indexCatalogueCards(detail, { game: e.id });
  return detail;
}
