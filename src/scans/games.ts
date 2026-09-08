import { TtlCache } from "./ttlcache.js";
import { cardSearch, categories as chCategories, setSearch } from "./cardhedger.js";
import {
  digimonSetDetail, digimonSets, gatcgSetDetail, gatcgSets,
  sorcerySetDetail, sorcerySets, swuSetDetail, swuSets,
} from "./opensources.js";
import { listSets as listPokemonSets, type SetDetail, type SetSummary } from "./sets.js";

// Browsing, one level up.
//
// The set list was Pokemon only, because TCGdex is a Pokemon catalogue and it
// was the only one wired to it. Somebody holding a One Piece card had a search
// box and nothing else — and a search box only helps a person who can already
// spell the name.
//
// Every source here is free and public, and all of them are cached for a day:
// a set list changes when a set is printed, which is a handful of times a
// year. The whole feature costs four requests a day across all users.

export type Game = {
  id: string;
  name: string;
  /** Roughly how many sets, for the tile. Filled after the first fetch. */
  sets?: number;
  /** Artwork for the tile — the newest set's logo. A name on a coloured
   *  rectangle is a button; a set logo is the game. */
  preview?: string | null;
};

export const GAMES: Game[] = [
  { id: "pokemon", name: "Pokémon" },
  { id: "onepiece", name: "One Piece" },
  { id: "yugioh", name: "Yu-Gi-Oh!" },
  { id: "lorcana", name: "Lorcana" },
  { id: "mtg", name: "Magic: The Gathering" },
  // Four more free catalogues, each called and read before being wired. They
  // were absent for no better reason than that this list was hardcoded at five
  // and nobody came back to it.
  { id: "swu", name: "Star Wars Unlimited" },
  { id: "sorcery", name: "Sorcery: Contested Realm" },
  { id: "digimon", name: "Digimon" },
  { id: "gatcg", name: "Grand Archive" },
];

/** The five above are the ones with a free catalogue behind them, and they
 *  are the whole of what this platform could find.
 *
 *  Sports has no free catalogue anywhere — every reference database for it is
 *  commercial — so a marketplace whose own scope document promises TCGs
 *  "alongside sports cards" could not list a single one. Nor could it list
 *  Dragon Ball, Digimon, or anything else without a community API.
 *
 *  Card Hedge fills that in as one more source rather than as a special case:
 *  its categories arrive as games, its sets as sets, and everything below
 *  treats them the same way it treats Scryfall's. Whatever it returns is
 *  ADDED to the five, never substituted for them — the free feeds are better
 *  and more complete for their own games, and they cost nothing.
 *
 *  Prefixed `ch:` so a Card Hedge set can never collide with a set id from a
 *  catalogue we already had. */
export const CH_PREFIX = "ch";

const DAY = 24 * 3600 * 1000;
/** One entry per game, and it must hold ALL of them.
 *
 *  This was 8, sized to the five games plus headroom. At nine it evicted on
 *  every pass: `gamesWithPreviews` warms each game and then reads them all
 *  back, so the first one warmed was gone by the time it was read — Pokemon
 *  reported 0 of its 218 sets, having just been fetched successfully. Sized
 *  well past the list so adding a game cannot silently blank another. */
const cache = new TtlCache<SetSummary[]>(DAY, 64);
/** Games whose artwork is being fetched right now, so a second request while
 *  the first is still running does not start it again. */
const enriching = new Set<string>();

/** The first of several spellings that actually answers.
 *
 *  For a source whose own ids are not spelled consistently, asking twice is
 *  cheaper than choosing wrongly and returning nothing. */
async function firstOf(codes: string[], url: (c: string) => string): Promise<any> {
  const tried = new Set<string>();
  for (const c of codes) {
    if (!c || tried.has(c)) continue;
    tried.add(c);
    const r = await json<any>(url(c));
    const list = Array.isArray(r) ? r : (r?.data ?? []);
    if (Array.isArray(list) && list.length) return r;
  }
  return null;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, {
      // Scryfall rejects node's default agent by name — "Your User-Agent
      // string is currently a default value supplied by your HTTP library" —
      // with a 400, not a 403, so it reads as a bad request rather than a
      // missing header. Every one of these APIs is free and asks only to know
      // who is calling, so all of them get told.
      headers: { "user-agent": "GrailCard/1.0 (+https://grailcard.com.au)", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** One Piece. The API returns a set code and a name and nothing else — no
 *  artwork, no counts — so the tile is built from the code. */
async function onePieceSets(): Promise<SetSummary[]> {
  const raw = await json<{ set_name: string; set_id: string }[]>(
    "https://optcgapi.com/api/allSets/",
  );
  if (!raw) return [];
  return raw
    .map((s) => ({
      setId: `optcg:${s.set_id}`,
      name: s.set_name,
      logo: null,
      symbol: null,
      total: 0,
      official: 0,
      releasedAt: null,
    }))
    .reverse();
}

async function lorcanaSets(): Promise<SetSummary[]> {
  const raw = await json<{ results?: any[] }>("https://api.lorcast.com/v0/sets");
  const list = raw?.results ?? [];
  return list
    .map((s) => ({
      setId: `lorcana:${s.code}`,
      name: s.name,
      logo: null,
      symbol: null,
      total: 0,
      official: 0,
      releasedAt: s.released_at ?? null,
    }))
    .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
}

/** Magic, minus the noise.
 *
 *  Scryfall lists over a thousand "sets", most of which are tokens, promos,
 *  minigames and art series. A collector browsing for a card wants the ~150
 *  that are actual releases. */
/** Magic, and the filter that was hiding six sevenths of it.
 *
 *  This kept `core` and `expansion` only. Scryfall lists 1,049 sets and that
 *  whitelist passed 144 — it dropped 298 promo sets, all 45 Commander decks,
 *  32 Masters sets, and every one of the 19 Masterpiece sets, which are among
 *  the most valuable cards Magic has ever printed. Innistrad Remastered is
 *  495 cards and none of them were findable.
 *
 *  The right question is not what TYPE a set is, it is whether the card
 *  physically exists — a marketplace sells objects, and an Alchemy card
 *  cannot be posted to anybody. Scryfall answers that directly with `digital`.
 *  61 sets are digital-only; the other 988 are real cards somebody can hold. */
async function mtgSets(): Promise<SetSummary[]> {
  const raw = await json<{ data?: any[] }>("https://api.scryfall.com/sets");
  const list = (raw?.data ?? []).filter((s) => !s.digital);
  return list.map((s) => ({
    setId: `mtg:${s.code}`,
    name: s.name,
    logo: null,
    symbol: s.icon_svg_uri ?? null,
    total: s.card_count ?? 0,
    official: s.card_count ?? 0,
    releasedAt: s.released_at ?? null,
  }));
}

/** Yu-Gi-Oh. A thousand sets, most of them small, and every one carries a
 *  real image — which makes it the only source here that can illustrate its
 *  own tiles without a second request. */
async function ygoSets(): Promise<SetSummary[]> {
  const raw = await json<any[]>("https://db.ygoprodeck.com/api/v7/cardsets.php");
  if (!raw) return [];
  return raw
    .map((s) => ({
      setId: `ygo:${s.set_code}`,
      name: s.set_name,
      logo: s.set_image ?? null,
      symbol: s.set_image ?? null,
      total: Number(s.num_of_cards ?? 0),
      official: Number(s.num_of_cards ?? 0),
      releasedAt: s.tcg_date ?? null,
    }))
    .filter((s) => s.name)
    .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
}

/** A picture for every set in a catalogue that publishes none.
 *
 *  One Piece and Lorcana list a set as a code and a name, so every tile in
 *  those two games rendered as its own name in grey. One card from each set
 *  fixes it — 22 sets apiece, fetched once and then cached for a day like the
 *  list itself, so it is 44 upstream requests a day and not 44 per visitor.
 *
 *  Bounded to six at a time. Firing twenty-two at a public API the moment
 *  somebody taps a tile is how a free catalogue starts refusing us. */
async function withCardArt(gameId: string, sets: SetSummary[]): Promise<SetSummary[]> {
  const out = [...sets];
  const queue = out.map((s, i) => ({ s, i })).filter((x) => !x.s.logo);

  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const code = job.s.setId.split(":")[1];
      if (!code) continue;
      try {
        if (gameId === "lorcana") {
          const r = await json<any>(`https://api.lorcast.com/v0/sets/${encodeURIComponent(code)}/cards`);
          const list = Array.isArray(r) ? r : (r?.results ?? []);
          const url = list.find((c: any) => c?.image_uris?.digital?.small)?.image_uris?.digital?.small;
          if (url) out[job.i] = { ...job.s, logo: url };
        } else if (gameId === "onepiece") {
          const r = await json<any>(`https://optcgapi.com/api/sets/${encodeURIComponent(code)}/`);
          const list = Array.isArray(r) ? r : (r?.data ?? []);
          const url = list.find((c: any) => c?.card_image)?.card_image;
          if (url) out[job.i] = { ...job.s, logo: url };
        }
      } catch {
        // A set without a picture keeps its name, which is the fallback the
        // tile already draws.
      }
    }
  };

  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

export async function setsForGame(gameId: string): Promise<SetSummary[]> {
  const hit = cache.get(gameId);
  if (hit) return hit;

  let sets =
    gameId === "pokemon" ? await listPokemonSets()
    : gameId === "onepiece" ? await onePieceSets()
    : gameId === "yugioh" ? await ygoSets()
    : gameId === "lorcana" ? await lorcanaSets()
    : gameId === "mtg" ? await mtgSets()
    : gameId === "swu" ? await swuSets()
    : gameId === "sorcery" ? await sorcerySets()
    : gameId === "digimon" ? await digimonSets()
    : gameId === "gatcg" ? await gatcgSets()
    // Everything bought. One branch for every category they hold, because the
    // shape is theirs rather than one API per game — which is the whole
    // difference between paying for a catalogue and wiring five of them.
    : gameId.startsWith(`${CH_PREFIX}:`) ? await boughtSets(gameId.slice(CH_PREFIX.length + 1))
    : [];

  // Never cache an empty answer. An upstream having a bad minute would
  // otherwise leave a game looking permanently empty for a day.
  if (sets.length) cache.set(gameId, sets);

  // The two catalogues that publish no set artwork get a card instead — but
  // NOT on the request that asked for the list. Twenty-two lookups is fifteen
  // seconds, and making the first person to tap One Piece wait fifteen
  // seconds to see names they could have had immediately is a bad trade for
  // pictures. It runs after the answer has gone out and updates the cache, so
  // the art is there a moment later and for the rest of the day.
  if (sets.length && !enriching.has(gameId) && (gameId === "onepiece" || gameId === "lorcana")) {
    enriching.add(gameId);
    void withCardArt(gameId, sets)
      .then((withArt) => cache.set(gameId, withArt))
      .catch(() => {})
      .finally(() => enriching.delete(gameId));
  }

  return sets;
}

// A picture for the games whose set lists carry none. One card from the
// newest set, cached for a day like everything else here — three requests a
// day in total, and card art on a tile beats a set logo anyway.
const previewCache = new TtlCache<string | null>(DAY, 8);

async function cardPreview(gameId: string, sets: SetSummary[]): Promise<string | null> {
  const hit = previewCache.entry(gameId);
  if (hit) return hit.v;

  const code = sets[0]?.setId.split(":")[1];
  let url: string | null = null;
  try {
    if (gameId === "lorcana" && code) {
      const r = await json<any>(`https://api.lorcast.com/v0/sets/${encodeURIComponent(code)}/cards`);
      const list = Array.isArray(r) ? r : (r?.results ?? []);
      url = list.find((c: any) => c?.image_uris?.digital?.normal)?.image_uris?.digital?.normal ?? null;
    } else if (gameId === "mtg" && code) {
      const r = await json<any>(
        `https://api.scryfall.com/cards/search?q=set:${encodeURIComponent(code)}&order=released`,
      );
      url = (r?.data ?? []).find((c: any) => c?.image_uris?.normal)?.image_uris?.normal ?? null;
    } else if (gameId === "onepiece" && code) {
      const r = await json<any>(
        `https://optcgapi.com/api/sets/${encodeURIComponent(code)}/`,
      );
      const list = Array.isArray(r) ? r : (r?.data ?? []);
      url = list.find((c: any) => c?.card_image)?.card_image ?? null;
    }
  } catch {
    // A tile without a picture is still a tile.
  }
  // Cached either way, including the null: a game whose art we cannot find
  // should not be looked up again on every request for a day.
  previewCache.set(gameId, url);
  return url;
}

const detailCache = new TtlCache<SetDetail | null>(DAY, 120);

/** One set and the cards in it, for the games TCGdex does not cover.
 *
 *  The set list gave every non-Pokemon set an id like "mtg:trk", and nothing
 *  could open one: getSet only speaks TCGdex, so every tile outside Pokemon
 *  answered "that set couldn't be loaded". The list was built and the door at
 *  the end of it was not.
 *
 *  Returns null for an id with no prefix, which is the caller's signal to use
 *  the Pokemon path it always used. */
export async function setDetailForGame(setId: string): Promise<SetDetail | null | undefined> {
  const [prefix, ...rest] = setId.split(":");
  const code = rest.join(":");
  if (!code) return undefined;   // no prefix — not ours

  const hit = detailCache.entry(setId);
  if (hit) return hit.v;

  // Load the list if it is not already held. A cold instance has nothing
  // cached, and Yu-Gi-Oh cannot be queried without the set's NAME — so
  // opening a set link directly, or after a deploy, answered "not found" for
  // a set that exists. The list is cached for a day, so this happens once.
  const game = gameOfPrefix(prefix);
  let known = cache.get(game);
  if (!known) known = await setsForGame(game).catch(() => []);
  // Matched against the same spellings the fetch below tries, or a One Piece
  // set opened from a card id finds no summary and falls back to naming
  // itself "OP17" instead of "The World's Strongest Warriors".
  const spellings = new Set([
    setId,
    `${prefix}:${code.replace(/^([A-Z]+)(\d)/i, "$1-$2")}`,
    `${prefix}:${code.replace(/-/g, "")}`,
  ]);
  const summary = (known ?? []).find((x) => spellings.has(x.setId));
  const base = {
    setId,
    name: summary?.name ?? code,
    logo: summary?.logo ?? null,
    symbol: summary?.symbol ?? null,
    total: summary?.total ?? 0,
    official: summary?.official ?? 0,
    releasedAt: summary?.releasedAt ?? null,
  };

  // The four free catalogues added later each answer a whole set at once.
  if (prefix === "swu" || prefix === "sorcery" || prefix === "digimon" || prefix === "gatcg") {
    const known = cache.get(prefix) ?? (await setsForGame(prefix).catch(() => []));
    const summary = (known ?? []).find((x) => x.setId === setId);
    const shell = {
      setId,
      name: summary?.name ?? code,
      logo: null,
      symbol: null,
      total: summary?.total ?? 0,
      official: summary?.official ?? 0,
      releasedAt: summary?.releasedAt ?? null,
    };
    const detail =
      prefix === "swu" ? await swuSetDetail(code, shell)
      : prefix === "sorcery" ? await sorcerySetDetail(code, shell)
      : prefix === "digimon" ? await digimonSetDetail(code, shell)
      : await gatcgSetDetail(code, shell);
    if (detail) detailCache.set(setId, detail);
    return detail;
  }

  // Bought sets are answered whole by their own function — theirs is one
  // endpoint for every category, so there is nothing to branch on below.
  if (prefix === CH_PREFIX) {
    const detail = await boughtSetDetail(code);
    detailCache.set(setId, detail);
    return detail;
  }

  let cards: SetDetail["cards"] = [];
  try {
    if (prefix === "mtg") {
      const r = await json<any>(
        `https://api.scryfall.com/cards/search?q=set:${encodeURIComponent(code)}&order=set&unique=prints`,
      );
      cards = (r?.data ?? []).map((c: any) => ({
        cardId: `mtg-${c.id}`,
        name: c.name,
        localId: String(c.collector_number ?? ""),
        imageUrl: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
      }));
    } else if (prefix === "lorcana") {
      const r = await json<any>(`https://api.lorcast.com/v0/sets/${encodeURIComponent(code)}/cards`);
      const list = Array.isArray(r) ? r : (r?.results ?? []);
      cards = list.map((c: any) => ({
        cardId: `lorcana-${c.id}`,
        name: [c.name, c.version].filter(Boolean).join(" — "),
        localId: String(c.collector_number ?? ""),
        imageUrl: c.image_uris?.digital?.normal ?? c.image_uris?.digital?.small ?? null,
      }));
    } else if (prefix === "optcg") {
      // Their set index and their card ids disagree about a hyphen: the set
      // list says "OP-17" and a card id says "OP17-109". `setIdOfCard` can
      // only see the card, so it derives "OP17" — which 404s, and every card
      // opened from a One Piece set said "Card Not Found".
      //
      // Both forms are tried rather than one being declared canonical,
      // because their own index is not consistent either: alongside "OP-17"
      // it carries "OP15-EB04".
      const r = await firstOf(
        [code, code.replace(/^([A-Z]+)(\d)/i, "$1-$2"), code.replace(/-/g, "")],
        (c) => `https://optcgapi.com/api/sets/${encodeURIComponent(c)}/`,
      );
      const list = Array.isArray(r) ? r : (r?.data ?? []);
      cards = list.map((c: any) => ({
        // `card_image_id`, not `card_set_id`.
        //
        // One Piece prints a card and then reprints it as a parallel, an
        // alternate art, a Wanted Poster — and gives every one of them the SAME
        // card_set_id. OP13-119 is five cards: a $1.77 base, an $18 parallel, a
        // $433 Wanted Poster, a $1,085 Super Alternate Art and a $4,420 Red
        // Super Alternate Art. Keyed on card_set_id they were one catalogue
        // entry, so `grade_prices` — which keys on catalog_id — could not tell
        // the cheapest from the dearest. 33 of the 154 cards in OP-02 collide
        // this way; card_image_id is unique across all 154.
        //
        // A base print's image id IS its set id, so every existing id is
        // unchanged and nothing already stored is orphaned. Only the parallels,
        // which were wrong anyway, gain their `_p1` suffix.
        cardId: `optcg-${c.card_image_id ?? c.card_set_id}`,
        name: c.card_name,
        localId: String(c.card_set_id ?? ""),
        imageUrl: c.card_image ?? null,
      }));
    } else if (prefix === "ygo") {
      // ygoprodeck queries by set NAME, not by code, so the name has to come
      // from the list we already hold. Without it there is nothing to ask.
      if (!summary?.name) return null;
      const r = await json<any>(
        `https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=${encodeURIComponent(summary.name)}`,
      );
      cards = (r?.data ?? []).map((c: any) => ({
        cardId: `ygo-${c.id}`,
        name: c.name,
        localId: String(c.card_sets?.[0]?.set_code ?? ""),
        imageUrl: c.card_images?.[0]?.image_url_small ?? null,
      }));
    } else {
      return undefined;
    }
  } catch {
    return null;
  }

  const detail: SetDetail = { ...base, total: cards.length || base.total, cards };
  // Only a set with cards is worth remembering. Caching an empty one turns a
  // bad minute upstream into an empty set for a day.
  if (cards.length) {
    detailCache.set(setId, detail);
    // And teach the LIST what we just learned. optcgapi's set index carries a
    // name and an id and nothing else — no card count — so every One Piece
    // tile said "0 cards" about a set that opens to a hundred and fifty. The
    // count is free once the detail has been fetched, so opening a set fixes
    // its own tile from then on, and nothing extra is bought to do it.
    const known = cache.get(gameOfPrefix(prefix));
    const row = known?.find((x) => x.setId === setId);
    if (row && !row.total) row.total = cards.length;
  }
  return cards.length ? detail : null;
}

const gameOfPrefix = (p: string) =>
  p === "optcg" ? "onepiece" : p === "ygo" ? "yugioh" : p;

/** The games, each with a count and a picture.
 *
 *  Warmed once and then served from cache for a day, so the whole tile grid
 *  costs five upstream requests per day across every user who ever opens it.
 *  Warming is the reason this is async: reading only what happened to be
 *  cached meant the first person to open the tab got five blank tiles.
 *
 *  A game whose catalogue is having a bad minute still appears — with no
 *  count and no picture — because the sets may well load when it is tapped,
 *  and hiding a whole game is a worse answer than a plain tile. */
/** The games Card Hedge adds on top of the five free ones.
 *
 *  Read from their categories rather than written down here, so a sport they
 *  add appears without a deploy — the entire reason to buy a catalogue is not
 *  to maintain a list of what is in it. Their names come through as they are
 *  ("Baseball", "Basketball"), and the id is prefixed so it can never collide
 *  with one of ours.
 *
 *  Empty when the provider is off, which is the default. Nothing below has to
 *  know that: an unconfigured provider is a provider with no categories. */
async function boughtGames(): Promise<Game[]> {
  try {
    const cats = await chCategories();
    return cats
      // Anything they call by a name we already serve is dropped rather than
      // shown twice. Our own feed for that game is the better one.
      .filter((c) => !GAMES.some((g) => g.name.toLowerCase() === c.name.toLowerCase()))
      .map((c) => ({ id: `${CH_PREFIX}:${c.name}`, name: c.name }));
  } catch {
    return [];
  }
}

/** Warms still in flight, so a second request while the first is running
 *  does not start the crawl again. */
const warming = new Map<string, Promise<unknown>>();

function warm(gameId: string): Promise<unknown> {
  const inflight = warming.get(gameId);
  if (inflight) return inflight;
  const p = setsForGame(gameId)
    .catch(() => [])
    .finally(() => warming.delete(gameId));
  warming.set(gameId, p);
  return p;
}

/** How long the games list will wait for catalogues before answering with
 *  what it has. The five original sources answer in about two seconds; the
 *  Grand Archive crawl is 26 requests and can take a minute cold. */
const GAMES_BUDGET_MS = 8_000;

export async function gamesWithPreviews(): Promise<Game[]> {
  const bought = await boughtGames();
  const all = [...GAMES, ...bought];

  // Warm everything, but do not WAIT for everything.
  //
  // This blocked until every catalogue was loaded, one after another, and
  // that was fine at five sources. Then two things happened at once: Grand
  // Archive joined, which has no set index and is crawled out of 26 searches
  // and can take a minute cold; and the app gained a 20-second timeout on
  // every request, because a request that never settles was leaving buttons
  // spinning forever. Together they meant the first games call after a
  // restart took longer than the app would wait, and "Browse by game" was
  // empty — the list had been fine a moment earlier with a warm cache, which
  // is exactly why it was not caught.
  //
  // So the warm-up runs in the background, deduped, and this answers within
  // a budget with whatever is cached by then. A slow catalogue shows without
  // a set count for a few seconds and fills in on the next open; a fast one
  // is there the first time. Nothing waits on the slowest source, and nothing
  // can be blanked by it.
  const warms = all.map((g) => warm(g.id));
  await Promise.race([
    Promise.allSettled(warms),
    new Promise((r) => setTimeout(r, GAMES_BUDGET_MS)),
  ]);

  return Promise.all(
    all.map(async (g) => {
      const sets = cache.get(g.id) ?? [];
      // The newest set that actually has artwork. Newest first is already the
      // sort order, and a set with no logo is common in every catalogue but
      // TCGdex and ygoprodeck.
      const logo = sets.find((s) => s.logo)?.logo ?? null;
      return {
        ...g,
        sets: sets.length || undefined,
        preview: logo ?? (sets.length ? await cardPreview(g.id, sets) : null),
      };
    }),
  );
}

/** The set a catalogue card id belongs to, or null when it cannot be known.
 *
 *  The two id shapes in this file do not agree, and that is what broke the
 *  card page. A SET is `<prefix>:<code>` — `optcg:OP13` — while a CARD is
 *  `<prefix>-<id>` — `optcg-OP13-119`. A phone cutting a card id at its last
 *  hyphen produced `optcg-OP13`, which is neither, so the lookup missed and
 *  every One Piece card opened blank.
 *
 *  Null is an honest answer here, not a failure. Magic, Yu-Gi-Oh and Lorcana
 *  ids carry the provider's own opaque identifier and the set is genuinely not
 *  in the string; the caller has to find those another way. Returning a
 *  plausible-looking guess for them would put the bug back with the symptom
 *  hidden. */
export function setIdOfCard(cardId: string): string | null {
  const cut = cardId.indexOf("-");
  const prefix = cut > 0 ? cardId.slice(0, cut) : "";

  // No prefix we mint means TCGdex, where a card id IS `<set>-<number>`.
  if (!PREFIXED.has(prefix)) {
    const last = cardId.lastIndexOf("-");
    return last > 0 ? cardId.slice(0, last) : null;
  }

  const rest = cardId.slice(cut + 1);
  // A bought card id carries the provider's own identifier and nothing about
  // its set, exactly like Magic's. Saying so is the honest answer — the card
  // page falls back to asking the server who the card is, which works because
  // anything on the market is in our own tables by then.
  if (prefix === CH_PREFIX) return null;
  if (prefix === "optcg") {
    // `OP13-119` — the set code is everything before the card's own number.
    const last = rest.lastIndexOf("-");
    return last > 0 ? `${prefix}:${rest.slice(0, last)}` : null;
  }
  return null;
}

/** The prefixes this file mints. Kept beside `setIdOfCard` because the two
 *  have to agree about what a prefixed id looks like. */
const PREFIXED = new Set(["mtg", "lorcana", "optcg", "ygo", "swu", "sorcery", "digimon", "gatcg", CH_PREFIX]);

/** Every set inside one bought category.
 *
 *  Their set-search caps at 100 results and has no page parameter, so a big
 *  category is walked by initial rather than by page. Twenty-seven calls
 *  sounds like a lot until you notice this is cached for a day and that the
 *  alternative is a category that silently stops at its hundredth set —
 *  which, on a marketplace whose promise is "every set", is the failure that
 *  matters most.
 *
 *  A blank search first: for a small category that is the whole of it in one
 *  call, and there is no point spending twenty-seven on Formula 1. */
async function boughtSets(category: string): Promise<SetSummary[]> {
  const seen = new Map<string, SetSummary>();
  const take = (rows: { name: string; category: string | null; year?: string | null }[]) => {
    for (const r of rows) {
      const setId = `${CH_PREFIX}:${r.name}`;
      if (seen.has(setId)) continue;
      seen.set(setId, {
        setId,
        name: r.name,
        logo: null,
        symbol: null,
        total: 0,
        official: 0,
        releasedAt: r.year ? `${r.year}-01-01` : null,
      });
    }
  };

  take(await setSearch({ category, count: 100 }));
  // Under the cap on the first call means we have all of it.
  if (seen.size < 100) return [...seen.values()];

  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
  for (const letter of alphabet) {
    take(await setSearch({ category, search: letter, count: 100 }));
  }
  return [...seen.values()];
}

/** The cards inside a bought set.
 *
 *  Paged, unlike the sets: this endpoint does take a page number, and a
 *  modern sports product runs to several hundred cards once the parallels are
 *  counted. Capped at ten pages so one enormous set cannot spend a whole
 *  day's call budget on its own.
 *
 *  Card ids come through as `ch-<their id>` to match the CARD id shape the
 *  rest of this file uses — `<prefix>-<id>` — while the SET id above is
 *  `ch:<name>`. Those two shapes disagreeing is what broke every One Piece
 *  card page, so `setIdOfCard` below is taught this one explicitly. */
export async function boughtSetDetail(setName: string): Promise<SetDetail | null> {
  const cards: SetDetail["cards"] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await cardSearch({ set: setName, page, pageSize: 100 });
    if (!rows.length) break;
    for (const c of rows) {
      cards.push({
        cardId: `${CH_PREFIX}-${c.cardId}`,
        name: c.player && !c.name.includes(c.player) ? `${c.player} — ${c.name}` : c.name,
        localId: String(c.number ?? ""),
        imageUrl: c.imageUrl,
      });
    }
    if (rows.length < 100) break;
  }
  if (!cards.length) return null;
  return {
    setId: `${CH_PREFIX}:${setName}`,
    name: setName,
    logo: null,
    symbol: null,
    total: cards.length,
    official: cards.length,
    releasedAt: null,
    cards,
  };
}
