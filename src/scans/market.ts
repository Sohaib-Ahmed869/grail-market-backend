// Market Pulse: live rates + trend data for a watchlist of iconic cards,
// powered by JustTCG's price-history fields. Cached hard (12h) to stay well
// inside the free tier alongside scan-time price lookups.

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
};

const WATCHLIST: { q: string; game: string; label?: string }[] = [
  { q: "Charizard ex", game: "pokemon" },
  { q: "Pikachu", game: "pokemon" },
  { q: "Umbreon ex", game: "pokemon" },
  { q: "Monkey.D.Luffy", game: "one-piece-card-game", label: "Monkey.D.Luffy" },
  { q: "Elsa", game: "disney-lorcana" },
  { q: "Darth Vader", game: "star-wars-unlimited" },
  { q: "Blue-Eyes White Dragon", game: "yugioh" },
  { q: "Sol Ring", game: "magic-the-gathering" },
];

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

  const out: PulseCard[] = [];
  for (const w of WATCHLIST) {
    try {
      const res = await fetch(
        `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(w.q)}&game=${w.game}&limit=3`,
        { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as any;
      // pick the most-traded variant across the top hits — the one with the
      // richest price history makes a real trend line, not a flat placeholder
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
      const spark = ((v.priceHistory ?? []) as { p: number }[])
        .map((h) => h.p)
        .filter((p) => Number.isFinite(p))
        .slice(-24);
      out.push({
        label: w.label ?? card.name,
        setName: card.set_name ?? "",
        game: card.game ?? w.game,
        price: pct(v.price),
        change24h: pct(v.priceChange24hr),
        change7d: pct(v.priceChange7d),
        low7: pct(v.minPrice7d),
        high7: pct(v.maxPrice7d),
        spark,
      });
    } catch {
      /* best-effort per card */
    }
  }
  if (out.length > 0) cache = { at: Date.now(), data: out };
  return out;
}
