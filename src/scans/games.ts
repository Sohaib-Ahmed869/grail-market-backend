import { TtlCache } from "./ttlcache.js";
import { listSets as listPokemonSets, type SetSummary } from "./sets.js";

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
];

const DAY = 24 * 3600 * 1000;
const cache = new TtlCache<SetSummary[]>(DAY, 8);
/** Games whose artwork is being fetched right now, so a second request while
 *  the first is still running does not start it again. */
const enriching = new Set<string>();

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
async function mtgSets(): Promise<SetSummary[]> {
  const raw = await json<{ data?: any[] }>("https://api.scryfall.com/sets");
  const list = (raw?.data ?? []).filter(
    (s) => s.set_type === "core" || s.set_type === "expansion",
  );
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
export async function gamesWithPreviews(): Promise<Game[]> {
  await Promise.all(GAMES.map((g) => setsForGame(g.id).catch(() => [])));

  return Promise.all(
    GAMES.map(async (g) => {
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
