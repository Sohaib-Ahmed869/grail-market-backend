import { TtlCache } from "./ttlcache.js";
import { recordUsage, usedToday } from "./usage.js";

// Card Hedge — the catalogue and price source for everything our free feeds
// do not cover.
//
// The five free APIs behind `games.ts` cover five trading card games well and
// nothing else at all: no sports, no non-sport sets. The Product Scope
// Blueprint promises the platform spans TCGs "alongside sports cards", and
// sports has no free catalogue anywhere — the reference databases are all
// commercial. This is the adapter for the one that publishes a contract.
//
// It is not one capability, which is why it earns a whole file:
//
//   categories   the games and sports it knows, ours and otherwise
//   sets         every set inside a category — the "all sets" problem
//   cards        cards inside a set, by name, player, number
//   prices       every grade for one card, and the history behind it
//   comps        completed sales, with the count they were drawn from
//   population   PSA / BGS / SGC / CGC counts, via their GemRate contract
//
// The last two are the two holes this project has been carrying: we cannot
// itemise sold listings (eBay's Marketplace Insights was never approved) and
// we hold no population data at all.
//
// EVERY SHAPE BELOW WAS READ OFF THEIR OWN OpenAPI 3.1 DOCUMENT, which they
// publish unauthenticated at https://api.cardhedger.com/openapi.json — not
// guessed from documentation prose. The request bodies, the field names and
// the auth header are theirs. What could NOT be checked without a key is the
// response payloads, so every reader below is defensive: an unexpected shape
// yields null and the card falls back to the asks panel, which is the same
// thing that happens today.
//
// OFF BY DEFAULT. Per the house rule, a paid dependency ships with a cap and
// a cache or it does not ship: `CARDHEDGER_API_KEY` absent means off, and
// `CARDHEDGER_DAILY_MAX` at 0 means off even with a key.

const BASE = "https://api.cardhedger.com";

/** Calls per UTC day. 0 disables the provider outright, key or no key. */
const DAILY_MAX = Number(process.env.CARDHEDGER_DAILY_MAX ?? 0);

/** Their published header, from the spec's `securitySchemes`. */
const AUTH_HEADER = "X-API-Key";

const enabled = () => Boolean(process.env.CARDHEDGER_API_KEY) && DAILY_MAX > 0;

/** A catalogue barely moves; a price moves all day.
 *
 *  Two caches, because one TTL for both means either paying for set lists
 *  every hour or serving a stale price. Sets are the thing a browse screen
 *  hits on every open, so they are the ones worth holding for a day. */
const catalogue = new TtlCache<unknown>(24 * 60 * 60_000, 2_000);
const prices = new TtlCache<unknown>(60 * 60_000, 5_000);

/** One request, metered and bounded.
 *
 *  Everything a caller can get wrong is handled here rather than at six call
 *  sites: whether the provider is on, whether the day's budget is spent, the
 *  timeout, and a non-200 becoming null rather than a throw. */
async function call<T>(
  path: string,
  body: unknown | null,
  cache: TtlCache<unknown>,
  cacheKey: string,
): Promise<T | null> {
  if (!enabled()) return null;

  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit as T | null;

  // Counted before the call, not after. A request that times out still cost
  // us the call, and a cap that only counts successes is not a cap.
  const spent = usedToday("cardhedger");
  if (spent >= DAILY_MAX) {
    console.warn(
      `[cardhedger] daily cap reached (${spent}/${DAILY_MAX}) — skipping, ` +
        `card falls back to asks`,
    );
    return null;
  }

  try {
    recordUsage("cardhedger");
    const res = await fetch(`${BASE}${path}`, {
      method: body === null ? "GET" : "POST",
      headers: {
        [AUTH_HEADER]: process.env.CARDHEDGER_API_KEY!,
        ...(body === null ? {} : { "Content-Type": "application/json" }),
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 401 wrong key, 402 out of credit, 429 rate limited, 403 an endpoint
      // this contract does not include — population and clean sales each need
      // their own agreement. All of them mean the same thing to a caller.
      if (res.status === 401 || res.status === 403) {
        console.warn(`[cardhedger] ${res.status} on ${path} — key or contract does not cover it`);
      }
      cache.set(cacheKey, null);
      return null;
    }
    const json = (await res.json()) as T;
    cache.set(cacheKey, json);
    return json;
  } catch (e) {
    console.warn(`[cardhedger] ${path} failed:`, (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------- catalogue

export type ChCategory = { name: string; groupType?: string | null };

/** The games and sports they hold. Their `Baseball`, `Basketball` and
 *  `Pokemon` live in one namespace, which is exactly why this is worth
 *  having: sports and trading card games addressed the same way. */
export async function categories(): Promise<ChCategory[]> {
  const r = await call<any>("/v1/cards/categories", null, catalogue, "categories");
  const list = Array.isArray(r) ? r : (r?.categories ?? r?.data ?? []);
  if (!Array.isArray(list)) return [];
  return list
    .map((c: any) =>
      typeof c === "string"
        ? { name: c, groupType: null }
        : { name: String(c?.name ?? c?.category ?? ""), groupType: c?.group_type ?? null },
    )
    .filter((c) => c.name.length > 0);
}

export type ChSet = { name: string; category: string | null; year?: string | null };

/** Sets, optionally inside one category.
 *
 *  `count` is capped at 100 by their schema, so a full category is walked by
 *  search term rather than by page — there is no page parameter on this
 *  endpoint. A caller wanting everything asks repeatedly and dedupes. */
export async function setSearch(
  q: { search?: string | null; category?: string | null; count?: number } = {},
): Promise<ChSet[]> {
  const body = {
    ...(q.search ? { search: q.search } : {}),
    ...(q.category ? { category: q.category } : {}),
    count: Math.min(Math.max(q.count ?? 100, 1), 100),
  };
  const key = `sets:${q.category ?? ""}:${q.search ?? ""}:${body.count}`;
  const r = await call<any>("/v1/cards/set-search", body, catalogue, key);
  const list = Array.isArray(r) ? r : (r?.sets ?? r?.results ?? r?.data ?? []);
  if (!Array.isArray(list)) return [];
  return list
    .map((s: any) => ({
      name: String(s?.name ?? s?.set ?? s?.set_name ?? ""),
      category: s?.category ?? null,
      year: s?.year ?? null,
    }))
    .filter((s) => s.name.length > 0);
}

export type ChCard = {
  cardId: string;
  name: string;
  setName: string | null;
  number: string | null;
  player: string | null;
  category: string | null;
  imageUrl: string | null;
};

/** Cards, by any combination of name, set, category, player and number.
 *
 *  `card_id` is theirs and every price endpoint is keyed on it, so this is
 *  the door to all of them — nothing else in this file works without first
 *  resolving a card here. */
export async function cardSearch(q: {
  search?: string | null;
  set?: string | null;
  category?: string | null;
  player?: string | null;
  number?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<ChCard[]> {
  const body = {
    ...(q.search ? { search: q.search } : {}),
    ...(q.set ? { set: q.set } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.player ? { player: q.player } : {}),
    ...(q.number ? { number: q.number } : {}),
    page: Math.max(1, q.page ?? 1),
    page_size: Math.min(Math.max(q.pageSize ?? 25, 1), 100),
  };
  const key = `cards:${JSON.stringify(body)}`;
  const r = await call<any>("/v1/cards/card-search", body, catalogue, key);
  const list = Array.isArray(r) ? r : (r?.cards ?? r?.results ?? r?.data ?? []);
  if (!Array.isArray(list)) return [];
  return list.map(shapeCard).filter((c): c is ChCard => c !== null);
}

function shapeCard(c: any): ChCard | null {
  const cardId = c?.card_id ?? c?.id;
  if (cardId == null) return null;
  return {
    cardId: String(cardId),
    name: String(c?.name ?? c?.card_name ?? c?.description ?? ""),
    setName: c?.set ?? c?.set_name ?? null,
    number: c?.number ?? c?.card_number ?? null,
    player: c?.player ?? null,
    category: c?.category ?? null,
    imageUrl: c?.image_url ?? c?.image ?? null,
  };
}

// ------------------------------------------------------------------- prices

export type ChGradePrice = {
  grader: string;
  grade: string;
  price: number;
  currency: string;
};

/** Every grade they hold for one card.
 *
 *  Returned as (grader, grade, price) triples because that is the only key
 *  this system prices on — invariant 1, a grade belongs to a grading company
 *  and there is no grade-only lookup anywhere. A row whose grader cannot be
 *  read is DROPPED rather than filed under a guess: a PSA number under a
 *  Beckett badge is the exact failure the invariant exists to prevent. */
export async function allPricesByCard(cardId: string): Promise<ChGradePrice[]> {
  const r = await call<any>(
    "/v1/cards/all-prices-by-card",
    { card_id: cardId },
    prices,
    `allprices:${cardId}`,
  );
  const list = r?.prices ?? (Array.isArray(r) ? r : []);
  if (!Array.isArray(list)) return [];

  const out: ChGradePrice[] = [];
  for (const p of list) {
    const price = Number(p?.price ?? p?.value ?? p?.avg_price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const { grader, grade } = splitGrade(p);
    if (!grader || !grade) continue;
    out.push({ grader, grade, price, currency: String(p?.currency ?? "USD") });
  }
  return out;
}

/** Pull a grading company and a rung out of whatever shape the row carries.
 *
 *  Their grade field is sometimes structured and sometimes a single string
 *  like "PSA 10". Both are handled; anything that yields no company is
 *  refused rather than defaulted to PSA, because defaulting is how one
 *  company's price ends up under another's name. */
export function splitGrade(p: any): { grader: string | null; grade: string | null } {
  const rawGrader = p?.grader ?? p?.grading_company ?? p?.company ?? null;
  const rawGrade = p?.grade ?? p?.grade_value ?? null;

  if (rawGrader && rawGrade != null) {
    return { grader: String(rawGrader).toUpperCase().trim(), grade: normaliseGrade(rawGrade) };
  }
  // "PSA 10", "BGS 9.5", "CGC 10 Pristine", "Raw"
  const s = String(rawGrade ?? p?.label ?? "").trim();
  const m = s.match(/^([A-Za-z]{2,4})\s*([0-9]+(?:\.[05])?)/);
  if (m) return { grader: m[1]!.toUpperCase(), grade: normaliseGrade(m[2]!) };
  if (/^raw$|^ungraded$/i.test(s)) return { grader: "RAW", grade: "RAW" };
  return { grader: null, grade: null };
}

/** "10.0" and "10" are the same rung; "9.50" and "9.5" are too. */
function normaliseGrade(g: unknown): string | null {
  const n = Number(String(g).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return null;
  return String(n);
}

export type ChComps = {
  price: number | null;
  low: number | null;
  high: number | null;
  /** How many sales the figure was actually drawn from — the thing every
   *  price in this product has to carry. */
  sampleSize: number;
};

/** Completed sales for one card at one grade.
 *
 *  This is the hole eBay left. Marketplace Insights — the sold endpoint — was
 *  never approved for our application, which is why the app has been telling
 *  people it can itemise 0 of 9 recorded sales. `count_used` is the number
 *  behind the figure and travels with it, because a price without its sample
 *  is not something this product is allowed to show. */
export async function comps(
  cardId: string,
  grade: string,
  count = 20,
): Promise<ChComps | null> {
  const r = await call<any>(
    "/v1/cards/comps",
    {
      card_id: cardId,
      grade,
      count: Math.min(Math.max(count, 1), 100),
      // Recent sales weigh more, which is what the price engine already does
      // for its own windows.
      time_weighted: true,
    },
    prices,
    `comps:${cardId}:${grade}:${count}`,
  );
  if (!r) return null;
  const price = num(r.comp_price);
  const used = Number(r.count_used ?? 0);
  // A comp figure with nothing behind it is not a comp.
  if (price == null || !(used > 0)) return null;
  return { price, low: num(r.low), high: num(r.high), sampleSize: used };
}

export type ChHistoryPoint = { day: string; price: number };

/** Price history for one card at one grade, for the chart.
 *
 *  PriceCharting — the other candidate for this job — serves only current
 *  values and no history at all, which is what ruled it out: our card page is
 *  a chart. */
export async function priceHistory(
  cardId: string,
  grade: string,
  days = 365,
): Promise<ChHistoryPoint[]> {
  const r = await call<any>(
    "/v1/cards/prices-by-card",
    { card_id: cardId, grade, days },
    prices,
    `hist:${cardId}:${grade}:${days}`,
  );
  const list = r?.prices ?? (Array.isArray(r) ? r : []);
  if (!Array.isArray(list)) return [];
  return list
    .map((p: any) => ({
      day: String(p?.date ?? p?.day ?? p?.as_of ?? "").slice(0, 10),
      price: Number(p?.price ?? p?.value),
    }))
    .filter((p) => p.day.length === 10 && Number.isFinite(p.price) && p.price > 0);
}

// --------------------------------------------------------------- population

export type ChPopulation = {
  gemrateId: string | null;
  asOf: string | null;
  /** Counts per grading company, per rung. Never flattened across companies:
   *  a PSA 10 and a BGS 10 are different objects and adding them is the same
   *  mistake as pricing one from the other. */
  byGrader: Record<string, Record<string, number>>;
  total: number | null;
};

/** How many of this card exist at each grade, from GemRate.
 *
 *  POP counts have been a stated gap since the scope was written and there
 *  has been no source for them. Note their own marking on this endpoint: it
 *  needs a GemRate contract on top of the Card Hedge one, so a 403 here means
 *  the commercial arrangement rather than a bug. That case is logged plainly
 *  above so it is not mistaken for one. */
export async function population(cardId: string): Promise<ChPopulation | null> {
  const r = await call<any>(
    "/v1/cards/population-by-card",
    { card_id: cardId },
    catalogue,
    `pop:${cardId}`,
  );
  if (!r) return null;

  const byGrader: Record<string, Record<string, number>> = {};
  for (const g of (Array.isArray(r.graders) ? r.graders : [])) {
    const name = String(g?.grader ?? g?.name ?? "").toUpperCase().trim();
    if (!name) continue;
    const rungs: Record<string, number> = {};
    const src = g?.grades ?? g?.population ?? g?.counts ?? {};
    if (Array.isArray(src)) {
      for (const row of src) {
        const grade = normaliseGrade(row?.grade);
        const n = Number(row?.count ?? row?.population ?? row?.pop);
        if (grade && Number.isFinite(n)) rungs[grade] = n;
      }
    } else if (src && typeof src === "object") {
      for (const [grade, n] of Object.entries(src)) {
        const g2 = normaliseGrade(grade);
        if (g2 && Number.isFinite(Number(n))) rungs[g2] = Number(n);
      }
    }
    if (Object.keys(rungs).length) byGrader[name] = rungs;
  }
  if (!Object.keys(byGrader).length) return null;

  return {
    gemrateId: r.gemrate_id ?? null,
    asOf: r.as_of ?? null,
    byGrader,
    total: num(r?.totals?.total ?? r?.totals?.population) ?? null,
  };
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Whether the provider is configured, for a status endpoint to report.
 *  Deliberately reports the two halves separately: a key with the cap left at
 *  zero looks identical to no key at all from the outside, and that has cost
 *  an afternoon before. */
export function cardHedgerStatus() {
  return {
    hasKey: Boolean(process.env.CARDHEDGER_API_KEY),
    dailyMax: DAILY_MAX,
    enabled: enabled(),
    usedToday: usedToday("cardhedger"),
  };
}
