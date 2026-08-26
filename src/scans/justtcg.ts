import type { Valuation } from "@grailcard/shared";
import { similarity } from "./similarity.js";
import { recordUsage } from "./usage.js";
import { db } from "../db.js";
import { TtlCache } from "./ttlcache.js";

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

// JustTCG states its own budget on every response, under _metadata, including
// which plan the key is on. We were ignoring it and counting our own calls
// against a hardcoded free-tier ceiling of 1,000/month — so a paid Starter Plan
// key with 10,000 monthly requests displayed "994/1000", wrong by an order of
// magnitude and wrong about which period it was even measuring.
//
// Persisted, because a snapshot that dies with the process tells you nothing
// after a restart, which is when people look.
const QUOTA_KEY = "justtcg:quota";
const writeKv = db.prepare(
  "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const readKv = db.prepare("SELECT value FROM kv WHERE key = ?");

export type JustTcgQuota = {
  plan: string | null;
  monthlyLimit: number | null;
  monthlyUsed: number | null;
  monthlyRemaining: number | null;
  dailyLimit: number | null;
  dailyUsed: number | null;
  dailyRemaining: number | null;
  rateLimitPerMin: number | null;
  observedAt: string | null;
};

function recordQuota(body: any): void {
  const m = body?._metadata ?? body?.meta ?? null;
  if (!m || typeof m !== "object") return;
  const n = (v: unknown): number | null => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const snap: JustTcgQuota = {
    plan: typeof m.apiPlan === "string" ? m.apiPlan : null,
    monthlyLimit: n(m.apiRequestLimit),
    monthlyUsed: n(m.apiRequestsUsed),
    monthlyRemaining: n(m.apiRequestsRemaining),
    dailyLimit: n(m.apiDailyLimit),
    dailyUsed: n(m.apiDailyRequestsUsed),
    dailyRemaining: n(m.apiDailyRequestsRemaining),
    rateLimitPerMin: n(m.apiRateLimit),
    observedAt: new Date().toISOString(),
  };
  if (snap.monthlyLimit == null && snap.dailyLimit == null) return;
  try {
    writeKv.run(QUOTA_KEY, JSON.stringify(snap));
  } catch {
    /* metering must never break a lookup */
  }
}

/** The provider's own numbers, as last reported. Null until a call has been
 *  made — never a guess dressed up as a measurement. */
export function justTcgQuota(): JustTcgQuota | null {
  try {
    const row = readKv.get(QUOTA_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as JustTcgQuota) : null;
  } catch {
    return null;
  }
}

async function search(key: string, q: string, gameSlug?: string): Promise<any[]> {
  const game = gameSlug ? `&game=${gameSlug}` : "";
  recordUsage("justtcg");
  const res = await fetch(
    `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(q)}${game}&limit=8`,
    { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as any;
  recordQuota(body);
  return (body?.data ?? body?.cards ?? []) as any[];
}

const CACHE_TTL = 12 * 3600 * 1000;
const priceCache = new TtlCache<Valuation | null>(
  CACHE_TTL,
  Number(process.env.JUSTTCG_CACHE_MAX ?? 2000),
);

export async function fetchJustTcgPrice(
  cardName: string,
  game: string,
  setName?: string | null,
): Promise<Valuation | null> {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return null;

  const cacheKey = `${game}|${cardName}|${setName ?? ""}`;
  const hit = priceCache.entry(cacheKey);
  if (hit) return hit.v;

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
      priceCache.set(cacheKey, null);
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
    priceCache.set(cacheKey, v);
    return v;
  } catch {
    return null;
  }
}
