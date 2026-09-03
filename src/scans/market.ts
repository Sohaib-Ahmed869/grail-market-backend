// Market Pulse: what the cards this market actually trades are doing.
//
// The set of cards used to be eight names typed into this file — Charizard,
// Pikachu, Sol Ring. That is a stand-in for a market, not a market: it never
// changed, so "what moved this week" was the same eight cards forever, none of
// which anybody here necessarily owns or wants, and three of them were games
// with no listings on the platform at all.
//
// It now comes from demandedCards(): the cards people here have listed,
// watched, held or scanned, ranked by how much of that they have done. The
// board grows with the product and needs no maintenance.
//
// The price movement itself still comes from JustTCG, because it is the only
// source of a seven-day change we have. Cached hard (12h) to stay inside the
// free tier alongside scan-time price lookups.

import { demandedCards } from "./demand.js";

export type PulseCard = {
  label: string;
  setName: string;
  game: string;
  price: number | null;
  change24h: number | null; // percent
  change7d: number | null; // percent
  low7: number | null;
  high7: number | null;
  spark: number[]; // recent price points, oldest -> newest
  /** filled from our own catalogue, so the app can show the card rather than
   *  a row in a table */
  imageUrl?: string | null;
  cardId?: string | null;
};

/** Our game keys to JustTCG's. Anything we cannot map is asked for without a
 *  game filter rather than skipped — a wrong filter returns nothing, and no
 *  filter returns something we can still check the name against. */
const JUSTTCG_GAME: Record<string, string> = {
  pokemon: "pokemon",
  onepiece: "one-piece-card-game",
  lorcana: "disney-lorcana",
  mtg: "magic-the-gathering",
  yugioh: "yugioh",
  swu: "star-wars-unlimited",
  digimon: "digimon-card-game",
};

/** The game, from the row or from the catalogue id it was registered under.
 *  Watchlist and collection rows carry no game column, and guessing from the
 *  id prefix is better than asking for a Pokemon card in every game at once. */
function gameOf(row: { game: string | null; catalogId: string }): string | null {
  if (row.game && JUSTTCG_GAME[row.game]) return JUSTTCG_GAME[row.game]!;
  const id = row.catalogId;
  if (id.startsWith("optcg-")) return JUSTTCG_GAME.onepiece!;
  if (id.startsWith("lorcana-")) return JUSTTCG_GAME.lorcana!;
  if (id.startsWith("ygo-")) return JUSTTCG_GAME.yugioh!;
  if (id.startsWith("mtg-") || id.startsWith("scry-")) return JUSTTCG_GAME.mtg!;
  // base1-, swsh7-, cel25-, sv..., M2- and the rest of the Pokemon families.
  if (/^[a-z]+\d/.test(id) || id.startsWith("smp-")) return JUSTTCG_GAME.pokemon!;
  return null;
}

const TTL_MS = 12 * 3600 * 1000;
let cache: { at: number; data: PulseCard[] } | null = null;

// ---------------- hobby news (Google News RSS — free, no key) ----------------

export type NewsItem = {
  title: string;
  source: string;
  link: string;
  publishedAt: string;
};

const NEWS_QUERIES = [
  '"pokemon card" OR "charizard card"',
  '"trading card" auction OR record OR PSA OR graded',
  '"sports card" OR "one piece card game" OR "lorcana"',
];

const NEWS_TTL_MS = 45 * 60 * 1000;
let newsCache: { at: number; data: NewsItem[] } | null = null;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const chunks = xml.split("<item>").slice(1);
  for (const chunk of chunks) {
    const title = chunk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1];
    const link = chunk.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    const pub = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const source = chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1];
    if (!title || !link) continue;
    items.push({
      title: decodeEntities(title),
      source: decodeEntities(source ?? "News"),
      link: link.trim(),
      publishedAt: pub ? new Date(pub).toISOString() : new Date(0).toISOString(),
    });
  }
  return items;
}

export async function cardNews(): Promise<NewsItem[]> {
  if (newsCache && Date.now() - newsCache.at < NEWS_TTL_MS) return newsCache.data;
  const all: NewsItem[] = [];
  for (const q of NEWS_QUERIES) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "grailcard/0.1" },
      });
      if (!res.ok) continue;
      all.push(...parseRss(await res.text()));
    } catch {
      /* best-effort per feed */
    }
  }
  // dedupe by title, newest first, keep a tickerful
  const seen = new Set<string>();
  const deduped = all
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((n) => {
      const k = n.title.toLowerCase().slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 24);
  if (deduped.length > 0) newsCache = { at: Date.now(), data: deduped };
  return newsCache?.data ?? deduped;
}

function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

export async function marketPulse(): Promise<PulseCard[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return cache?.data ?? [];

  // The cards this market actually trades, not a list somebody typed.
  const wanted = await demandedCards(12).catch(() => []);
  if (!wanted.length) return cache?.data ?? [];

  const out: PulseCard[] = [];
  // Which feed cards have already been claimed. Two of our rows can resolve
  // to the same one — "Charizard" and "Charizard ☆ δ" both matched plain
  // Charizard, and the board showed the identical −1.85% twice under two
  // names. The higher-demand row comes first and keeps it; the other is
  // dropped rather than borrowing a number that is not about it.
  const claimed = new Set<string>();

  for (const w of wanted) {
    try {
      const game = gameOf(w);
      const url =
        `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(w.name)}` +
        (game ? `&game=${game}` : "") +
        `&limit=3`;
      const res = await fetch(url, {
        headers: { "X-API-Key": key },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as any;

      // The most-traded variant across the top hits — the one with the
      // richest price history makes a real trend line, not a flat placeholder.
      let card: any = null;
      let v: any = null;
      let best = -1;
      for (const c of (body?.data ?? []) as any[]) {
        for (const variant of (c.variants ?? []) as any[]) {
          const richness =
            ((variant.priceHistory?.length ?? 0) as number) * 10 +
            ((variant.priceChangesCount30d ?? 0) as number);
          if (richness > best) {
            best = richness;
            card = c;
            v = variant;
          }
        }
      }
      if (!card || !v) continue;

      const feedId = String(card.id ?? `${card.name}|${card.set_name ?? ""}`);
      if (claimed.has(feedId)) continue;
      claimed.add(feedId);

      const spark = ((v.priceHistory ?? []) as { p: number }[])
        .map((h) => h.p)
        .filter((p) => Number.isFinite(p))
        .slice(-24);

      out.push({
        // Our name and our catalogue id, not the feed's. The feed is being
        // asked about a card we already hold a record of, and its own naming
        // is what produced rows like "Umbreon ex - 176" on the dashboard.
        label: w.name,
        setName: w.setName ?? card.set_name ?? "",
        game: w.game ?? card.game ?? "",
        price: pct(v.price),
        change24h: pct(v.priceChange24hr),
        change7d: pct(v.priceChange7d),
        low7: pct(v.minPrice7d),
        high7: pct(v.maxPrice7d),
        spark,
        imageUrl: w.imageUrl,
        // A real id every time, because it came from our own tables rather
        // than from a search that can answer with a sentinel.
        cardId: w.catalogId,
      });
    } catch {
      /* best-effort per card */
    }
  }

  if (out.length > 0) cache = { at: Date.now(), data: out };
  return out;
}
