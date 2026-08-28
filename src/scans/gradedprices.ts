import type { GradedPrices } from "@grailcard/shared";
import { db } from "../db.js";
import { readCard, writeCard } from "../cards.store.js";
import { similarity } from "./similarity.js";
import { recordUsage } from "./usage.js";
import {
  configuredKeys, pickKey, recordKeyQuota, lockKey, lockedFor, poolStatus,
} from "./pptkeys.js";

// PokemonPriceTracker: free tier includes PSA prices (100 credits/day).
// Set PPT_API_KEY (dashboard -> API) to activate; without a key this module
// quietly returns null and the UI simply omits graded prices.
const PPT_URL = process.env.PPT_API_URL ?? "https://www.pokemonpricetracker.com/api/v2";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["medianPrice", "averagePrice", "avg", "average", "market", "price", "value"]) {
      if (typeof o[k] === "number") return o[k] as number;
    }
  }
  return null;
}

export type GradePoint = {
  price: number;
  count?: number | null;
  confidence?: "high" | "medium" | "low" | null;
  method?: string | null;
  low?: number | null;
  high?: number | null;
  median?: number | null;
  /** when we fetched it, ISO-8601. Null means it came live from the source in
   *  this request; a value means it came from the store and is that old. */
  asOf?: string | null;
  /** the source does not separate label variants, so this figure blends them */
  blended?: boolean | null;
};

export type PptPrices = {
  graded: GradedPrices | null;
  rawUsd: number | null;
  /** per-grade evidence for PSA, keyed by grade as written */
  byGrade?: Record<string, GradePoint> | null;
  /** every grading company the source tracks: grader -> grade -> evidence */
  byGrader?: Record<string, Record<string, GradePoint>> | null;
};

/** "bgs9_5" -> { grader: "BGS", grade: "9.5" }. Returns null for anything that
 *  is not a grade key, and for "ungraded", which is a raw price and belongs on
 *  its own field rather than under a grading company. */
export function parseGradeKey(
  key: string,
): { grader: string; grade: string } | null {
  const m = /^(psa|bgs|bvg|bccg|cgc|sgc|tag|ace|ags|mnt|gma|ksa|hga|csg)(\d{1,2})(?:_(\d))?$/i.exec(
    key,
  );
  if (!m) return null;
  const whole = Number(m[2]);
  if (!Number.isFinite(whole) || whole < 1 || whole > 10) return null;
  const grade = m[3] ? `${whole}.${m[3]}` : String(whole);
  return { grader: m[1].toUpperCase(), grade };
}

// PPT bills 2 credits PER CARD RETURNED, so the page size IS the price of a
// lookup: limit=10 cost 20 credits and burned a whole day's quota in five
// scans. The query is already set-qualified ("Charizard EX Dragon Frontiers"),
// which puts the right card in the first couple of hits, so a small page is
// both cheaper and no less accurate.
const PAGE_SIZE = 3;

// The ingest job asks for ONE.
//
// The page size is the price of a lookup — the provider bills per card
// returned — and the scan path only needs three because it searches by fuzzy
// text and has to pick the right card out of the candidates
// (`items.find(numberMatches) ?? items.find(setMatches)`).
//
// The refresh job has no such problem. It drives off catalog_cards, so it
// already knows the exact name, set and number before it asks; candidates to
// choose between are pure cost. One card back instead of three takes a lookup
// from 6 credits to 2, which triples what any plan buys.
const INGEST_PAGE_SIZE = Number(process.env.PPT_INGEST_PAGE_SIZE ?? 1);

// Cache TTLs. A hit is stable for a day; a miss is retried sooner, because a
// miss is often our matching being wrong rather than the card being absent,
// and we don't want to lock a card out for a full day over it.
// A week, not a day. Graded card prices are medians over hundreds of
// completed sales and barely move day to day, so a short TTL buys almost no
// accuracy while guaranteeing that a card priced yesterday costs credits again
// today — and that a provider outage or an exhausted quota blanks a card we
// already have good data for. Long TTL keeps known cards answerable offline.
const HIT_TTL_MS = 7 * 24 * 3600 * 1000;
const MISS_TTL_MS = 6 * 3600 * 1000;

const readCache = db.prepare("SELECT fetched_at, payload FROM price_cache WHERE key = ?");
const writeCache = db.prepare(
  "INSERT INTO price_cache (key, fetched_at, payload) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload",
);
const writeKv = db.prepare(
  "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

// 1 base + 1 eBay credit per card returned, so a lookup costs 2x the page size
export const creditsFor = (pageSize: number): number => pageSize * 2;
/** what a SCAN-path lookup costs; the ingest job asks for a smaller page */
export const CREDITS_PER_LOOKUP = creditsFor(PAGE_SIZE);
export const CREDITS_PER_INGEST_LOOKUP = creditsFor(INGEST_PAGE_SIZE);

export type QuotaStatus = {
  provider: string;
  /** null when we have never seen a response (no key, or no call yet) */
  dailyLimit: number | null;
  dailyRemaining: number | null;
  purchasedRemaining: number | null;
  totalRemaining: number | null;
  /** ISO time the daily allowance refills */
  resetsAt: string | null;
  creditsPerLookup: number;
  /** whole price lookups still affordable */
  lookupsLeft: number | null;
  lockedOut: boolean;
  /** how many keys are in the pool */
  keyCount?: number;
  /** cards already priced and cached — these cost nothing to serve */
  cachedCards: number;
  /** when the numbers above were last observed */
  observedAt: string | null;
  configured: boolean;
};

const countCached = db.prepare("SELECT COUNT(*) AS c FROM price_cache");

export function quotaStatus(): QuotaStatus {
  const pool = poolStatus();
  const cachedCards = (countCached.get() as { c: number }).c;
  // Newest observation across the pool — the freshest thing we actually know.
  const latest = pool.keys
    .filter((k) => k.observedAt)
    .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)))[0];
  return {
    provider: "pokemonpricetracker",
    dailyLimit: pool.dailyLimit,
    dailyRemaining: pool.totalRemaining,
    purchasedRemaining: pool.keys.reduce(
      (a, k) => (k.purchasedRemaining == null ? a : (a ?? 0) + k.purchasedRemaining),
      null as number | null,
    ),
    totalRemaining: pool.totalRemaining,
    resetsAt: pool.resetsAt,
    creditsPerLookup: CREDITS_PER_LOOKUP,
    lookupsLeft:
      pool.totalRemaining == null
        ? null
        : Math.floor(pool.totalRemaining / CREDITS_PER_LOOKUP),
    // Only when EVERY key is spent. With one key this is what it always was.
    lockedOut: pool.allLockedOut,
    cachedCards,
    observedAt: latest?.observedAt ?? null,
    configured: pool.configured,
    keyCount: pool.keys.length,
  };
}

/** Bump when the SHAPE of a cached PptPrices changes.
 *
 *  A cache that outlives the shape it was written for serves the old shape
 *  forever. When every grade started being kept rather than three PSA rungs,
 *  the local layer went on answering with the three — so a card the provider
 *  had told us about in full came back almost empty, and no amount of fixing
 *  the code downstream could show what was never returned. The version is part
 *  of the key, so old entries are simply never found rather than needing to be
 *  hunted down and deleted.
 *
 *  Only the LOCAL layer's key carries it. The shared store holds the
 *  provider's own response, which we did not shape and cannot invalidate — and
 *  versioning that key threw away every card already paid for. */
const CACHE_VERSION = 3;

function cacheGet(key: string): PptPrices | null {
  const row = readCache.get(key) as { fetched_at: number; payload: string } | undefined;
  if (!row) return null;
  let v: PptPrices;
  try {
    v = JSON.parse(row.payload) as PptPrices;
  } catch {
    return null;
  }
  const isMiss = v.graded == null && v.rawUsd == null;
  const ttl = isMiss ? MISS_TTL_MS : HIT_TTL_MS;
  if (Date.now() - row.fetched_at > ttl) return null;
  // Stamp the age on the way out. A cached figure that reports no asOf is
  // indistinguishable from one fetched a second ago, which is the exact
  // confusion asOf exists to remove — and this layer can serve a price up to a
  // week old.
  return stampAge(v, new Date(row.fetched_at).toISOString());
}

/** Attach when we fetched these figures. Applied at every layer that can
 *  return something it did not just buy. */
function stampAge(v: PptPrices, asOf: string): PptPrices {
  const mark = (pts: Record<string, GradePoint>) =>
    Object.fromEntries(Object.entries(pts).map(([g, pt]) => [g, { ...pt, asOf }]));
  return {
    ...v,
    byGrade: v.byGrade ? mark(v.byGrade) : v.byGrade,
    byGrader: v.byGrader
      ? Object.fromEntries(Object.entries(v.byGrader).map(([g, pts]) => [g, mark(pts)]))
      : v.byGrader,
  };
}

function cacheSet(key: string, v: PptPrices): void {
  writeCache.run(key, Date.now(), JSON.stringify(v));
}

/** Find a market-ish USD number anywhere in PPT's prices blob (its shape
 *  varies by card era/variant). */
function findMarket(prices: unknown, depth = 0): number | null {
  if (depth > 3 || prices == null) return null;
  if (typeof prices !== "object") return null;
  const o = prices as Record<string, unknown>;
  for (const k of ["market", "marketPrice", "mid", "midPrice"]) {
    if (typeof o[k] === "number" && (o[k] as number) > 0) return o[k] as number;
  }
  for (const v of Object.values(o)) {
    const found = findMarket(v, depth + 1);
    if (found != null) return found;
  }
  return null;
}

/** Everything the provider tells us about the card it matched, so the store
 *  becomes a growing catalogue rather than just a price ledger. */
function describe(
  pick: Record<string, any>,
  cacheKey: string,
  cardName: string,
  localId?: string | null,
  setName?: string | null,
) {
  return {
    cacheKey,
    query: { name: cardName, number: localId, set: setName },
    providerCardId: pick.id != null ? String(pick.id) : null,
    cardName: typeof pick.name === "string" ? pick.name : null,
    setName: typeof pick.setName === "string" ? pick.setName : null,
    cardNumber: pick.cardNumber != null ? String(pick.cardNumber) : null,
    rarity: typeof pick.rarity === "string" ? pick.rarity : null,
    imageUrl:
      pick.imageCdnUrl400 ?? pick.imageCdnUrl ?? pick.imageUrl ?? null,
  };
}

/** One grade's price point, from the provider's shape.
 *
 *  Shared by the live-fetch path and the cache-hit path deliberately: they read
 *  the same JSON, and when only the live path had this, a cached card came back
 *  with three PSA numbers and nothing else.
 *
 *  Prefers the provider's FILTERED figure over its raw median. The raw median
 *  is unfiltered, so a mistitled or damaged listing sits in it at full weight —
 *  on a Deoxys ex PSA 9 that dragged the median to $903 against a filtered
 *  $1,869, because the sample ran from $80 to $1,882 for the same card at the
 *  same grade. The median is kept beside it so the two can be compared. */
function pointFrom(g: any): GradePoint | null {
  if (!g) return null;
  const smart = g.smartMarketPrice ?? null;
  const price = num(smart?.price) ?? num(g.medianPrice) ?? num(g);
  if (price == null) return null;
  const conf = typeof smart?.confidence === "string" ? smart.confidence : null;
  return {
    price,
    count: num(g.count),
    confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : null,
    method: typeof smart?.method === "string" ? smart.method : null,
    low: num(g.minPrice),
    high: num(g.maxPrice),
    median: num(g.medianPrice),
  };
}

export async function fetchGradedPrices(
  cardName: string,
  localId?: string | null,
  setName?: string | null,
  /** Skip both cache layers and buy a fresh answer.
   *
   *  Only the refresh job sets this. Its whole purpose is to replace a figure
   *  we already hold, so reading the cache first would make it a no-op — but
   *  it is also the one caller that must never be reachable from a request,
   *  because a `force` on the scan path is just an uncapped bill. */
  opts?: { force?: boolean },
): Promise<PptPrices> {
  const empty: PptPrices = { graded: null, rawUsd: null };
  if (configuredKeys().length === 0) return empty;

  // Two keys, because the two layers hold different things.
  //
  // The shared store holds the provider's own response, whose shape is not
  // ours to change, so its key is the card's identity and nothing else — a row
  // bought once must never be bought again, including after a deploy.
  //
  // The local layer holds OUR derived shape, which does change, so its key
  // carries a version. Versioning both orphaned every row we had already paid
  // for and sent the next lookup to a provider that answers 429.
  const cacheKey = `${cardName}|${localId ?? ""}|${setName ?? ""}`;
  const localKey = `v${CACHE_VERSION}|${cacheKey}`;

  // 1. local cache — same machine, same day. Free and instant.
  const hit = opts?.force ? null : cacheGet(localKey);
  if (hit) return hit;

  // 2. shared store — a card any instance has ever bought. Still free: the
  //    provider bills per card returned, so anything already purchased must
  //    never be purchased twice.
  const stored = opts?.force ? null : await readCard(cacheKey, HIT_TTL_MS, MISS_TTL_MS);
  if (stored) {
    // Rebuild every grade from the stored payload, not just the three legacy
    // PSA columns.
    //
    // A cache hit used to be strictly worse than a live call: it returned
    // psa8/psa9/psa10 and dropped BGS, CGC, SGC, TAG and every half grade,
    // even though the whole provider response was sitting in the same row. So
    // an Umbreon VMAX that reports $4,250 from 412 PSA 10 sales on a live call
    // reported nothing at all once cached — and cached is what every card is
    // once the monthly quota is spent, which is exactly when this matters.
    const stored_ = stored as typeof stored & { payload?: unknown };
    // Unwrap exactly as the live path does: PPT nests the per-grade sales under
    // ebay.salesByGrade, and reading one level shallower finds nothing while
    // looking like it worked.
    const ebayRoot = (stored_.payload as { ebay?: Record<string, any> } | null)?.ebay ?? null;
    const cachedGrades = ebayRoot ? (ebayRoot.salesByGrade ?? ebayRoot) : null;
    const byGraderCached: Record<string, Record<string, GradePoint>> = {};
    const byGradeCached: Record<string, GradePoint> = {};
    if (cachedGrades) {
      for (const [key, raw] of Object.entries(cachedGrades)) {
        const parsed = parseGradeKey(key);
        if (!parsed) continue;
        const pt = pointFrom(raw);
        if (!pt) continue;
        (byGraderCached[parsed.grader] ??= {})[parsed.grade] = pt;
        if (parsed.grader === "PSA") byGradeCached[parsed.grade] = pt;
      }
    }

    const v: PptPrices = stored.isMiss
      ? { graded: null, rawUsd: null }
      : {
          graded:
            stored.psa8 == null && stored.psa9 == null && stored.psa10 == null
              ? null
              : {
                  source: "pokemonpricetracker",
                  psa8: stored.psa8,
                  psa9: stored.psa9,
                  psa10: stored.psa10,
                  estimated: stored.estimated,
                },
          rawUsd: stored.rawUsd,
          byGrade: Object.keys(byGradeCached).length ? byGradeCached : null,
          byGrader: Object.keys(byGraderCached).length ? byGraderCached : null,
        };
    cacheSet(localKey, v); // warm the local layer so the next scan skips the round trip
    console.log(`[store] hit for "${cardName}" — no credits spent`);
    return stampAge(v, stored.fetchedAt.toISOString());
  }

  // 3. only now is it worth spending a credit
  const pageSize = opts?.force ? INGEST_PAGE_SIZE : PAGE_SIZE;
  const cost = creditsFor(pageSize);

  try {
    // strip symbols (star/delta glyphs) that break text search
    const clean = (s: string) => s.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
    const query = [clean(cardName), setName ? clean(setName) : null].filter(Boolean).join(" ");
    const url = `${PPT_URL}/cards?search=${encodeURIComponent(query)}&limit=${pageSize}&includeEbay=true`;

    // Spend from whichever key still has room. With one key this is the same
    // key every time and behaves exactly as it did before.
    const call = async (): Promise<{ res: Response; keyId: string } | null> => {
      const chosen = pickKey(cost);
      if (!chosen) return null;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${chosen.key}` },
        signal: AbortSignal.timeout(12000),
      });
      recordUsage("ppt", cost);
      recordKeyQuota(chosen.id, res);
      return { res, keyId: chosen.id };
    };

    // At most one attempt per configured key, plus one burst-limit retry.
    // Bounded on purpose: an unbounded loop over a pool is how a transient
    // provider fault turns into every key being spent on the same doomed
    // request.
    const maxAttempts = Math.max(1, configuredKeys().length) + 1;
    let attempt = 0;
    let out: { res: Response; keyId: string } | null = null;

    while (attempt < maxAttempts) {
      attempt++;
      out = await call();
      if (!out) {
        const soonest = poolStatus().resetsAt;
        console.warn(
          `[ppt] every key is out of credits — skipping lookup for "${cardName}"` +
            (soonest ? `, soonest reset ${soonest}` : ""),
        );
        return empty;
      }
      const { res, keyId } = out;
      if (res.status !== 429) break;

      const detail = (await res.text().catch(() => "")).slice(0, 300);
      // Two very different 429s hide behind one status code. A DAILY credit
      // exhaustion ("requires 20 credits, you have 4 remaining") will never
      // clear by waiting a few seconds — retrying just burns scan latency, so
      // lock THAT key and let the next one try. A burst limit does clear, and
      // is worth one backoff on the same key.
      if (/credit|quota|daily/i.test(detail)) {
        // PPT states its own reset time — trust that over a guessed cooldown
        let until = Date.now() + 2 * 3600 * 1000;
        try {
          const parsed = JSON.parse(detail) as { resetsAt?: string; retryAfter?: number };
          if (parsed.resetsAt && !Number.isNaN(Date.parse(parsed.resetsAt))) {
            until = Date.parse(parsed.resetsAt);
          } else if (typeof parsed.retryAfter === "number") {
            until = Date.now() + parsed.retryAfter * 1000;
          }
        } catch {
          /* body wasn't JSON — keep the conservative default */
        }
        // Only this key. A shared breaker was correct with one key and simply
        // wrong with several: one exhausted key would disable the rest.
        lockKey(keyId, until);
        console.warn(
          `[ppt] key ${keyId} out of credits until ${new Date(until).toISOString()} — trying the next`,
        );
        continue; // pickKey now skips it
      }

      // burst limit: back off once on the same key
      await new Promise((r) => setTimeout(r, 2000));
    }

    const res = out!.res;
    if (!res.ok) {
      console.warn(`[ppt] ${res.status} for "${query}" — graded prices unavailable this scan`);
      return empty; // not cached — retried next scan
    }
    const body = (await res.json()) as Record<string, unknown>;
    const items = (
      Array.isArray(body) ? body : (body.data ?? body.cards ?? body.results ?? [])
    ) as Record<string, unknown>[];
    if (items.length === 0) {
      cacheSet(localKey, empty);
      void writeCard({
        cacheKey,
        query: { name: cardName, number: localId, set: setName },
        isMiss: true,
      });
      return empty;
    }

    // the WRONG card's graded prices are worse than none: accept only a
    // result whose collector number matches, or whose set name clearly does
    const wanted = localId ? String(Number(String(localId).split("/")[0])) : null;
    const numberMatches = (it: Record<string, unknown>) => {
      const n = it.number ?? it.localId ?? it.cardNumber;
      return (
        wanted != null &&
        n != null &&
        String(Number(String(n).split("/")[0])) === wanted
      );
    };
    const setMatches = (it: Record<string, unknown>) =>
      setName != null &&
      typeof it.setName === "string" &&
      similarity(setName, it.setName) >= 0.6;

    const pick =
      items.find((it) => numberMatches(it) && setMatches(it)) ??
      items.find(numberMatches) ??
      items.find(setMatches);
    if (!pick) {
      cacheSet(localKey, empty);
      void writeCard({
        cacheKey,
        query: { name: cardName, number: localId, set: setName },
        isMiss: true,
        payload: { candidates: items.length },
      });
      return empty;
    }

    const rawUsd = findMarket(pick.prices);

    const ebayRoot = (pick.ebay ?? pick.gradedPrices ?? pick.psa ?? null) as Record<
      string,
      any
    > | null;
    if (!ebayRoot) {
      const v: PptPrices = { graded: null, rawUsd };
      cacheSet(localKey, v);
      void writeCard({ ...describe(pick, cacheKey, cardName, localId, setName), rawUsd });
      return v;
    }
    // PPT nests per-grade sales under ebay.salesByGrade
    const ebay = (ebayRoot.salesByGrade ?? ebayRoot) as Record<string, unknown>;

    // The provider publishes TWO figures per grade: a raw median and a
    // filtered, recency-weighted "smart" price. The raw median is unfiltered,
    // so a mistitled or damaged listing sits in it at full weight — on a
    // Deoxys ex PSA 9 that dragged the median to $903 against a filtered
    // $1,869, because the sample ran from $80 to $1,882 for the same card at
    // the same grade. Prefer the filtered figure and keep the median beside it
    // so the two can be compared.
    const point = pointFrom;

    // Read EVERY grade the provider tracks, not three PSA rungs.
    //
    // salesByGrade is keyed "psa9", "bgs9_5", "cgc10", "tag8_5", "ungraded" and
    // so on. We were reading psa8/psa9/psa10 and discarding the rest, which is
    // why a Beckett card had to be approximated from the nearest PSA tier when
    // its actual BGS 9.5 sales were sitting in the same response — and why a
    // PSA 5 card reported no data at all.
    const byGrader: Record<string, Record<string, GradePoint>> = {};
    const byGrade: Record<string, GradePoint> = {};
    for (const [key, raw] of Object.entries(ebay as Record<string, any>)) {
      const parsed = parseGradeKey(key);
      if (!parsed) continue;
      const pt = point(raw);
      if (!pt) continue;
      const { grader, grade } = parsed;
      (byGrader[grader] ??= {})[grade] = pt;
      if (grader === "PSA") byGrade[grade] = pt; // back-compat for the flat shape
    }

    const graded: GradedPrices = {
      source: "pokemonpricetracker",
      psa8: byGrade["8"]?.price ?? null,
      psa9: byGrade["9"]?.price ?? null,
      psa10: byGrade["10"]?.price ?? null,
      estimated: false,
    };
    const result: PptPrices = {
      graded:
        graded.psa8 == null && graded.psa9 == null && graded.psa10 == null ? null : graded,
      rawUsd,
      byGrade: Object.keys(byGrade).length ? byGrade : null,
      byGrader: Object.keys(byGrader).length ? byGrader : null,
    };
    cacheSet(localKey, result);
    // keep everything the provider returned, not just the three numbers we
    // render today — re-buying a card to get one extra field is the exact
    // waste this store exists to prevent
    const grades = ebay as Record<string, any>;
    void writeCard({
      ...describe(pick, cacheKey, cardName, localId, setName),
      rawUsd,
      psa8: graded.psa8,
      psa9: graded.psa9,
      psa10: graded.psa10,
      counts: {
        psa8: grades.psa8?.count ?? null,
        psa9: grades.psa9?.count ?? null,
        psa10: grades.psa10?.count ?? null,
      },
      spread: {
        psa8: { min: grades.psa8?.minPrice ?? null, max: grades.psa8?.maxPrice ?? null },
        psa9: { min: grades.psa9?.minPrice ?? null, max: grades.psa9?.maxPrice ?? null },
        psa10: { min: grades.psa10?.minPrice ?? null, max: grades.psa10?.maxPrice ?? null },
      },
      lastSaleDate:
        grades.psa10?.lastSaleDate ?? grades.psa9?.lastSaleDate ?? grades.psa8?.lastSaleDate ?? null,
      estimated: false,
      payload: pick,
    });
    return result;
  } catch (err) {
    // do NOT cache failures like 429s — retry on the next scan
    console.warn(`[ppt] lookup failed for "${cardName}": ${(err as Error).message}`);
    return empty;
  }
}

/** Reshape stored rows into the per-grade evidence the valuation chain reads.
 *
 *  Two invariants live here, both learned the hard way:
 *
 *  - A grade with no price is DROPPED, not carried through as a null. A row
 *    can exist with a null price (the source tracked the grade and had no
 *    sales); rendering it puts an empty figure under a grader badge, which
 *    reads as "worthless" rather than "unknown".
 *  - A grader left with no usable grades disappears entirely, so the interface
 *    shows an honest empty Beckett tab instead of PSA numbers wearing a BGS
 *    label.
 *
 *  Every surviving figure carries the time WE fetched it, so its age is the
 *  reader's to judge rather than ours to hide.
 */
export function gradePointsFromStore(
  held: Record<string, Record<string, {
    price: number | null;
    sampleSize?: number | null;
    confidence?: string | null;
    method?: string | null;
    low?: number | null;
    high?: number | null;
    median?: number | null;
    fetchedAt?: string | null;
  }>>,
): Record<string, Record<string, GradePoint>> | null {
  const out: Record<string, Record<string, GradePoint>> = {};
  for (const [grader, grades] of Object.entries(held)) {
    const kept: Record<string, GradePoint> = {};
    for (const [grade, r] of Object.entries(grades)) {
      if (r.price == null) continue;
      kept[grade] = {
        price: r.price,
        count: r.sampleSize ?? null,
        confidence: (r.confidence as GradePoint["confidence"]) ?? null,
        method: r.method ?? null,
        low: r.low ?? null,
        high: r.high ?? null,
        median: r.median ?? null,
        asOf: r.fetchedAt ?? null,
      };
    }
    if (Object.keys(kept).length) out[grader] = kept;
  }
  return Object.keys(out).length ? out : null;
}
