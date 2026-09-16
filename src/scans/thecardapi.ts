import { TtlCache } from "./ttlcache.js";
import { isCatalogueOnlyCard } from "./editions.js";
import { isSportCard } from "./sports.js";
import { recordUsage, usedToday } from "./usage.js";
import { GRADER_ALTERNATION } from "./graders.js";
import {
  NOT_ONE_CARD, isDesignationListing, labelFromTitle, mentionsCard,
  numberInTitle, sameForm, searchableSetName, setInTitle, setWords,
  statesACardNumber,
} from "./ebaylistings.js";

// The Card API — itemised COMPLETED SALES, which nothing else we have sells.
//
// This is the hole `sales/ledger.ts` was built around and `cardhedger.ts`
// names: PokemonPriceTracker returns per-grade rollups and no individual
// sales, eBay's Marketplace Insights was never approved, and our own ledger
// only ever fills with trades that happened on our own platform. A price
// keyed on (card, grader, grade) with a *sample* behind it has, until now,
// had no external source of that sample.
//
// EVERY SHAPE BELOW WAS READ OFF LIVE RESPONSES with our own key on
// 2026-09-11, not from the documentation prose. That matters more than usual
// here, because the marketing and the wire disagree:
//
//   TCGplayer rows are STRUCTURED — card_set, card_number, condition,
//   features[], and sometimes grader/grade. Matchable on fields.
//
//   eBay rows are a RAW TITLE and nothing else. `category`, `sport`,
//   `player`, `grader`, `card_set` and `card_number` all come back null on
//   every eBay row we have seen — 304,421 of them in the window. They are not
//   enriched, whatever the pricing page says.
//
// So `category=sports` returns 0 rows even though the eBay feed is full of
// hockey; the sports data is there, it is just uncategorised. Anything that
// filters on a structured field silently excludes the entire eBay half.
//
// Which means the eBay half arrives in exactly the shape this repo already
// knows how to handle, and it goes through the SAME guards the asks panel
// uses — `mentionsCard`, `sameForm`, `setInTitle`, `numberInTitle`. Those
// guards exist because twelve "Mega Meganium ex" listings once priced a
// Meganium at US$195 against a true US$0.24. A sold row is worse than an ask
// row when it is wrong: an ask is a claim, a sale is evidence, and evidence
// gets written into an append-only ledger.
//
// OFF BY DEFAULT, per the house rule that a paid dependency ships with a cap
// and a cache or it does not ship. `THECARDAPI_KEY` absent means off, and
// `THECARDAPI_DAILY_ROWS` at 0 means off even with a key.

const BASE = "https://www.thecardapi.com/api/v1/market";

/** Their header, confirmed on the wire. */
const AUTH_HEADER = "x-market-api-key";

// The budget is ROWS, not calls.
//
// This is the whole cost model and it is unlike every other provider here:
// the plan grants a number of sales rows per UTC day (5,000 on free) and one
// request may return up to 1,000 of them. A cap counted in requests would be
// meaningless — a single careless `limit=1000` is a fifth of the day.
const dailyRows = (): number => Number(process.env.THECARDAPI_DAILY_ROWS ?? 0);

/** Most rows a single request may ask for, whatever the caller wants.
 *  Their ceiling is 1,000; ours is far lower because a comp set of more than
 *  a few dozen sales is not a better median, it is just a bigger bill. */
const MAX_PAGE = 60;

const enabled = () => Boolean(process.env.THECARDAPI_KEY) && dailyRows() > 0;

/** A completed sale moves slower than an ask and much slower than a
 *  catalogue: yesterday's sales are yesterday's sales forever. Six hours is
 *  chosen against the free plan's 3-day lookback — a longer TTL would hold a
 *  window that has already rolled out from under it. */
const comps = new TtlCache<TcaSale[]>(6 * 60 * 60_000, 2_000);
/** Coverage and platform lists change once a day at most. */
const meta = new TtlCache<unknown>(24 * 60 * 60_000, 16);

/** What the provider itself says is left today, from `x-ratelimit-*`.
 *  Their number, not ours — preferred over the local count wherever both
 *  exist, the same way PPT's headers are. Null until the first call. */
let reported: { limit: number | null; remaining: number | null; resetsAt: string | null } = {
  limit: null, remaining: null, resetsAt: null,
};

export type TcaSale = {
  id: string;
  platform: string;
  title: string;
  /** auction | fixed_price | best_offer */
  listingType: string | null;
  soldAt: string;
  price: number;
  /** what it was listed at, when a best offer came in under it */
  askedPrice: number | null;
  currency: string;
  url: string | null;
  imageUrl: string | null;
  /** structured, and present only on TCGplayer rows */
  cardSet: string | null;
  cardNumber: string | null;
  condition: string | null;
  features: string[];
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ------------------------------------------------------------------ metering

/** One request, metered in rows and bounded.
 *
 *  Rows are counted BEFORE the response is read, from what we asked for, and
 *  then reconciled to what actually came back. A request that times out still
 *  spent its rows on their side; a cap that only counts successful rows is
 *  not a cap. */
async function call<T>(path: string, params: Record<string, string | number | undefined>, want: number): Promise<T | null> {
  if (!enabled()) return null;

  const spent = usedToday("thecardapi");
  if (spent + want > dailyRows()) {
    console.warn(
      `[thecardapi] row budget would be exceeded (${spent}+${want}/${dailyRows()}) — ` +
        `skipping, card falls back to asks`,
    );
    return null;
  }
  // Their own count, when we have one, overrides ours. Two keys on one plan,
  // or a CSV export pulled by hand, both spend budget this process never saw.
  if (reported.remaining !== null && reported.remaining < want) {
    console.warn(`[thecardapi] provider reports ${reported.remaining} rows left — skipping`);
    return null;
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }

  try {
    recordUsage("thecardapi", want);
    const res = await fetch(`${BASE}${path}?${qs}`, {
      headers: { [AUTH_HEADER]: process.env.THECARDAPI_KEY! },
      signal: AbortSignal.timeout(25_000),
    });

    // `Number(null)` is 0, not NaN — so reading an ABSENT header through
    // Number.isFinite reports a budget of zero rows and disables the provider
    // for the rest of the day. `/platforms` sends no rate-limit headers at
    // all (it costs no rows), so the first metadata call did exactly that.
    const header = (name: string): number | null => {
      const raw = res.headers.get(name);
      if (raw === null || raw.trim() === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const lim = header("x-ratelimit-limit");
    const rem = header("x-ratelimit-remaining");
    const rst = header("x-ratelimit-reset");
    if (lim !== null) reported.limit = lim;
    if (rem !== null) reported.remaining = rem;
    if (rst !== null) reported.resetsAt = new Date(rst * 1000).toISOString();

    if (res.status === 403) {
      // Catalog access is a separate paid pool from sales. Say which, because
      // "403" on a key that demonstrably works is an afternoon otherwise.
      console.warn(`[thecardapi] 403 on ${path} — that pool is not enabled for this key`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[thecardapi] ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e: any) {
    console.warn(`[thecardapi] ${path} failed: ${e?.message ?? e}`);
    return null;
  }
}

// ------------------------------------------------------- reading a grade

/** A grade token in a title is not a grade. Invariant 4.
 *
 *  These are the negative guards the invariant names, and until now they
 *  existed only in CLAUDE.md — the asks path reads a grade off a title to
 *  *match* listings, which is a cheaper decision than this one. Here the
 *  answer becomes a row in an append-only ledger under a (grader, grade) key,
 *  so a title that merely mentions PSA 10 must not produce one.
 *
 *  Each pattern below is a real way sellers write about a grade they do not
 *  have. "PSA 10 CANDIDATE", "WOULD GRADE PSA 9", "UNGRADED", a trailing
 *  question mark, "GEM MINT?" — all of them are raw cards being sold on the
 *  hope of a grade, and all of them trade far below the slab they name. */
const NOT_ACTUALLY_GRADED = [
  /\bCANDIDATE\b/,
  /\bWOULD\s+(?:GRADE|GET|BE)\b/,
  /\bUN[\s-]?GRADED\b/,
  /\bNOT\s+GRADED\b/,
  /\bRAW\b/,
  /\bWORTHY\b/,
  /\bPOTENTIAL\b/,
  /\bREADY\s+(?:TO|FOR)\s+GRADE\b/,
  /\bPRE[\s-]?GRADE\b/,
  /\bCOMES?\s+BACK\b/,
] as const;

// Built from the one grader list (graders.ts) so a company known to the asks
// path is known here too, plus RCR/BRCR — not a slab, but it has to be matched
// before it can be rejected as one (invariant 3, handled below).
const GRADE_RE = new RegExp(`\\b(${GRADER_ALTERNATION}|RCR|BRCR)\\s*[-:]?\\s*(\\d{1,3}(?:\\.5)?)\\b`, "i");
/** PSA's qualifiers, written after the number. They mean the grade is
 *  conditional and the card trades below a clean one at the same rung, so
 *  they belong in the price key rather than being dropped. */
const QUALIFIER_RE = /\b(?:OC|ST|MK|MC|PD|OF)\b/;

export type SaleGrade = {
  grader: string | null;
  grade: string | null;
  qualifier: string | null;
  labelVariant: string | null;
  /** why we decided what we decided, for the low-confidence log */
  reason: string;
};

const RAW: SaleGrade = { grader: null, grade: null, qualifier: null, labelVariant: null, reason: "raw" };

/** Decide the price key for one sale.
 *
 *  Structured fields win when the provider sends them, because a TCGplayer
 *  row saying `grader: "PSA", grade: "9"` is the marketplace's own record and
 *  not somebody's prose. Only the eBay half falls through to the title. */
export function saleGrade(row: {
  title?: string | null;
  grader?: string | null;
  grading_company?: string | null;
  grade?: string | number | null;
  grade_qualifier?: string | null;
  has_grade_qualifier?: boolean | null;
  label?: string | null;
}): SaleGrade {
  const title = String(row.title ?? "");
  const U = title.toUpperCase();

  // A lot, a break slot or a damaged slab is not a comparable at any grade.
  if (NOT_ONE_CARD.test(title)) return { ...RAW, reason: "not-one-card" };

  const structuredGrader = String(row.grader ?? row.grading_company ?? "").toUpperCase().trim();
  const structuredGrade = normaliseGrade(row.grade);
  if (structuredGrader && structuredGrade) {
    return {
      grader: canonicalGrader(structuredGrader),
      grade: structuredGrade,
      qualifier: row.grade_qualifier ?? null,
      labelVariant: labelFromTitle(title),
      reason: "structured",
    };
  }
  // A company with no rung, or a rung with no company, is not a price key.
  // Never defaulted to PSA — invariant 1, and the failure cardhedger.test
  // was written for.
  if (structuredGrader || structuredGrade) return { ...RAW, reason: "half-a-key" };

  const m = GRADE_RE.exec(title);
  if (!m) return { ...RAW, reason: "no-token" };

  if (NOT_ACTUALLY_GRADED.some((re) => re.test(U))) {
    return { ...RAW, reason: "aspirational" };
  }
  // "...PSA 10?" is a question, not a slab.
  if (/\?\s*$/.test(title.trim())) return { ...RAW, reason: "question" };

  // A grade token sitting against a # or a fraction is a collector number
  // that happens to follow a company name in the title.
  const after = title.slice(m.index + m[0].length);
  if (/^\s*\//.test(after)) return { ...RAW, reason: "denominator" };
  const before = title.slice(0, m.index);
  if (/#\s*$/.test(before)) return { ...RAW, reason: "card-number" };

  const grade = normaliseGrade(m[2]);
  if (!grade) return { ...RAW, reason: "grade-out-of-range" };

  const grader = canonicalGrader(m[1].toUpperCase());
  // BRCR / Raw Card Review is not a slab — invariant 3. It carries a number
  // and a company name and is priced as raw.
  if (grader === "RCR") return { ...RAW, reason: "review-not-slab" };

  // An autograph authentication is a different product from a numeric grade.
  if (isDesignationListing(title) && !/\b\d/.test(m[2])) {
    return { ...RAW, reason: "designation" };
  }

  const q = QUALIFIER_RE.exec(after.slice(0, 12));
  return {
    grader,
    grade,
    qualifier: q ? q[0] : null,
    labelVariant: labelFromTitle(title),
    reason: "title",
  };
}

/** Beckett writes itself four ways and BCCG is a different product entirely
 *  (invariant 3) — it keeps its own name so it can never be read as BGS. */
function canonicalGrader(g: string): string {
  const s = g.toUpperCase().trim();
  if (s === "BECKETT") return "BGS";
  if (s === "BRCR") return "RCR";
  return s;
}

/** "10.0", 10 and "10" are one rung; anything off the scale is not a grade.
 *  SGC's legacy slabs run to 100, so the range has to admit them — but a
 *  three-digit number that is not on SGC's scale is a print run, not a grade. */
export function normaliseGrade(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 10) return String(n);
  if (n >= 10 && n <= 100 && Number.isInteger(n)) return String(n); // SGC legacy
  return null;
}

// -------------------------------------------------------------- matching

export type CompTarget = {
  /** what we call this card in our own catalogue */
  catalogId: string;
  name: string;
  setName?: string | null;
  number?: string | null;
  game?: string | null;
};

/** "Base Set" and "Base Set 2" are different sets eight months apart.
 *
 *  `setInTitle` cannot tell them apart and should not have to: it drops SET
 *  as a stopword, so both reduce to BASE and both match. That is the right
 *  behaviour for showing asks — a human reads the title — and the wrong one
 *  for writing a ledger row, because the sequel's Charizard is 4/130 and the
 *  original's is 4/102 and the gap between them is five figures.
 *
 *  The rule is narrow on purpose: a trailing ORDINAL on the set phrase must
 *  agree. It catches the sequel families (Base Set 2, Series 2, Wave 3) and
 *  deliberately says nothing about "Team Rocket" vs "Team Rocket Returns",
 *  which is a word rather than a number and is somebody else's problem. */
export function setEditionMismatch(title: string, setName: string): boolean {
  // The ordinal our own set carries, if any: "Base Set 2" -> "2".
  const ourOrdinal = /\b(\d{1,2})\s*$/.exec(setName.trim())?.[1] ?? null;
  const stem = setWords(ourOrdinal ? setName.replace(/\b\d{1,2}\s*$/, "") : setName);
  if (!stem.length) return false;

  // The words `setWords` drops as uninformative still sit between the stem
  // and the ordinal in the actual text — "BASE" ... "SET" ... "2" — so they
  // have to be stepped over rather than ignored.
  const FILLER = "(?:\\s+(?:SET|SETS|EDITION|SERIES|THE|OF|AND|POKEMON|TCG))*";
  const last = stem[stem.length - 1]!;

  // Matched on the ORIGINAL text, not on word tokens. Splitting "#4/102" into
  // tokens turns a collector number into a bare "4" that reads exactly like
  // an edition ordinal, which would reject every correctly-numbered Base Set
  // listing there is. Requiring whitespace before the digits, and refusing a
  // "/" after them, keeps a card number from ever being read as an edition.
  const re = new RegExp(`\\b${last}\\b${FILLER}\\s+(\\d{1,2})(?![\\d/])`, "g");
  const U = title.toUpperCase();

  let found = false;
  for (const m of U.matchAll(re)) {
    found = true;
    if (m[1] === ourOrdinal) return false; // an occurrence agrees
  }
  // No ordinal anywhere after the set phrase means the title names the base
  // edition. That agrees only if ours is the base edition too.
  if (!found) return ourOrdinal !== null;
  return true;
}

export type MatchedSale = TcaSale & {
  key: SaleGrade;
  /** how the row was tied to the card: "fields" beats "title" */
  via: "fields" | "title";
};

/** Is this sale a sale OF THIS CARD?
 *
 *  The same question the asks panel answers, and answered with the same
 *  functions, so a listing that is too loose to show as an ask cannot be
 *  tight enough to write into the ledger as a sale. */
export function matchesTarget(row: TcaSale, want: CompTarget): "fields" | "title" | null {
  // TCGplayer rows carry the set and the number as fields. When both agree
  // there is nothing to infer and no title to misread.
  if (row.cardSet && row.cardNumber && want.setName && want.number) {
    const numberOk = String(row.cardNumber).replace(/^0+(?=\d)/, "")
      === String(want.number).replace(/^0+(?=\d)/, "");
    if (numberOk && setInTitle(row.cardSet, want.setName) && mentionsCard(row.title, want.name)
      && sameForm(want.name, row.title)) {
      return "fields";
    }
    // Fields present and disagreeing is a definite no, not a fallthrough to
    // the title — the structured row already told us it is a different card.
    if (!numberOk) return null;
  }

  if (NOT_ONE_CARD.test(row.title)) return null;
  if (!mentionsCard(row.title, want.name)) return null;
  // "Mega Meganium ex" is not "Meganium". This one line is the US$195 bug.
  if (!sameForm(want.name, row.title)) return null;

  // A number, when we have one and the title states one, must be THE number.
  if (want.number && statesACardNumber(row.title) && !numberInTitle(row.title, want.number)) {
    return null;
  }
  // The set has to be stated, even when the number already is.
  //
  // The asks panel lets a stated number stand in for the set, which is fine
  // there — an ask is a claim and the panel shows it with its title attached
  // for a human to judge. Here the row becomes a ledger entry under a price
  // key with no title in front of anyone, and a collector number is not
  // unique across sets: "4/102" is Base Set Charizard AND the Celebrations
  // Classic Collection reprint, which trades at a fifth of it.
  if (want.setName && !setInTitle(row.title, want.setName)) return null;
  if (want.setName && setEditionMismatch(row.title, want.setName)) return null;
  return "title";
}

// --------------------------------------------------------------- the calls

function toSale(r: any): TcaSale | null {
  const price = num(r?.price);
  const soldAt = String(r?.sold_at ?? r?.sale_date ?? "");
  const title = String(r?.title ?? "");
  if (!price || !soldAt || !title || !r?.id) return null;
  return {
    id: String(r.id),
    platform: String(r.platform ?? "unknown"),
    title,
    listingType: r.listing_type ?? null,
    soldAt,
    price,
    askedPrice: num(r?.original_price),
    currency: String(r.currency ?? "USD").toUpperCase(),
    url: r.listing_url ?? null,
    imageUrl: r.image_url ?? r.thumbnail_url ?? null,
    cardSet: r.card_set ?? null,
    cardNumber: r.card_number == null ? null : String(r.card_number),
    condition: r.condition ?? null,
    features: Array.isArray(r.features) ? r.features.map(String) : [],
  };
}

/** The search string for one card. This is the single highest-leverage line
 *  in the file and it was measured, not reasoned about.
 *
 *  `q=Charizard` sorted date_desc returns whatever is hot right now: on
 *  2026-09-11 that was twenty-five Mega Charizard promos and not one Base Set
 *  card, so the guards below correctly kept ZERO of twenty-five and we had
 *  paid for all of them. `q=Charizard "Base Set"` returns 117 rows that are
 *  actually Base Set Charizards, up to a $20,000 1st Edition Shadowless.
 *
 *  On the syntax, measured 2026-09-14 (an earlier version of this comment
 *  said they had no boolean syntax — it had only tried the two forms that
 *  fail): a space is AND, `"..."` is a phrase, and `(a,b)` is a working OR.
 *  The OR is a true union, not a sum — `(charizard,pikachu) pokemon` returns
 *  5,500 against 2,447 + 3,102 = 5,549, the difference being the 49 listings
 *  holding both. What does NOT work is the literal word `AND`, which is
 *  treated as a search term and collapses 117 rows to 1, `+term`, which
 *  returns nothing, and a bare comma outside parentheses.
 *
 *  Only juxtaposition and quotes are used below. `(a,b)` is available for a
 *  caller that wants to widen a name — alternate spellings, say — but a
 *  wider query costs rows and the guards reject the extra rows anyway.
 *
 *  The set goes in quoted and the number does not go in at all: "4/102" also
 *  belongs to the Celebrations reprint, which trades at a fifth of the
 *  original, and `numberInTitle` can tell them apart afterwards for free. */
export function compQuery(want: CompTarget): string {
  const set = want.setName ? searchableSetName(want.setName, want.game) : "";
  return set ? `${want.name} "${set}"` : want.name;
}

export type CompResult = {
  sales: MatchedSale[];
  /** returned by the provider and thrown away by the guards above. A high
   *  number here against a low `sales.length` is the signal that a query is
   *  too loose, and it is the reason this is reported rather than logged. */
  examined: number;
  rejected: number;
  /** the provider's own count of everything matching the query, which is
   *  almost always far larger than what we paid to look at */
  total: number | null;
};

/** Completed sales for one card, already matched and keyed.
 *
 *  Never call this from a request handler — house rule. It reaches a metered
 *  provider; it belongs behind `gradedPricesFor()` or in the refresh job. */
export async function soldComps(want: CompTarget, opts: { limit?: number; sinceDays?: number } = {}): Promise<CompResult> {
  const empty: CompResult = { sales: [], examined: 0, rejected: 0, total: null };
  if (!enabled()) return empty;
  // Searched by name, and written into an append-only ledger under OUR id.
  // A sports entry is every card of a player; a catalogue-only card is a
  // specific product — often a Japanese or Korean print — whose name finds
  // the English card. Sales found that way would be permanent evidence for
  // the wrong object, so these ids are never looked up.
  if (isSportCard(want.catalogId) || isCatalogueOnlyCard(want.catalogId)) return empty;

  const limit = Math.min(opts.limit ?? 25, MAX_PAGE);
  const key = `${want.name}|${want.setName ?? ""}|${want.number ?? ""}|${limit}|${opts.sinceDays ?? ""}`;
  const cached = comps.get(key);
  if (cached !== undefined) {
    return { sales: cached as MatchedSale[], examined: cached.length, rejected: 0, total: null };
  }

  const params: Record<string, string | number | undefined> = {
    q: compQuery(want),
    limit,
    sort: "date_desc",
  };
  if (opts.sinceDays) {
    params.date_from = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().slice(0, 10);
  }

  const r = await call<any>("/sales", params, limit);
  if (!r || !Array.isArray(r.data)) return empty;

  // Reconcile the reservation against what actually arrived. Asking for 25
  // and getting 3 should not cost 25 for the rest of the day.
  const got = r.data.length;
  if (got < limit) recordUsage("thecardapi", got - limit);

  const sales: MatchedSale[] = [];
  let rejected = 0;
  for (const raw of r.data) {
    const row = toSale(raw);
    if (!row) { rejected++; continue; }
    const via = matchesTarget(row, want);
    if (!via) { rejected++; continue; }
    sales.push({ ...row, key: saleGrade(raw), via });
  }

  comps.set(key, sales);
  return { sales, examined: got, rejected, total: num(r?.pagination?.total) };
}

/** Which platforms they hold, and how fresh each one is.
 *
 *  Worth reading before trusting a comp set: five of their seven platforms
 *  are auction houses whose newest sale is months old, and on a plan with a
 *  short lookback they are invisible entirely — the window ends before their
 *  data begins. Costs no rows.
 *
 *  Reads `/platforms`, NOT the `/coverage` endpoint that is documented for
 *  exactly this. `/coverage` answered once and has hung on every call since —
 *  two consecutive 60-second timeouts against `/platforms` returning the
 *  identical payload in 1.3s, measured 2026-09-11. If it is ever fixed, the
 *  only difference is the path. */
export async function coverage(): Promise<{ platform: string; lastSaleDate: string | null; totalRecords: number | null }[]> {
  const hit = meta.get("coverage");
  if (hit !== undefined) return hit as any;
  const r = await call<any[]>("/platforms", {}, 0);
  const out = Array.isArray(r)
    ? r.map((p) => ({
        platform: String(p?.platform ?? ""),
        lastSaleDate: p?.last_sale_date ?? null,
        totalRecords: Number.isFinite(Number(p?.total_records)) ? Number(p.total_records) : null,
      }))
    : [];
  if (out.length) meta.set("coverage", out);
  return out;
}

/** Whether the provider is configured, for `GET /market/quota` to report.
 *  Both halves separately, for the same reason Card Hedge reports both: a key
 *  with the cap left at zero looks identical to no key at all. */
export function theCardApiStatus() {
  return {
    hasKey: Boolean(process.env.THECARDAPI_KEY),
    dailyRows: dailyRows(),
    enabled: enabled(),
    rowsUsedToday: usedToday("thecardapi"),
    /** the provider's own figures, null until the first call of the day */
    reported: { ...reported },
  };
}
