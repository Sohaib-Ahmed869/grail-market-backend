import { TtlCache } from "./ttlcache.js";
import { overlayStorePrices } from "./sets.js";
import { cardSearch, categories as chCategories, setSearch } from "./cardhedger.js";
import {
  digimonSetDetail, digimonSets, gatcgSetDetail, gatcgSets,
  sorcerySetDetail, sorcerySets, swuSetDetail, swuSets,
} from "./opensources.js";
import { listSets as listPokemonSets, type SetDetail, type SetSummary } from "./sets.js";
import { CATEGORY, groupsFor, setContents } from "../printings/tcgcsv.js";
import {
  SPORTS, isProvisional, isSportCard, isSportGame, isSportName, readSportCard, sportSetDetail,
  sportSetId, sportSets, withSportArt,
} from "./sports.js";
import {
  EDITIONS, editionFields, editionOf, editionSetDetail, editionSets, indexCatalogueCards,
  isEditionGame, readEditionCard, readEditionSetId,
} from "./editions.js";

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
  /** tcg | sports | entertainment — see categoryOf. */
  category?: string;
  /** Roughly how many sets, for the tile. Filled after the first fetch. */
  sets?: number;
  /** Artwork for the tile — the newest set's logo. A name on a coloured
   *  rectangle is a button; a set logo is the game. */
  preview?: string | null;
  /** Language editions only (see editions.ts): the game this is an edition
   *  of, its language code, and that language's English name for the label.
   *  `name` stays the base game's, so "Pokémon" reads the same in every one. */
  baseGame?: string;
  language?: string;
  languageName?: string;
};

export const GAMES: Game[] = [
  // Every game tcgcsv carries, which is every TCGplayer category that is
  // actually cards. The first nine have a free catalogue of their own behind
  // them as well; the rest resolve through `printings`, which is the same
  // source the first nine already use for their variants and prices.
  //
  // Order is deliberate: the games people come here for first, then the rest
  // alphabetically-ish by how likely anyone is to look for them. A browse
  // screen with sixty tiles needs the first row to be the right one.
  { id: "pokemon", name: "Pokémon" },
  { id: "onepiece", name: "One Piece" },
  { id: "yugioh", name: "Yu-Gi-Oh!" },
  { id: "lorcana", name: "Lorcana" },
  { id: "mtg", name: "Magic: The Gathering" },
  { id: "swu", name: "Star Wars Unlimited" },
  { id: "sorcery", name: "Sorcery: Contested Realm" },
  { id: "digimon", name: "Digimon" },
  { id: "gatcg", name: "Grand Archive" },
  { id: "pokemonjp", name: "Pokémon (Japan)" },
  { id: "fab", name: "Flesh and Blood" },
  { id: "vanguard", name: "Cardfight!! Vanguard" },
  { id: "weiss", name: "Weiss Schwarz" },
  { id: "unionarena", name: "Union Arena" },
  { id: "gundam", name: "Gundam Card Game" },
  { id: "riftbound", name: "Riftbound" },
  { id: "dbsfusion", name: "Dragon Ball Super Fusion World" },
  { id: "dbsccg", name: "Dragon Ball Super CCG" },
  { id: "dbz", name: "Dragon Ball Z" },
  { id: "naruto", name: "Naruto" },
  { id: "hololive", name: "hololive" },
  { id: "metazoo", name: "MetaZoo" },
  { id: "wixoss", name: "WIXOSS" },
  { id: "elestrals", name: "Elestrals" },
  { id: "battlespirits", name: "Battle Spirits Saga" },
  { id: "shadowverse", name: "Shadowverse Evolve" },
  { id: "finalfantasy", name: "Final Fantasy TCG" },
  { id: "universus", name: "UniVersus" },
  { id: "keyforge", name: "KeyForge" },
  { id: "transformers", name: "Transformers" },
  { id: "godzilla", name: "Godzilla" },
  { id: "palworld", name: "Palworld" },
  { id: "cookierun", name: "CookieRun Braverse" },
  { id: "cyberpunk", name: "Cyberpunk" },
  { id: "alphaclash", name: "Alpha Clash" },
  { id: "akora", name: "Akora" },
  { id: "kryptik", name: "Kryptik" },
  { id: "gateruler", name: "Gate Ruler" },
  { id: "alternatesouls", name: "Alternate Souls" },
  { id: "argentsaga", name: "Argent Saga" },
  { id: "chronoclash", name: "Chrono Clash System" },
  { id: "architect", name: "Architect" },
  { id: "aoschampions", name: "Warhammer Age of Sigmar Champions" },
  { id: "munchkin", name: "Munchkin CCG" },
  { id: "lightseekers", name: "Lightseekers" },
  { id: "exodus", name: "Exodus" },
  { id: "mlpccg", name: "My Little Pony CCG" },
  { id: "casterchronicles", name: "The Caster Chronicles" },
  { id: "zwo", name: "Zombie World Order" },
  { id: "metax", name: "MetaX" },
  { id: "dragoborne", name: "Dragoborne" },
  { id: "swdestiny", name: "Star Wars Destiny" },
  { id: "buddyfight", name: "Future Card BuddyFight" },
  { id: "dicemasters", name: "Dice Masters" },
  { id: "forceofwill", name: "Force of Will" },
  { id: "wow", name: "World of Warcraft TCG" },
  { id: "redakai", name: "Redakai" },
  { id: "epic", name: "Epic" },
  { id: "bakugan", name: "Bakugan" },
  { id: "mlp", name: "My Little Pony" },
  { id: "neopets", name: "Neopets Battledome" },
  { id: "rushofikorr", name: "Rush of Ikorr" },
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
const cache = new TtlCache<SetSummary[]>(DAY, 128, "set-lists");
/** Games whose artwork is being fetched right now, so a second request while
 *  the first is still running does not start it again. */
const enriching = new Set<string>();

/** A price a source hands us, or null. Their fields are strings ("105.93"),
 *  sometimes empty, sometimes absent; anything that is not a positive number
 *  is not a price. */
const usd = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

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
  // The first screenful, not all of them. Yu-Gi-Oh has 1,035 sets and one
  // request each would be 1,035 requests to decorate a list nobody has
  // scrolled. The rest keep their names, which is what the tile falls back to.
  const ART_BUDGET = 24;
  const queue = out
    .map((s, i) => ({ s, i }))
    .filter((x) => !x.s.logo)
    .slice(0, ART_BUDGET);

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
        } else if (gameId === "pokemon") {
          // TCGdex publishes a logo for most sets and nothing for the rest -
          // trainer kits, promo lines, the small sub-sets. Those drew as a
          // two-letter placeholder sitting in a grid next to real logos,
          // which reads as broken rather than as missing. The set's own first
          // card is a better stand-in than its initials.
          const r = await json<any>(`https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(code)}`);
          // The first card WITH a picture, not the first card. TCGdex ships
          // the checklist ahead of the artwork on a new set, so cards[0] is
          // routinely imageless while later ones are fine - Paldean Wonders
          // lists 131 cards and 0 images, Mega Evolution the same. Taking
          // cards[0] blindly found nothing on exactly the sets people are
          // looking for.
          const first = (r?.cards ?? []).find((c: any) => c?.image);
          if (first?.image) out[job.i] = { ...job.s, logo: `${first.image}/low.png` };
        } else if (CATEGORY[gameId]) {
          // tcgcsv games: the set's own first card. Their group carries no
          // logo, so the alternative is a grey rectangle next to sets that
          // have one, which reads worse than either extreme.
          const groupId = Number(job.s.setId.split(":")[2]);
          if (Number.isFinite(groupId)) {
            const { products } = await setContents(gameId, groupId);
            const url = products.find((x) => x.imageUrl)?.imageUrl;
            if (url) out[job.i] = { ...job.s, logo: url };
          }
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

/** Sets for any game tcgcsv carries.
 *
 *  Their "groups" are sets. No key, no contract, and already fetched for this
 *  game whenever a printing is looked up, so the first tap on a new game costs
 *  one request and the cache covers the rest of the day.
 *
 *  No release date and no card count: tcgcsv publishes neither on a group, and
 *  inventing them would put a number on screen that nothing stands behind. The
 *  set list renders without them. */
async function tcgcsvSets(gameId: string): Promise<SetSummary[]> {
  if (!CATEGORY[gameId]) return [];
  const groups = await groupsFor(gameId).catch(() => []);
  return groups
    .filter((g) => g.name)
    .map((g) => ({
      setId: `tcg:${gameId}:${g.groupId}`,
      name: g.name,
      logo: null,
      symbol: null,
      total: 0,
      official: 0,
      releasedAt: null,
    }))
    // Newest first is what a set list wants, and their group ids climb with
    // time, so the id is the closest thing to a date they give us.
    .sort((a, b) => Number(b.setId.split(":")[2]) - Number(a.setId.split(":")[2]));
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
    // Sports, read off eBay's item specifics. See sports.ts for what that
    // source is and, more importantly, what it is not.
    : isSportGame(gameId) ? await sportSets(gameId.slice("sport:".length))
    // Non-English editions of Pokémon (TCGdex) and Magic (Scryfall).
    : isEditionGame(gameId) ? await editionSets(gameId)
    // Every other mapped game resolves its sets from tcgcsv, which is where
    // `printings` already gets its variants and prices. The nine above keep
    // their own catalogues because those carry artwork, release dates and card
    // counts that tcgcsv does not - this is the floor, not a replacement.
    : await tcgcsvSets(gameId);

  // Never cache an empty answer. An upstream having a bad minute would
  // otherwise leave a game looking permanently empty for a day.
  // Nor one whose mis-tag check could not finish (sports.ts): the next request
  // should measure what this one could not, not inherit its guesses for a day.
  const settled = !isProvisional(sets);
  if (sets.length && settled) cache.set(gameId, sets);
  // Nothing fresh — a source down, or an allowance spent for the day. The
  // last list we had is a better answer than an empty screen, and it is kept
  // across restarts for exactly this.
  if (!sets.length) {
    const last = cache.stale(gameId);
    if (last?.length) return last;
  }

  // The two catalogues that publish no set artwork get a card instead — but
  // NOT on the request that asked for the list. Twenty-two lookups is fifteen
  // seconds, and making the first person to tap One Piece wait fifteen
  // seconds to see names they could have had immediately is a bad trade for
  // pictures. It runs after the answer has gone out and updates the cache, so
  // the art is there a moment later and for the rest of the day.
  if (sets.length && settled && !enriching.has(gameId) && isSportGame(gameId)) {
    enriching.add(gameId);
    void withSportArt(gameId.slice("sport:".length), sets)
      .then((withArt) => cache.set(gameId, withArt))
      .catch(() => {})
      .finally(() => enriching.delete(gameId));
  } else if (sets.length && !enriching.has(gameId) && (gameId === "onepiece" || gameId === "lorcana" || gameId === "pokemon" || CATEGORY[gameId])) {
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
// Sized past the whole games list. At 8 it held eight of ninety games, so every
// games request re-fetched a preview for most of the rest.
const previewCache = new TtlCache<string | null>(DAY, 256);

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
    // Everything else tcgcsv carries, which is most of the list. Their
    // products carry an image each, so the newest set's first card is the
    // cover - the same trick the three above use against their own APIs.
    //
    // Without this the browse row was nine games with art and fifty-three
    // grey rectangles, which reads as broken rather than as sparse. One
    // request per game, in the background, cached for a day.
    else if (CATEGORY[gameId] && sets[0]?.setId.startsWith("tcg:")) {
      const groupId = Number(sets[0].setId.split(":")[2]);
      if (Number.isFinite(groupId)) {
        const { products } = await setContents(gameId, groupId);
        url = products.find((x) => x.imageUrl)?.imageUrl ?? null;
      }
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
  // A sports set carries a colon inside its encoded name as often as not, so
  // it is answered before the prefix cut below gets to misread it.
  if (isSportGame(setId)) return sportSetDetail(setId);

  // A language edition's set: `lang:<game>:<language>:<code>`. Answered before
  // the prefix cut, which would read "lang" as a catalogue of its own.
  const edition = readEditionSetId(setId);
  if (edition) {
    const held = detailCache.entry(setId);
    if (held) return held.v;
    const known = cache.get(edition.edition.id) ?? (await setsForGame(edition.edition.id).catch(() => []));
    const detail = await editionSetDetail(setId, known);
    // Only a real answer is remembered — including "no printing in this
    // language". A source that could not be reached is asked again next time.
    if (detail) detailCache.set(setId, detail);
    return detail;
  }
  const [prefix, ...rest] = setId.split(":");
  const code = rest.join(":");
  if (!code) return undefined;   // no prefix — not ours

  const hit = detailCache.entry(setId);
  if (hit) return hit.v;

  // The fifty-odd games whose sets come from tcgcsv: `tcg:<game>:<groupId>`.
  //
  // Their set LIST was wired and their set DETAIL was not, so every one of
  // those games showed its sets and then opened each of them onto "not
  // found" — Flesh and Blood's 105 sets, all doors to nothing. The contents
  // are the same two tcgcsv calls `printings` already makes for these games.
  if (prefix === "tcg") {
    const detail = await tcgcsvSetDetail(setId);
    if (detail) detailCache.set(setId, detail);
    return detail;
  }

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
        rawUsd: usd(c.prices?.usd),
        rarity: c.rarity ?? null,
      }));
    } else if (prefix === "lorcana") {
      const r = await json<any>(`https://api.lorcast.com/v0/sets/${encodeURIComponent(code)}/cards`);
      const list = Array.isArray(r) ? r : (r?.results ?? []);
      cards = list.map((c: any) => ({
        cardId: `lorcana-${c.id}`,
        name: [c.name, c.version].filter(Boolean).join(" — "),
        localId: String(c.collector_number ?? ""),
        imageUrl: c.image_uris?.digital?.normal ?? c.image_uris?.digital?.small ?? null,
        rawUsd: usd(c.prices?.usd),
        rarity: c.rarity ?? null,
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
        rawUsd: usd(c.market_price),
        rarity: c.rarity ?? null,
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
        rawUsd: usd(c.card_prices?.[0]?.tcgplayer_price),
        rarity: c.card_sets?.[0]?.set_rarity ?? null,
      }));
    } else {
      return undefined;
    }
  } catch {
    return null;
  }

  const detail: SetDetail = { ...base, total: cards.length || base.total, cards: await overlayStorePrices(cards) };
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
  // Remember each card's own catalogue price by id, so the card page can
  // show the figure the set list already showed. See `catalogueRawFor`.
  if (cards.length) indexCatalogueCards(detail, { game: gameOfPrefix(prefix) });
  return cards.length ? detail : null;
}

/** One tcgcsv set as cards.
 *
 *  Only products carrying a collector number are cards; the rest of a group
 *  is its sealed product — boxes, packs, decks — which is not a card and must
 *  not sit in a card grid.
 *
 *  The price is TCGplayer's market price for that exact product id, never a
 *  name match: the Normal printing when there is one, otherwise the only
 *  printing that has a market price. When several finishes are priced and
 *  none is Normal, there is no single figure for the product and it stays
 *  null. */
async function tcgcsvSetDetail(setId: string): Promise<SetDetail | null> {
  const [, game, group] = setId.split(":");
  const groupId = Number(group);
  if (!game || !CATEGORY[game] || !Number.isFinite(groupId)) return null;
  const { products, prices } = await setContents(game, groupId).catch(() => ({ products: [], prices: [] }));
  const byProduct = new Map<number, typeof prices>();
  for (const p of prices) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);
  const priceOf = (productId: number): number | null => {
    const rows = (byProduct.get(productId) ?? []).filter((r) => r.marketPrice != null);
    const normal = rows.find((r) => (r.subTypeName ?? "").toLowerCase() === "normal");
    if (normal) return normal.marketPrice;
    return rows.length === 1 ? rows[0]!.marketPrice : null;
  };
  const cards: SetDetail["cards"] = products
    .filter((p) => p.number)
    .map((p) => ({
      cardId: `tcg-${game}-${p.productId}`,
      name: p.name,
      localId: p.number!,
      imageUrl: p.imageUrl,
      rawUsd: priceOf(p.productId),
      rarity: p.rarity,
    }));
  if (!cards.length) return null;
  const known = cache.get(game) ?? (await setsForGame(game).catch(() => []));
  const summary = known.find((x) => x.setId === setId);
  // Indexed so the card page can price and name these without asking anyone
  // by name — see editions.ts for why a name lookup is refused for them.
  indexCatalogueCards({ setId, name: summary?.name ?? setId, cards }, { game });
  return {
    setId,
    name: summary?.name ?? setId,
    logo: summary?.logo ?? null,
    symbol: null,
    total: cards.length,
    official: cards.length,
    releasedAt: null,
    cards,
  };
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

/** What kind of thing a game is, so a filter can offer "sports" without
 *  listing sixty-two chips and hoping somebody reads them all.
 *
 *  Three groups, because that is how people actually ask: the trading card
 *  games, sports, and everything licensed from something else. A game with no
 *  entry is a TCG - that is what the overwhelming majority are, and defaulting
 *  the other way would put Pokemon under "other". */
export type GameCategory = "tcg" | "sports" | "entertainment" | "japanese" | "language";

const ENTERTAINMENT = new Set([
  "godzilla", "palworld", "cookierun", "cyberpunk", "transformers", "bakugan",
  "mlp", "mlpccg", "neopets", "hololive", "naruto", "dbz", "dbsccg",
  "dbsfusion", "finalfantasy", "gundam", "riftbound", "swu", "swdestiny",
  "wow", "aoschampions", "munchkin", "lightseekers", "redakai", "elestrals",
]);

/** No tcgcsv game is a sport — every one of its 94 categories is a trading
 *  card game, checked — so this stays empty. Sports arrive by prefix instead:
 *  `sport:` from eBay's item specifics (sports.ts), and `ch:` categories whose
 *  name is a sport when Card Hedge is switched on. */
const SPORTS_IDS = new Set<string>([]);

export const categoryOf = (id: string): GameCategory =>
  // Japanese editions get a shelf of their own — they are a different market
  // at different prices, and collectors look for them as such. Every other
  // non-English edition shares one.
  id === "pokemonjp" || editionOf(id)?.language === "ja" ? "japanese"
  : isEditionGame(id) ? "language"
  : SPORTS_IDS.has(id) || isSportGame(id) ||
  // A bought category is named by its provider; "Baseball" is a sport however
  // it arrived, and filing it under trading card games hides it from anyone
  // who went looking in Sports.
  (id.startsWith(`${CH_PREFIX}:`) && isSportName(id.slice(CH_PREFIX.length + 1)))
    ? "sports"
    : ENTERTAINMENT.has(id) ? "entertainment" : "tcg";

export const GAME_CATEGORIES: { id: GameCategory; name: string }[] = [
  { id: "tcg", name: "Trading card games" },
  { id: "entertainment", name: "Licensed & entertainment" },
  { id: "sports", name: "Sports" },
  { id: "japanese", name: "Japanese" },
  { id: "language", name: "Other languages" },
];

export async function gamesWithPreviews(): Promise<Game[]> {
  const bought = await boughtGames();
  // A bought sport replaces ours of the same name rather than sitting beside
  // it: a paid checklist has card numbers, and ours is players within sets.
  const boughtNames = new Set(bought.map((g) => g.name.toLowerCase()));
  const sports: Game[] = SPORTS
    .filter((s) => !boughtNames.has(s.name.toLowerCase()))
    .map((s) => ({ id: `sport:${s.slug}`, name: s.name }));
  const editions: Game[] = EDITIONS.map((e) => ({ id: e.id, name: e.name }));
  const all = [...GAMES, ...bought, ...sports, ...editions];

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
        ...(editionFields(g.id) ?? {}),
        category: categoryOf(g.id),
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
/** Which game a catalogue id belongs to, when the id says.
 *
 *  Callers that already know the game pass it; the card page does not, and
 *  asking every screen to start doing so is a change in ten places that one
 *  here covers. Only the prefixed catalogues can be read this way — a TCGdex
 *  id is `<set>-<number>` with no game in it — so null is a real answer and
 *  the caller must treat it as "unknown", never as a default. */
export function gameOfCard(cardId: string | null | undefined): string | null {
  const id = (cardId ?? "").trim();
  if (!id) return null;
  // The only prefix whose game is not the prefix: `sport-` holds fourteen.
  if (isSportCard(id)) {
    const read = readSportCard(id);
    return read ? `sport:${read.sport.slug}` : null;
  }
  const cut = id.indexOf("-");
  const prefix = cut > 0 ? id.slice(0, cut) : "";
  if (!prefix || !PREFIXED.has(prefix)) return null;
  if (prefix === "tcg") return id.split("-")[1] || null;
  if (prefix === "lng") return readEditionCard(id)?.edition.id ?? null;
  return gameOfPrefix(prefix);
}

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
  if (prefix === "sport") {
    const read = readSportCard(cardId);
    return read ? sportSetId(read.sport.slug, read.set) : null;
  }
  if (prefix === "optcg") {
    // `OP13-119` — the set code is everything before the card's own number.
    const last = rest.lastIndexOf("-");
    return last > 0 ? `${prefix}:${rest.slice(0, last)}` : null;
  }
  return null;
}

/** The prefixes this file mints. Kept beside `setIdOfCard` because the two
 *  have to agree about what a prefixed id looks like. */
const PREFIXED = new Set(["tcg", "lng", "mtg", "lorcana", "optcg", "ygo", "swu", "sorcery", "digimon", "gatcg", CH_PREFIX, "sport"]);

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
        rawUsd: null,
        rarity: null,
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
