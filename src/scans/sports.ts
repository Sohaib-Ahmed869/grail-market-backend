import { TtlCache } from "./ttlcache.js";
import { recordUsage, usedToday } from "./usage.js";
import { EBAY, NOT_ONE_CARD, getToken, latinName, mentionsCard } from "./ebaylistings.js";
import type { SetDetail, SetSummary } from "./sets.js";

// Sports, from the one catalogue we can already read.
//
// `games.ts` said it plainly: sports has no free checklist anywhere. Card
// Hedge is paid and has no key here, and TCDB through Parse never got past
// setup. But eBay's Browse API — production keys, already wired for the asks
// panel — answers any search with ASPECT REFINEMENTS: the item specifics
// sellers fill in, counted. In "Sports Trading Card Singles" (261328) those
// include Sport, Set and Player/Athlete, so one call per level gives:
//
//   Basketball  -> 1,781 sets, "2023-24 Panini Prizm" among them
//   that set    -> 1,908 players, Victor Wembanyama first
//
// That is a real tree people can browse, measured on 2026-09-14. What it is
// NOT is a checklist:
//
//   - There are no card numbers. A "card" here is a PLAYER WITHIN A SET, which
//     is the base card, the rookie, every parallel and the 1/1s at once. One
//     page of Wembanyama 2023-24 Prizm listings ran from US$43 to US$800.
//     So nothing in this file produces a price, and `/market/price` refuses to
//     produce one for these ids — see `isSportCard` and CLAUDE.md's rule that a
//     confident wrong answer is the expensive one.
//   - The counts are LISTING counts, and eBay's are generous (a sport's
//     values sum past its own total). They are kept as `listed` for ordering
//     and never shown as a number of cards.
//   - The values are seller-typed. "Not Specified" is the biggest set in
//     every sport, and a hockey set turns up under AFL. Hence the junk filter,
//     the listing floor, and a league filter where the sport is small enough
//     for mis-tags to be a visible share of it.
//
// Every call is cached for a day, never on a schedule, and metered against a
// catalogue allowance that sits BELOW the asks panel's: browsing a checklist
// must never be the reason a card page cannot show what copies cost.

const CATEGORY_ID = "261328";
const DAY = 24 * 3600 * 1000;

export type Sport = {
  slug: string;
  name: string;
  /** The `Sport` aspect value that actually carries listings — read off the
   *  live distribution, not the taxonomy list, which offers both "Ice Hockey"
   *  and nothing called "Hockey" and says nothing about which is used. */
  value: string;
  marketplace: "EBAY_US" | "EBAY_AU";
  /** Narrow to these leagues. Only where the sport is small enough that
   *  mis-tagged listings are a visible share: under US "Australian Football",
   *  "2020 Topps" and "2024 Topps Chrome U.S. Olympic" ranked in the top ten
   *  sets until the league was required. */
  leagues?: string[];
  /** For the small sports whose set names collide with American ones. See
   *  `keepSet`. `names` is the league or competition in a set's name, which
   *  settles it; `makers` are the local printers, whose sets are kept at a
   *  lower share because their names ("1995 Select") are shared with a US
   *  product ten times the size. */
  local?: { names: RegExp; makers: RegExp };
};

/** Most-collected first, then the two Australian codes for the home market,
 *  then the rest by listing volume on 2026-09-14.
 *
 *  AFL, NRL and cricket read from eBay AUSTRALIA. On the US site
 *  "Australian Football" is 26 sets, mostly the same Select releases; on the
 *  AU site the value is spelt "Australian Rules Football" — the US spelling
 *  filters nothing there and returns the whole category, which is how a
 *  wrong value fails silently rather than loudly. */
export const SPORTS: Sport[] = [
  { slug: "basketball", name: "Basketball", value: "Basketball", marketplace: "EBAY_US" },
  { slug: "baseball", name: "Baseball", value: "Baseball", marketplace: "EBAY_US" },
  { slug: "football", name: "Football", value: "Football", marketplace: "EBAY_US" },
  { slug: "soccer", name: "Soccer", value: "Soccer", marketplace: "EBAY_US" },
  { slug: "hockey", name: "Hockey", value: "Ice Hockey", marketplace: "EBAY_US" },
  {
    slug: "afl", name: "AFL", value: "Australian Rules Football", marketplace: "EBAY_AU",
    leagues: ["Australian Football League (AFL)"],
    local: {
      names: /\b(afl|aflw|vfl|wafl|sanfl|footy|australian rules|australian football)\b/i,
      makers: /\b(select|teamcoach|scanlens|herald sun|dynamic|regina|stimorol|coles|weet-?bix|sanitarium|tip top)\b/i,
    },
  },
  {
    slug: "nrl", name: "NRL", value: "Rugby League", marketplace: "EBAY_AU",
    leagues: ["National Rugby League (NRL)", "Australian National Rugby League (NRL)"],
    local: {
      names: /\b(nrl|nrlw|rugby league|arl|nswrl|state of origin|super league)\b/i,
      makers: /\b(select|esp|dynamic|scanlens|herald sun|stimorol|coles|weet-?bix|sanitarium|tip top)\b/i,
    },
  },
  // Formula 1 and NASCAR both live under "Auto Racing"; there is no F1 value.
  { slug: "racing", name: "Motorsport", value: "Auto Racing", marketplace: "EBAY_US" },
  { slug: "wrestling", name: "Wrestling", value: "Wrestling", marketplace: "EBAY_US" },
  { slug: "mma", name: "UFC & MMA", value: "Mixed Martial Arts (MMA)", marketplace: "EBAY_US" },
  { slug: "golf", name: "Golf", value: "Golf", marketplace: "EBAY_US" },
  { slug: "tennis", name: "Tennis", value: "Tennis", marketplace: "EBAY_US" },
  { slug: "boxing", name: "Boxing", value: "Boxing", marketplace: "EBAY_US" },
  {
    slug: "cricket", name: "Cricket", value: "Cricket", marketplace: "EBAY_AU",
    local: {
      names: /\b(cricket|cricketers?|big bash|bbl|wbbl|ashes|ipl|icc|t20|the hundred)\b/i,
      // Not Wills or Player's: their cricket sets say "Cricketers" in the name,
      // and "1930 Wills Famous Golfers" is how a printer's name let golf in.
      makers: /\b(futera|select|scanlens|weet-?bix|sanitarium|tip top)\b/i,
    },
  },
];

const bySlug = new Map(SPORTS.map((s) => [s.slug, s]));
const byValue = new Map(SPORTS.map((s) => [s.value.toLowerCase(), s]));

export const sportBySlug = (slug: string): Sport | null => bySlug.get(slug) ?? null;

// ---- ids ---------------------------------------------------------------------
//
// Same two shapes as the rest of games.ts: a SET is `<prefix>:<code>` and a
// CARD is `<prefix>-<id>`. Those two disagreeing is what once broke every One
// Piece card page, so both are minted and read here and nowhere else.

export const isSportGame = (id: string | null | undefined): boolean =>
  Boolean(id && id.startsWith("sport:"));

export const isSportCard = (id: string | null | undefined): boolean =>
  Boolean(id && id.startsWith("sport-"));

export const sportSetId = (slug: string, set: string): string =>
  `sport:${slug}:${encodeURIComponent(set)}`;

export function readSportSetId(setId: string): { sport: Sport; set: string } | null {
  const m = /^sport:([a-z0-9]+):(.+)$/.exec(setId ?? "");
  const sport = m ? sportBySlug(m[1]) : null;
  if (!m || !sport) return null;
  try {
    const set = decodeURIComponent(m[2]);
    return set ? { sport, set } : null;
  } catch {
    return null;
  }
}

/** A card id carries its whole identity, because there is no row to look it
 *  up in: sport, set and player, base64url so a set called "Topps Chrome:
 *  Sapphire" or a player with a hyphen cannot break the prefix cut. */
export const sportCardId = (slug: string, set: string, player: string): string =>
  `sport-${Buffer.from(`${slug}|${set}|${player}`, "utf8").toString("base64url")}`;

export function readSportCard(id: string): { sport: Sport; set: string; player: string } | null {
  if (!isSportCard(id)) return null;
  let raw = "";
  try {
    raw = Buffer.from(id.slice("sport-".length), "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Slug before the first bar, player after the last: a set name is the only
  // part long and free-form enough to ever contain one.
  const first = raw.indexOf("|");
  const last = raw.lastIndexOf("|");
  if (first < 0 || last <= first) return null;
  const sport = sportBySlug(raw.slice(0, first));
  const set = raw.slice(first + 1, last);
  const player = raw.slice(last + 1);
  if (!sport || !set || !player) return null;
  return { sport, set, player };
}

// ---- reading the distributions -----------------------------------------------

type Distribution = { localizedAspectValue: string; matchCount: number }[];

/** Values that are a seller declining to answer, not an answer. */
const JUNK = new Set([
  "not specified", "n/a", "na", "none", "unknown", "various", "mixed", "multiple",
  "lot", "assorted", "see description", "see photos", "other", "unbranded",
  "mvp", "team", "rookie", "rc", "does not apply",
]);

export function isJunkValue(v: string): boolean {
  const t = (v ?? "").trim();
  if (!t || t.length > 90) return true;
  if (!/\p{L}/u.test(t)) return true;             // "2023", "#1", "---"
  return JUNK.has(t.toLowerCase());
}

/** The year a set was released, off the front of its name.
 *
 *  Sports sets are named by season — "2023-24 Panini Prizm", "1986 Fleer" —
 *  so the leading year IS the release year for sorting. A name without one is
 *  given none: a guessed date would sort it among sets it has nothing to do
 *  with. */
export function yearOf(name: string): string | null {
  const m = /^\s*((?:18|19|20)\d{2})\b/.exec(name ?? "");
  return m ? m[1] : null;
}

/** The floor below which a set is a typo, not a release.
 *
 *  Half a percent of the sport's biggest set, never under 5 and never over 25.
 *  One fixed number cannot serve both ends. Basketball's biggest set has
 *  ~300,000 listings and anything under 25 there is one seller's spelling
 *  ("2021 Panini Mosaic"); a floor of a few thousand, though, would drop 1952
 *  Topps, which matters far more than its count. AFL's biggest has ~2,500, and
 *  the values between 5 and 12 were "2010 Topps", "2009 SP" and "1995 Best" —
 *  American sets tagged with the wrong league — while every real Select
 *  release sat well above. Measured 2026-09-14. */
export function setFloor(dist: Distribution): number {
  const top = dist
    .filter((d) => !isJunkValue(d.localizedAspectValue))
    .reduce((m, d) => Math.max(m, d.matchCount), 0);
  return Math.min(25, Math.max(5, Math.round(top * 0.005)));
}

/** A player tagged by one listing is as often a nickname or a typo as a
 *  person — "Aaron Judge" turned up once under 1995 Select AFL — so two
 *  sellers must agree. Except where the sport is league-filtered: there the
 *  filter has already removed the mis-tags, and in a 1995 AFL set half the
 *  genuine players have exactly one listing. */
export const MIN_PLAYER_LISTINGS = 2;

export function setsFromDistribution(slug: string, dist: Distribution): SetSummary[] {
  const seen = new Set<string>();
  const out: SetSummary[] = [];
  const floor = setFloor(dist);
  for (const d of dist) {
    const name = String(d.localizedAspectValue ?? "").trim();
    if (isJunkValue(name) || d.matchCount < floor) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const year = yearOf(name);
    out.push({
      setId: sportSetId(slug, name),
      name,
      logo: null,
      symbol: null,
      // Unknown, and said so. A listing count is not a card count.
      total: 0,
      official: 0,
      releasedAt: year ? `${year}-01-01` : null,
      listed: d.matchCount,
    });
  }
  // Newest first, like every other set list; biggest first within a year. The
  // undated go last rather than first — a set we cannot place in time is not
  // the newest one.
  return out.sort((a, b) => {
    const ya = a.releasedAt ?? "";
    const yb = b.releasedAt ?? "";
    if (ya !== yb) return !ya ? 1 : !yb ? -1 : yb.localeCompare(ya);
    return (b.listed ?? 0) - (a.listed ?? 0) || a.name.localeCompare(b.name);
  });
}

export function playersFromDistribution(
  dist: Distribution, floor = MIN_PLAYER_LISTINGS,
): { name: string; listed: number }[] {
  const seen = new Set<string>();
  return dist
    .map((d) => ({ name: String(d.localizedAspectValue ?? "").trim(), listed: d.matchCount }))
    .filter((p) => {
      if (isJunkValue(p.name) || p.listed < floor) return false;
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.listed - a.listed || a.name.localeCompare(b.name));
}

const tokens = (s: string): string[] =>
  latinName(s).toLowerCase().split(/[\s'.-]+/).filter(Boolean);

/** How well a player's name answers a typed query, 0 when it does not.
 *
 *  Every word typed must start a word of the name. "wemby" is not in eBay's
 *  vocabulary and matches nothing, which is correct; "victor" matches Victor
 *  Wembanyama AND Victor Oladipo, which is also correct — they are both
 *  Victors. What must never happen is the looser rule the asks panel can
 *  afford, where any one long word is enough: a search for "Michael Jordan"
 *  would then offer Jordan Love. A different player is not a hit.
 *
 *  `mentionsCard` still runs on top, so this can only ever be stricter than
 *  the guard every other eBay path uses. */
export function playerMatch(query: string, player: string): number {
  const q = tokens(query);
  const p = tokens(player);
  if (!q.length || !p.length) return 0;
  let exact = 0;
  for (const w of q) {
    if (p.includes(w)) { exact++; continue; }
    if (w.length >= 3 && p.some((x) => x.startsWith(w))) continue;
    return 0;
  }
  if (!mentionsCard(player, query)) return 0;
  // All words whole and the whole name typed is the best a query can be.
  if (exact === q.length && q.length === p.length) return 0.95;
  if (exact === q.length) return 0.85;
  return 0.7;
}

/** Letters, spaces and the punctuation names carry — no digits, no codes. */
export function looksLikePlayer(q: string): boolean {
  const t = (q ?? "").trim();
  if (t.length < 3 || t.length > 40) return false;
  if (!/^[\p{L}\s'.-]+$/u.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && words.some((w) => w.length >= 3);
}

const flat = (s: string) =>
  latinName(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Does a listing title name this set?
 *
 *  Sellers write the season's first year alone — "2023 Panini Prizm" for
 *  "2023-24 Panini Prizm" — so both spellings are accepted. Nothing looser:
 *  "Panini Prizm" without a year is every Prizm ever printed. */
export function titleNamesSet(title: string, set: string): boolean {
  const t = ` ${flat(title)} `;
  const full = flat(set);
  if (!full) return false;
  if (t.includes(` ${full} `)) return true;
  const seasonless = flat(set.replace(/^(\d{4})-\d{2,4}\b/, "$1"));
  return seasonless !== full && t.includes(` ${seasonless} `);
}

type Item = { title?: string; image?: { imageUrl?: string }; thumbnailImages?: { imageUrl?: string }[] };

const imageOf = (it: Item): string | null =>
  it.image?.imageUrl ?? it.thumbnailImages?.[0]?.imageUrl ?? null;

/** The first listing picture whose title names this player.
 *
 *  A seller's photo, and it may be any printing of the player in the set —
 *  which is why it is a picture and never a price. */
export function imageForPlayer(items: Item[], player: string): string | null {
  const words = tokens(player).filter((w) => w.length >= 3);
  if (!words.length) return null;
  for (const it of items) {
    const title = String(it.title ?? "");
    const t = ` ${flat(title)} `;
    // Every word of the name, not just the longest: "Jalen Williams" and
    // "Jaylin Williams" are two players on one team in one set.
    if (!words.every((w) => t.includes(` ${w} `))) continue;
    const url = imageOf(it);
    if (url) return url;
  }
  return null;
}

// ---- the price rule ------------------------------------------------------------

/** What `/market/price` answers for a sports entry: every figure null.
 *
 *  Not "we have not looked". A player within a set has no single price to find
 *  — the base card, the Silver Prizm and the 1/1 are all the same entry here —
 *  so any number printed under it would be one of those cards' prices
 *  presented as all of them. The shape matches the normal answer exactly so
 *  the page renders its "no price" state rather than breaking. */
export function noFigure(a: {
  name: string; setName?: string | null; number?: string | null;
  grader?: string | null; grade?: number | null;
}) {
  return {
    name: a.name,
    setName: a.setName ?? null,
    number: a.number ?? null,
    grader: a.grader ?? null,
    grade: a.grade ?? null,
    rawUsd: null,
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
    unpriceable: "player-in-set" as const,
  };
}

// ---- calling eBay --------------------------------------------------------------

/** Catalogue calls allowed per UTC day, of eBay's 5,000 Browse calls.
 *  `EBAY_CATALOGUE_DAILY_MAX`, default 1500.
 *
 *  eBay's own Browse allowance for this app is `EBAY_BROWSE_DAILY_LIMIT`
 *  (5000), and `EBAY_ASKS_RESERVE` (1500) of it browsing may never touch. The
 *  asks panel records every call as `ebay`; once the day's total reaches the
 *  limit minus the reserve, the catalogue stops asking and serves whatever it
 *  has cached, so the panel always has room.
 *
 *  Read on every call rather than once at load, so the ceiling can be lowered
 *  in an incident without the catalogue carrying on at the old one. */
const envNumber = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return process.env[k] != null && process.env[k] !== "" && Number.isFinite(n) ? n : d;
};

export function catalogueMayCall(): boolean {
  try {
    return (
      usedToday("ebay-catalogue") < envNumber("EBAY_CATALOGUE_DAILY_MAX", 1500) &&
      usedToday("ebay") < envNumber("EBAY_BROWSE_DAILY_LIMIT", 5000) - envNumber("EBAY_ASKS_RESERVE", 1500)
    );
  } catch {
    return false;
  }
}

/** eBay wants `,` `|` `{` `}` inside an aspect value escaped, or the value is
 *  read as a separator and the filter silently means something else. */
const esc = (v: string) => v.replace(/([\\,|{}])/g, "\\$1");

async function browse(sport: Sport, opts: {
  q?: string; set?: string; player?: string; limit: number;
}): Promise<any | null> {
  if (!catalogueMayCall()) return null;
  const tok = await getToken();
  if (!tok) return null;

  const filter = [`categoryId:${CATEGORY_ID}`, `Sport:{${esc(sport.value)}}`];
  if (sport.leagues?.length) filter.push(`League:{${sport.leagues.map(esc).join("|")}}`);
  if (opts.set) filter.push(`Set:{${esc(opts.set)}}`);
  if (opts.player) filter.push(`Player/Athlete:{${esc(opts.player)}}`);

  const p = new URLSearchParams({
    category_ids: CATEGORY_ID,
    limit: String(opts.limit),
    fieldgroups: "ASPECT_REFINEMENTS,MATCHING_ITEMS",
    aspect_filter: filter.join(","),
  });
  if (opts.q) p.set("q", opts.q);
  return call(p, sport.marketplace, tok);
}

async function call(p: URLSearchParams, marketplace: string, tok: string): Promise<any | null> {
  try {
    // Both counters: `ebay` is the true daily total the asks panel shares,
    // `ebay-catalogue` is this file's own allowance.
    recordUsage("ebay");
    recordUsage("ebay-catalogue");
    const res = await fetch(`${EBAY}/buy/browse/v1/item_summary/search?${p}`, {
      headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": marketplace },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[sports] browse ${res.status} for ${p.get("aspect_filter") ?? p.get("q")}`);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

const distributionOf = (body: any, aspect: string): Distribution =>
  (body?.refinement?.aspectDistributions ?? [])
    .find((a: any) => a?.localizedAspectName === aspect)
    ?.aspectValueDistributions ?? [];

/** A filter eBay did not recognise is dropped, not refused: the answer is the
 *  whole category. The Sport distribution then holds a hundred values instead
 *  of one — which is the only way to tell. */
const filterHeld = (body: any, sport: Sport): boolean => {
  const d = distributionOf(body, "Sport");
  return d.length <= 1 || d.every((x) => x.localizedAspectValue.toLowerCase() === sport.value.toLowerCase());
};

// ---- sets ----------------------------------------------------------------------

const detailCache = new TtlCache<SetDetail>(DAY, 600, "sport-set-detail");
/** One picture per sports card id, or a recorded null.
 *
 *  Filled from anywhere a picture turns up for free — the set detail's 200
 *  listings, a search's evidence — and otherwise by `sportArt`, one call per
 *  player. A null here is a GENUINE miss: eBay was asked about exactly this
 *  player in exactly this set and had no listing with a picture. It is kept
 *  for a day like a hit, because asking again tomorrow is the only thing that
 *  could change it. A call that was refused by the budget or failed is never
 *  written here — that is "not asked", and caching it would blank a card for a
 *  day because of one bad minute. */
const art = new TtlCache<string | null>(DAY, 50_000, "sport-art");
const pictures = {
  get: (id: string): string | null => art.get(id) ?? null,
  set: (id: string, url: string) => art.set(id, url),
};

// ---- mis-tagged sets ---------------------------------------------------------------
//
// The small sports borrow their set lists from sellers who tag an American card
// with the wrong sport. Under AFL on 2026-09-14: "2009 Topps", "2008 Topps",
// "2002 SPx" and "1888 Allen & Ginter" — baseball, every one. The listing floor
// cannot catch them (2008 Topps had 326 AFL-tagged listings), because they are
// big sets with a small wrong corner.
//
// The question that does catch them is: of everyone who tagged this set with a
// sport, how many said THIS sport? Measured, AFL share of each set across the
// whole category on eBay AU:
//
//   2002 Select Australia Exclusive AFL  1.00     1996 Select Certified  0.024
//   1998 Select                          0.55     1994 Classic           0.024
//   1996 Select                          0.26     2002 SPx               0.069
//   1995 Select                          0.24     1888 Allen & Ginter    0.070
//   1994 Select                          0.15     2009 Topps             0.006
//   1997 Select                          0.10     2008 Topps             0.003
//
// No single cut separates those — the real Select releases share their name
// with Score's American Select, so 1997 Select is 10% AFL and 2002 SPx is 7%.
// Hence three rules: a set naming the league is kept outright; 25% of the tags
// is kept; and a local printer's set is kept from 5%. Under that, 1997 Select
// stays and SPx goes, and so does Pinnacle's Select Certified, which is "Select"
// at 2.4%.

export const SHARE_KEEP = 0.25;
export const SHARE_LOCAL_MAKER = 0.05;

/** This sport's share of the listings that name any sport, "Not specified"
 *  excluded — a seller who said nothing is not a vote for baseball. */
export function sportShare(dist: Distribution, value: string): number {
  const real = dist.filter((d) => !isJunkValue(d.localizedAspectValue));
  const total = real.reduce((n, d) => n + d.matchCount, 0);
  const mine = real.find((d) => d.localizedAspectValue.toLowerCase() === value.toLowerCase())?.matchCount ?? 0;
  return total > 0 ? mine / total : 0;
}

/** Keep this set in this sport? `share` null means it could not be measured. */
export function keepSet(sport: Sport, name: string, share: number | null): boolean {
  if (!sport.local) return true;
  if (sport.local.names.test(name)) return true;
  const maker = sport.local.makers.test(name);
  // Unmeasured: keep only what names a local printer. Missing a set for a
  // day is cheaper than listing a baseball set under AFL for a day.
  if (share == null) return maker;
  return share >= SHARE_KEEP || (maker && share >= SHARE_LOCAL_MAKER);
}

const verdicts = new TtlCache<number | null>(DAY, 5_000, "sport-verdicts");
/** Set lists built while some verdict could not be measured. games.ts does not
 *  cache these, so the next request tries the missing verdicts again. */
const provisional = new WeakSet<SetSummary[]>();
export const isProvisional = (list: SetSummary[]): boolean => provisional.has(list);

/** One call per set: the set alone, every sport, and read who tagged it. */
async function measureShare(sport: Sport, set: string): Promise<{ share: number | null; asked: boolean }> {
  const key = `${sport.slug}|${set}`;
  const hit = verdicts.entry(key);
  if (hit) return { share: hit.v, asked: true };
  if (!catalogueMayCall()) return { share: null, asked: false };
  const tok = await getToken();
  if (!tok) return { share: null, asked: false };
  const p = new URLSearchParams({
    category_ids: CATEGORY_ID,
    limit: "1",
    fieldgroups: "ASPECT_REFINEMENTS",
    aspect_filter: `categoryId:${CATEGORY_ID},Set:{${esc(set)}}`,
  });
  const body = await call(p, sport.marketplace, tok);
  if (!body) return { share: null, asked: false };
  // A Set filter eBay dropped measures the whole category, which says nothing
  // about this set. Recorded as unmeasurable, and that is stable, so cached.
  const share = distributionOf(body, "Set").length <= 1
    ? sportShare(distributionOf(body, "Sport"), sport.value)
    : null;
  verdicts.set(key, share);
  return { share, asked: true };
}

export async function withoutMistags(sport: Sport, sets: SetSummary[]): Promise<SetSummary[]> {
  if (!sport.local) return sets;
  const shares = new Map<string, number | null>();
  let incomplete = false;
  const queue = sets.filter((s) => !sport.local!.names.test(s.name));
  const worker = async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      const m = await measureShare(sport, s.name);
      if (!m.asked) incomplete = true;
      shares.set(s.name, m.share);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const kept = sets.filter((s) => keepSet(sport, s.name, shares.get(s.name) ?? null));
  if (incomplete) provisional.add(kept);
  return kept;
}

/** Every set in one sport. One call, cached a day by the caller in games.ts.
 *
 *  The fifty listings that come back with the distribution are not wasted:
 *  any whose title names a set give that set its picture immediately, and
 *  the rest are filled in the background by `withSportArt`. */
export async function sportSets(slug: string): Promise<SetSummary[]> {
  const sport = sportBySlug(slug);
  if (!sport) return [];
  const body = await browse(sport, { limit: 50 });
  if (!body || !filterHeld(body, sport)) return [];
  const sets = await withoutMistags(sport, setsFromDistribution(slug, distributionOf(body, "Set")));
  const items: Item[] = body.itemSummaries ?? [];
  for (const s of sets) {
    const it = items.find((i) => titleNamesSet(String(i.title ?? ""), s.name) && imageOf(i));
    if (it) s.logo = imageOf(it);
  }
  return sets;
}

/** Pictures for the first screenful of sets, after the list has gone out.
 *
 *  Each is the set's own detail call, which is cached — so the art costs
 *  nothing extra when the set is then opened, and opening it is the likeliest
 *  next thing. Bounded to the first 24 without a picture and three at a time,
 *  the same budget `withCardArt` keeps for the other catalogues. */
export async function withSportArt(slug: string, sets: SetSummary[]): Promise<SetSummary[]> {
  const out = [...sets];
  const queue = out
    .map((s, i) => ({ s, i }))
    .filter((x) => !x.s.logo)
    .slice(0, 24);
  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      if (!catalogueMayCall()) return;
      const detail = await sportSetDetail(job.s.setId).catch(() => null);
      const url = detail?.cards.find((c) => c.imageUrl)?.imageUrl;
      if (url) out[job.i] = { ...job.s, logo: url };
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return out;
}

/** One set: the players in it, most-listed first.
 *
 *  One call. The distribution names the players; the two hundred listings in
 *  the same answer give the ones people actually list a picture each. A
 *  player further down gets none rather than a borrowed one. */
export async function sportSetDetail(setId: string): Promise<SetDetail | null> {
  const hit = detailCache.get(setId);
  if (hit) {
    // Pictures resolved one by one since this set was built belong in it —
    // otherwise reopening the set shows the blanks the page just filled.
    return {
      ...hit,
      cards: hit.cards.map((c) => (c.imageUrl ? c : { ...c, imageUrl: pictures.get(c.cardId) })),
    };
  }
  const read = readSportSetId(setId);
  if (!read) return null;
  const { sport, set } = read;

  const body = await browse(sport, { set, limit: 200 });
  if (!body) {
    // Refused by the allowance or failed: yesterday's players for this set
    // beat an empty page.
    const last = detailCache.stale(setId);
    return last ?? null;
  }
  if (!filterHeld(body, sport)) return null;
  // The set filter must have held too, or this is the whole sport.
  const setDist = distributionOf(body, "Set");
  if (setDist.length > 1) return null;

  const items: Item[] = body.itemSummaries ?? [];
  const players = playersFromDistribution(
    distributionOf(body, "Player/Athlete"),
    sport.leagues?.length ? 1 : MIN_PLAYER_LISTINGS,
  );
  const cards = players.map((p) => {
    const cardId = sportCardId(sport.slug, set, p.name);
    const imageUrl = imageForPlayer(items, p.name);
    if (imageUrl) pictures.set(cardId, imageUrl);
    return {
      cardId,
      name: p.name,
      localId: "",
      imageUrl,
      // Never a price. See the header of this file.
      rawUsd: null,
      rarity: null,
    };
  });
  if (!cards.length) return null;

  const year = yearOf(set);
  const detail: SetDetail = {
    setId,
    name: set,
    logo: cards.find((c) => c.imageUrl)?.imageUrl ?? null,
    symbol: null,
    total: 0,
    official: 0,
    releasedAt: year ? `${year}-01-01` : null,
    listed: body.total ?? undefined,
    cards,
  };
  detailCache.set(setId, detail);
  return detail;
}

/** Most ids one art request may ask about. The page asks for what is on
 *  screen; more than a screenful in one request is a crawl. */
export const MAX_ART_IDS = 12;
const ART_CONCURRENCY = 4;
/** Art lookups in flight, so a set page and a card page asking about the same
 *  player at the same moment spend one call, not two. Emptied as each settles. */
const artInFlight = new Map<string, Promise<string | null>>();

/** "You pick", "choose your card": one listing selling a whole checklist,
 *  tagged with every player on it, photographed as a pile. */
const PICK_LIST = /\b(you pick|u pick|pick (your|a|any|from)|choose (your|from|a|any)|select (your|from|a|any)|singles)\b/i;

/** The listing picture to use for one player: a title carrying the surname
 *  first, then any picture of a single card.
 *
 *  The aspect filter ties every item to this player, but not to a photo OF
 *  him. On 2026-09-14 Jermain Defoe, John Terry and Shay Given in 2009 Topps
 *  soccer all came back with one listing — "2009-10 Topps Match Attax English
 *  Premier -You Pick-", a pile of cards tagged with every name on the
 *  checklist — and so with one identical picture. Three faces from one photo
 *  is a wrong face twice over. A title without the surname is only trusted
 *  when it is plainly one card; otherwise the answer is no picture. */
export function pickArt(items: Item[], player: string): string | null {
  const surname = tokens(player).filter((w) => w.length >= 3).pop();
  if (surname) {
    for (const it of items) {
      const url = imageOf(it);
      if (url && ` ${flat(String(it.title ?? ""))} `.includes(` ${surname} `)) return url;
    }
  }
  for (const it of items) {
    const url = imageOf(it);
    const title = String(it.title ?? "");
    if (url && !NOT_ONE_CARD.test(title) && !PICK_LIST.test(title)) return url;
  }
  return null;
}

async function resolveArt(id: string): Promise<string | null> {
  const hit = art.entry(id);
  if (hit) return hit.v;
  const read = readSportCard(id);
  if (!read) return null;

  const body = await browse(read.sport, { set: read.set, player: read.player, limit: 12 });
  // Refused or failed: nothing learned, nothing cached.
  if (!body) return null;
  // eBay drops a filter it cannot read rather than refusing — the answer is
  // then some other player's listings. That is a stable property of the value,
  // so it IS cached, as a miss: a wrong face is worse than no face.
  const held =
    filterHeld(body, read.sport) &&
    distributionOf(body, "Set").length <= 1 &&
    distributionOf(body, "Player/Athlete").length <= 1;
  const url = held ? pickArt(body.itemSummaries ?? [], read.player) : null;
  art.set(id, url);
  return url;
}

/** Pictures for sports cards, by id.
 *
 *  The set detail can only picture the players whose listings happen to fall
 *  in its 200 — about one in fifteen in a big set, and none at all in a small
 *  one where the few listings belong to three players. This asks per player,
 *  for the cards actually on screen: cache first, then one call each, four at
 *  a time. */
export async function sportArt(ids: string[]): Promise<Record<string, string | null>> {
  const wanted = [...new Set(ids.map((x) => String(x ?? "").trim()).filter(isSportCard))]
    .slice(0, MAX_ART_IDS);
  const out: Record<string, string | null> = {};
  const queue = [...wanted];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      let p = artInFlight.get(id);
      if (!p) {
        p = resolveArt(id).catch(() => null).finally(() => artInFlight.delete(id));
        artInFlight.set(id, p);
      }
      out[id] = await p;
    }
  };
  await Promise.all(Array.from({ length: ART_CONCURRENCY }, worker));
  return out;
}

/** Who a sports card id is. Decoded, not looked up — the id is the record. */
export function sportCardMeta(id: string): {
  cardId: string; name: string; setName: string; number: null; game: string; imageUrl: string | null;
} | null {
  const read = readSportCard(id);
  if (!read) return null;
  return {
    cardId: id,
    name: read.player,
    setName: read.set,
    number: null,
    game: `sport:${read.sport.slug}`,
    imageUrl: pictures.get(id) ?? null,
  };
}

// ---- search --------------------------------------------------------------------

export type SportHit = {
  cardId: string; name: string; nameLocal: null; setId: string; setName: string;
  localId: string; rarity: null; imageUrl: string | null; game: string; score: number;
};

const searchCache = new TtlCache<SportHit[]>(6 * 3600 * 1000, 1_000, "sport-search");

/** Most sports results a search adds. Enough for a player's main sets; more
 *  would bury a card-game result under one player's back catalogue. */
export const MAX_SPORT_HITS = 10;

/** Players matching a query, each paired with sets they are really in.
 *
 *  A pairing is only offered with EVIDENCE: a listing whose title names both
 *  the player and the set. The query's Set distribution alone is not enough
 *  when two players match — "Jordan" is Michael Jordan and Jordan Love, and
 *  crossing every matching player with every top set would put Jordan Love in
 *  1986 Fleer. That is a card that does not exist, which is the identity
 *  version of a confident wrong price. Only when exactly one player matches
 *  are the distribution's sets his without needing a title to say so. */
export function pairHits(query: string, body: any): SportHit[] {
  const sportDist = distributionOf(body, "Sport")
    .filter((d) => byValue.has(d.localizedAspectValue.toLowerCase()))
    .sort((a, b) => b.matchCount - a.matchCount);
  const sport = sportDist.length ? byValue.get(sportDist[0].localizedAspectValue.toLowerCase())! : null;
  if (!sport) return [];

  let players = playersFromDistribution(distributionOf(body, "Player/Athlete"))
    .map((p) => ({ ...p, score: playerMatch(query, p.name) }))
    .filter((p) => p.score > 0);
  if (!players.length) return [];

  // The sport is read for the whole query, not per player — eBay has no way
  // to say which sport one player's listings are in. When the query spans
  // sports that is a wrong label waiting to happen: "jordan" is basketball
  // overall, and Jordan Walker came back as a BASKETBALL player in 2023 Topps
  // Chrome, a set that exists in both sports and holds him in only one. So
  // when a second sport carries a real share, only the most-listed player is
  // offered — the one the sport was read from.
  const sportTotal = sportDist.reduce((n, d) => n + d.matchCount, 0);
  const mixed = sportDist.length > 1 && sportDist[1].matchCount >= sportTotal * 0.05;
  // Decided BEFORE the cut above: a query that matched several players must
  // not have one of them adopt the whole query's set list.
  const onlyOne = players.length === 1 && !mixed;
  if (mixed) players = players.slice(0, 1);

  const sets = setsFromDistribution(sport.slug, distributionOf(body, "Set"))
    .sort((a, b) => (b.listed ?? 0) - (a.listed ?? 0));
  const items: Item[] = body.itemSummaries ?? [];

  const pairs = new Map<string, { player: string; set: string; evidence: number; image: string | null; score: number }>();
  for (const it of items) {
    const title = String(it.title ?? "");
    for (const p of players) {
      if (!imageForPlayer([it], p.name)) continue;
      for (const s of sets) {
        if (!titleNamesSet(title, s.name)) continue;
        const key = `${p.name}|${s.name}`;
        const had = pairs.get(key);
        if (had) { had.evidence++; continue; }
        pairs.set(key, { player: p.name, set: s.name, evidence: 1, image: imageOf(it), score: p.score });
      }
    }
  }
  if (onlyOne) {
    const p = players[0];
    for (const s of sets.slice(0, MAX_SPORT_HITS)) {
      const key = `${p.name}|${s.name}`;
      if (!pairs.has(key)) pairs.set(key, { player: p.name, set: s.name, evidence: 0, image: null, score: p.score });
    }
  }

  return [...pairs.values()]
    .sort((a, b) => b.score - a.score || b.evidence - a.evidence)
    .slice(0, MAX_SPORT_HITS)
    .map((x) => {
      const cardId = sportCardId(sport.slug, x.set, x.player);
      if (x.image) pictures.set(cardId, x.image);
      return {
        cardId,
        name: x.player,
        nameLocal: null,
        setId: sportSetId(sport.slug, x.set),
        setName: x.set,
        localId: "",
        rarity: null,
        imageUrl: x.image ?? pictures.get(cardId) ?? null,
        game: `sport:${sport.slug}`,
        // Evidence nudges, never outranks, how well the name matched.
        score: Math.min(1, x.score + Math.min(x.evidence, 5) * 0.01),
      };
    });
}

/** Sports results for a typed query. One call, US marketplace — it holds
 *  every sport in volume, and a player search is not the place to spend a
 *  second call on the AU site. Cached six hours, empty answers included. */
export async function sportSearch(query: string): Promise<SportHit[]> {
  const q = (query ?? "").trim();
  if (!looksLikePlayer(q)) return [];
  const key = q.toLowerCase();
  const hit = searchCache.entry(key);
  if (hit) return hit.v;
  if (!catalogueMayCall()) return [];
  const tok = await getToken();
  if (!tok) return [];

  const p = new URLSearchParams({
    q,
    category_ids: CATEGORY_ID,
    limit: "100",
    fieldgroups: "ASPECT_REFINEMENTS,MATCHING_ITEMS",
  });
  const body = await call(p, "EBAY_US", tok);
  if (!body) return [];           // a failed call is not cached as "no such player"
  const hits = pairHits(q, body);
  searchCache.set(key, hits);
  return hits;
}

/** Does a Card Hedge category name a sport? So a bought catalogue, if one is
 *  ever switched on, lands under Sports instead of among the card games. */
export function isSportName(name: string): boolean {
  return /\b(baseball|basketball|football|soccer|hockey|golf|tennis|boxing|racing|nascar|formula|f1|wrestling|wwe|ufc|mma|cricket|rugby|afl|nrl|olympic|sports?|lacrosse|volleyball|motorsport)\b/i
    .test(name ?? "");
}
