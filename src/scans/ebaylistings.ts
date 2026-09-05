import { recordUsage } from "./usage.js";
import { comparePrinting, describePrinting, readPrinting, type Printing } from "./printing.js";
import { listingMatchesLabel } from "./labeltokens.js";
import { TtlCache } from "./ttlcache.js";

// Live eBay listings for a card, shown in-product rather than as a link out.
//
// These are ASKS, not sales. That distinction matters and is carried through to
// the response so the interface can say it: a card listed at $30,000 for eight
// months is not a $30,000 card. The sold medians elsewhere in the valuation are
// the authority; this is here so a seller can see what the market is currently
// being offered at, and sanity-check our figure against real inventory.

const EBAY = "https://api.ebay.com";
const TTL_MS = 30 * 60 * 1000; // asks move slowly; half an hour is plenty

export type Listing = {
  title: string;
  price: number | null;
  currency: string;
  condition: string | null;
  imageUrl: string | null;
  url: string;
  seller: string | null;
  /** Seller standing. A price is a claim, and who is making it matters: an
   *  account with six thousand feedbacks at 100% asking $93,500 is a different
   *  signal from a brand-new account asking the same. */
  sellerFeedbackPct: number | null;
  sellerFeedbackCount: number | null;
  /** Best Offer enabled — the seller telling you the number is negotiable,
   *  which is the seller's own statement that it is above their true floor. */
  bestOffer: boolean;
  /** grader + grade parsed out of the title, where present */
  grader: string | null;
  grade: number | null;
  /** Beckett label variant read from the title: black | gold. A Black Label 10
   *  and a gold-label Pristine 10 are different goods at very different money,
   *  and this is the only place we can tell them apart. */
  labelVariant: "black" | "gold" | null;
  /** printing named in the title, e.g. "Manga Art · Alt Art · Japanese" */
  printing: string | null;
  /** days this listing has been up unsold. The single most useful number on a
   *  listing: one that has sat for months is priced above market by proof. */
  ageDays: number | null;
  /** how that printing compares to the card we scanned */
  printingMatch: "match" | "conflict" | "unknown";
};

export type ListingResult = {
  listings: Listing[];
  total: number;
  query: string;
  /** true when we filtered to the card's own grader and grade */
  filteredToGrade: boolean;
  /** true when the asks were narrowed to the slab's own label variant */
  filteredToLabel: boolean;
  /** true when a gradeless slab's asks were narrowed to the same grading
   *  company — slabs compared with slabs, even without a comparable grade */
  filteredToGrader: boolean;
  /** true when the asks were narrowed to the printing the label names */
  filteredToLabelText: boolean;
  /** listings that survived every filter, of which `listings` shows the first few */
  matched: number;
  /** how many extreme listings were trimmed before taking the median */
  trimmed: number;
  /** Cheapest ask that has gone unsold long enough to be evidence. Nobody has
   *  bought the card at this price in months, so the market sits below it. */
  staleCeiling: number | null;
  staleCeilingDays: number | null;
  /** true when the ceiling forced the headline figure down */
  cappedByStale: boolean;
  /** median asking price of what survived filtering — a figure, not just a list.
   *  Median rather than mean: one aspirational listing should not move it. */
  medianAsk: number | null;
  askLow: number | null;
  askHigh: number | null;
  /** the printing these figures are for, where we could pin one down */
  printing: string | null;
  /** true when the listings were narrowed to that printing */
  filteredToPrinting: boolean;
  /** other printings of the same card number we saw and excluded, with the
   *  asking range for each — the card number alone does not identify a product
   *  and the interface should be able to say so */
  otherPrintings: { name: string; count: number; low: number; high: number }[];
};

/** Titles that are not a single copy of the card being priced. A bundle, a
 *  break slot, or a damaged slab all trade at prices that say nothing about
 *  what this card is worth, and they sit at both ends of the range where they
 *  do the most damage to a median. */
export const NOT_ONE_CARD =
  /\b(lot|lots|bundle|bulk|collection|joblot|job lot|break|breaks|random|mystery|repack|custom|proxy|proxies|reprint|orica|digital|read desc|damaged|cracked|scratched|reholder|empty|case only|sleeve|toploader|binder|playset|\d{2,}\s*cards?)\b|\b(art|complete|full|master|sequential)\s+set\b|\bsequential\b|\bset\s+of\s+\d+\b/i;

/** How long an ask must stand before its failure to sell is evidence.
 *  eBay fixed-price listings renew automatically, so two full months is a
 *  listing that has been seen by the whole market and refused by it. */
const STALE_DAYS = 60;

const cache = new TtlCache<ListingResult>(TTL_MS, Number(process.env.LISTINGS_CACHE_MAX ?? 2000));
let token: { value: string; expires: number } | null = null;

async function getToken(): Promise<string | null> {
  const id = process.env.EBAY_APP_ID;
  const secret = process.env.EBAY_CERT_ID;
  if (!id || !secret) return null;
  if (token && Date.now() < token.expires) return token.value;
  try {
    const res = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=client_credentials&scope=" +
        encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!b.access_token) return null;
    // refresh a minute early rather than racing the expiry
    token = { value: b.access_token, expires: Date.now() + (b.expires_in ?? 7200) * 1000 - 60_000 };
    return token.value;
  } catch {
    return null;
  }
}


/** The Latin part of a card name, for searching against English-language
 *  listings.
 *
 *  This used to be all-or-nothing: any non-ASCII character anywhere dropped
 *  the whole name. The rule was written for a real problem — a Japanese
 *  catalogue name matches nothing an English seller ever typed — but it also
 *  threw away "Charizard" because the catalogue writes the card as
 *  "Charizard ☆ δ". The query became "100 BGS 8.5", which is every card
 *  numbered 100 in a BGS 8.5 holder, and a five-figure Gold Star was priced
 *  from a Ken Griffey Jr at $24.99.
 *
 *  Strip the decoration, keep the name. Return "" only when what is left is
 *  too thin to search on, which is the case the original rule was actually
 *  aimed at. */
export function latinName(name: string): string {
  const latin = (name ?? "")
    // Fold accents first: é is an e that a seller typed as "Pokemon", and
    // blanking it turns "Pokémon Trainer" into "Pok mon Trainer", which is a
    // search for nothing. Decompose to base letter + combining mark, then drop
    // the marks. Non-Latin scripts have no base letter and fall through to the
    // ASCII strip below, which is the behaviour we want for them.
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\u0000-\u007F]/g, " ")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // a couple of stray letters left behind by a mostly-Japanese name is not a
  // name; "ex" out of "メガゲンガーex" would search for every ex card there is
  const longest = latin.split(/\s+/).reduce((a, w) => Math.max(a, w.length), 0);
  return longest >= 4 ? latin : "";
}

/** Does this listing plausibly describe the card we are pricing?
 *
 *  The last line of defence on a query gone wrong. A median is computed over
 *  whatever comes back and shipped as a price, so a search that quietly
 *  returns the wrong product is worse than one that returns nothing. If we
 *  have a usable name and the listing never mentions it, it is not this card,
 *  whatever else it matched on. */
export function mentionsCard(title: string, cardName: string): boolean {
  const n = latinName(cardName);
  if (!n) return true; // nothing to check against — do not reject everything
  const t = title.toLowerCase();
  // the longest word carries the identity: "Charizard", not "delta"
  const words = n.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
  if (words.length === 0) return true;
  if (!words.some((w) => t.includes(w))) return false;
  return sameForm(cardName, title);
}

/** The words that make a card a DIFFERENT card rather than a variant of one.
 *
 *  "Meganium" and "Mega Meganium ex" share every letter this file was checking
 *  and are two products a set apart. Asking eBay for the promo Meganium came
 *  back as six Mega Meganium ex, one real Meganium from a different number,
 *  and a median built mostly on the wrong card. */
const FORM_WORDS = ["ex", "gx", "vmax", "vstar", "v", "break", "prime"] as const;

/** The words that follow "EX" when the EX is a SET rather than a card.
 *
 *  Pokemon named every set of the 2003-2007 era "EX Something" — EX Dragon
 *  Frontiers, EX Team Magma vs Team Aqua, EX Holon Phantoms — so "Charizard EX
 *  Dragon Frontiers" is a plain Charizard from a set whose name starts with EX,
 *  while "Charizard ex 125/197" is the ex card. Only `ex` has this collision;
 *  no set was ever called "VMAX Something".
 *
 *  A list rather than a rule because that is what it is: a closed set of names
 *  from a period that ended, and no amount of pattern matching separates them
 *  from a card's own suffix. */
const EX_ERA_SETS = new Set([
  "ruby", "sapphire", "sandstorm", "dragon", "team", "magma", "aqua", "hidden",
  "legends", "firered", "leafgreen", "deoxys", "emerald", "unseen", "forces",
  "delta", "species", "holon", "phantoms", "crystal", "guardians", "legend",
  "maker", "power", "keepers", "frontiers", "trainer", "kit",
]);

/** Does the listing describe the same FORM of the card?
 *
 *  Read off the words TOUCHING the card's name, never off the whole title. A
 *  title routinely carries "EX Dragon Frontiers" as a set, "Gold Star" as a
 *  rarity and "Excellent" as a condition, and a bare scan for the word "ex"
 *  calls all three of them an ex card.
 *
 *  Permissive when the listing names no form at all — plenty of sellers write
 *  "Charizard 4/102 Base Set" and nothing else, and rejecting silence would
 *  empty most pools. It only rejects when the seller HAS said what form it is
 *  and said a different one.
 */
export function sameForm(cardName: string, title: string): boolean {
  const n = latinName(cardName);
  if (!n) return true;
  const idWords = n.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
  if (idWords.length === 0) return true;

  const theirs = formNear(words(title), idWords);
  if (theirs === null) return true;
  return formNear(words(cardName), idWords) === theirs;
}

const words = (text: string): string[] =>
  String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The form marker sitting against the card's name, or null if there is none.
 *
 *  "Mega Meganium ex" is a different card from "Meganium" — a set apart and an
 *  order of magnitude — and the two share every letter this file used to check.
 *  The prefix and the suffix are both part of the answer, so they are read
 *  together: mega, ex, megaex and null are four different cards. */
function formNear(toks: string[], idWords: string[]): string | null {
  const i = toks.findIndex((t) => idWords.some((w) => t === w || t.startsWith(w)));
  if (i < 0) return null;
  const after = toks[i + 1] ?? "";
  const mega = toks[i - 1] === "mega";
  let suffix = (FORM_WORDS as readonly string[]).includes(after) ? after : "";
  // "Charizard EX Dragon Frontiers" names a set, not an ex card.
  if (suffix === "ex" && EX_ERA_SETS.has(toks[i + 2] ?? "")) suffix = "";
  if (!mega && !suffix) return null;
  return `${mega ? "mega" : ""}${suffix}`;
}

/** Pull the grading company and grade out of a listing title.
 *  Sellers write "BGS 8.5", "PSA 10 GEM MINT", "CGC 9.5" — enough to tell a
 *  listing for this exact slab from one for a different grade of the same card. */
function gradeFromTitle(title: string): { grader: string | null; grade: number | null } {
  const m = /\b(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|BVG|BCCG)\s*(\d{1,2}(?:\.5)?)\b/i.exec(title);
  if (!m) return { grader: null, grade: null };
  const grader = m[1].toUpperCase() === "BECKETT" ? "BGS" : m[1].toUpperCase();
  const grade = Number(m[2]);
  return { grader, grade: Number.isFinite(grade) && grade >= 1 && grade <= 10 ? grade : null };
}

/** An autograph, or any card a grader declined to number.
 *
 *  Sellers write this a dozen ways — "PSA AUTH", "PSA AUTHENTIC", "SIGNED",
 *  "AUTO", "AUTOGRAPH" — and almost never write the collector number, because
 *  a signed card is usually a promo or reprint on a different set code than
 *  the one printed on its face. */
const DESIGNATION_RE = /\b(AUTH|AUTHENTIC|SIGNED|AUTO|AUTOGRAPH(?:ED)?)\b/;

export function isDesignationListing(title: string): boolean {
  return DESIGNATION_RE.test(title.toUpperCase());
}

/** Which Beckett label a listing is for: black | gold | null.
 *
 *  Beckett's 10 is two products — a Black Label needs all four subgrades at
 *  exactly 10 — and our sold-comp source publishes a single `bgs10` key that
 *  blends them. So the only place we can see the difference is in what sellers
 *  write, and the gap is worth about ten times the price: a Destined Rivals
 *  Mewtwo blends to $1,364 while Black Label copies sell above $12,700.
 *
 *  "BLACK" is a minefield in Pokemon and almost none of it is Beckett. Black
 *  Star Promos are an entire promo line, Black Bolt is a set, Black & White is
 *  an era, and MBA Black Diamond is somebody else's product entirely — there
 *  is one in the live listings for the card that prompted this. Each of those
 *  is guarded explicitly rather than hoped about, in the same spirit as the
 *  negative guards that stop a grade token meaning a card is graded.
 *
 *  And a black label only exists at 10. A title claiming one at 9.5 is a
 *  seller being loose with words, not a label. */
/** Does this title carry THIS collector number — as the number, not the set size?
 *
 *  The old test stripped punctuation and asked whether the title contained the
 *  digits anywhere. Removing the "/" is what broke it: a Charizard numbered 100
 *  then matched every Charizard in a hundred-card set, because "4/100",
 *  "103/100" and "04/100" all become runs containing "100".
 *
 *  For the Gold Star that admitted eleven unrelated Charizards — Crystal
 *  Guardians 4/100, Stormfront 103/100, Species Delta 04/100 — alongside the
 *  one real listing, and the cheapest of them then set the price. 100 is an
 *  ordinary set size, so the wrong card was always going to be the common case
 *  rather than the unlucky one.
 *
 *  A collector number is written NUMERATOR/DENOMINATOR. The denominator is how
 *  many cards are in the set and identifies nothing, so a digit run that a "/"
 *  immediately precedes is never the card. Everything else — "100/101", "#100",
 *  "No. 100", a bare "100" — still counts. */
/** The words naming the franchise itself, which every card in it shares.
 *
 *  eBay ranks a keyword search by relevance across ALL the words given, so a
 *  term true of a hundred thousand listings does not narrow the search — it
 *  drowns it. A PSA 10 Nami from the Baskin Robbins campaign searched as
 *  "Nami One Piece x Baskin Robbins Campaign Collection Card PSA 10" returned
 *  1,029 results, not one of them a Baskin Robbins card; the same search with
 *  the franchise dropped returned nine, all of them the right card. The card
 *  is worth about $950 and we were quoting $63 off other people's Namis.
 *
 *  Only stripped where the GAME is known to be that franchise, so a Pokemon
 *  set called "Dragon Frontiers" keeps both its words while a Dragon Ball one
 *  loses them. */
const FRANCHISE_WORDS: Record<string, string[]> = {
  onepiece: ["ONE", "PIECE"],
  pokemon: ["POKEMON"],
  yugioh: ["YU", "GI", "OH", "YUGIOH"],
  mtg: ["MAGIC", "GATHERING"],
  digimon: ["DIGIMON"],
  dragonball: ["DRAGON", "BALL"],
  lorcana: ["LORCANA", "DISNEY"],
  unionarena: ["UNION", "ARENA"],
  gundam: ["GUNDAM"],
  starwars: ["STAR", "WARS"],
  riftbound: ["RIFTBOUND"],
};

/** The part of a set name worth searching on.
 *
 *  Never returns empty: if the set is nothing BUT its franchise, the franchise
 *  is all we have and is better than no set at all. */
export function searchableSetName(setName: string, game?: string | null): string {
  const drop = new Set(FRANCHISE_WORDS[String(game ?? "").toLowerCase()] ?? []);
  const kept = setName
    .split(/\s+/)
    .filter((w) => w && !/^[x\u00d7]$/i.test(w)) // the "x" in a crossover title
    .filter((w) => !drop.has(w.toUpperCase().replace(/[^A-Z0-9]/g, "")));
  return kept.length ? kept.join(" ") : setName;
}

/** Does this title name the set the card is actually from?
 *
 *  Whole words, all of them. "EX Dragon" shares its only significant word with
 *  "EX Dragon Frontiers" and is a different set from four years earlier, so a
 *  partial match is exactly the failure this exists to prevent. Short and
 *  structural words carry no information about which set this is and are
 *  dropped rather than required. */
const SET_STOPWORDS = new Set([
  "EX", "GX", "SET", "THE", "AND", "OF", "SERIES", "POKEMON", "TCG", "CARD",
  "EDITION", "ERA", "PROMO",
]);

/** The words of a set that are worth matching on: distinctive, and not the
 *  franchise every card in it shares. */
export function setWords(setName: string, game?: string | null): string[] {
  return searchableSetName(setName, game)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !SET_STOPWORDS.has(w));
}

export function setInTitle(title: string, setName: string): boolean {
  const words = setName
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !SET_STOPWORDS.has(w));
  if (words.length === 0) return false; // nothing distinctive to require
  const U = title.toUpperCase();
  return words.every((w) => new RegExp(`\\b${w}`).test(U));
}

/** Does this title say WHICH card it is?
 *
 *  A collector number, in the form sellers actually write it: "010/132",
 *  "3 / 122", "OP13-119". Deliberately not "any digits" — a title carries a
 *  year, a grade, a "1st Edition" and a condition, and treating those as the
 *  seller having identified the card would make the guard below fire on
 *  listings that never said anything.
 */
export function statesACardNumber(title: string): boolean {
  const U = title.toUpperCase();
  return /\b\d{1,3}\s*\/\s*\d{1,3}\b/.test(U) || /\b[A-Z]{2,4}\d{0,2}-\d{1,3}\b/.test(U);
}

export function numberInTitle(title: string, number: string): boolean {
  const U = title.toUpperCase();

  // A COMPOUND id — OP13-119, EB02-028, BT1-001 — is a set code and a card
  // number joined by a separator, and sellers write that separator three ways:
  // "OP13-119", "OP13 119", "OP13119". This used to strip the punctuation from
  // the target, making "OP13119", and then tokenise the TITLE with a pattern
  // that breaks on a hyphen and can only ever produce "OP13" and "119". No
  // token could equal the target, so the filter matched nothing on every One
  // Piece and Digimon card, declined to apply itself, and priced a $150 secret
  // rare from a $54.99 leader card that happened to share a set.
  //
  // Matching on the parts, with the separator optional, accepts all three
  // spellings and still refuses OP13-002 and EB01-119 — because BOTH halves
  // have to be right. Neither half is an identity on its own: the set code
  // alone is every card in the set, and the tail alone is a different card in
  // any other set.
  const parts = number
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.replace(/^0+(?=\d)/, ""));
  if (parts.length === 0) return false;

  if (parts.length > 1) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Leading zeros are not a different card, so each numeric part accepts
    // them: "119" must also match a title writing "0119".
    const loose = parts.map((p) => (/^\d+$/.test(p) ? `0*${esc(p)}` : esc(p)));
    const re = new RegExp(`(?<![A-Z0-9])${loose.join("[-\\s]?")}(?![A-Z0-9])`);
    return re.test(U);
  }

  const wanted = parts[0];
  const run = /[A-Z]*\d[A-Z0-9]*/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(U)) !== null) {
    if (m[0].replace(/^0+(?=\d)/, "") !== wanted) continue;
    // walk back over spaces: "4 / 100" is as much a denominator as "4/100"
    let i = m.index - 1;
    while (i >= 0 && U[i] === " ") i--;
    if (i >= 0 && U[i] === "/") continue;
    return true;
  }
  return false;
}

export function labelFromTitle(title: string): "black" | "gold" | null {
  const U = title.toUpperCase();

  // not a Beckett label, whatever the word "black" is doing here
  const DECOYS = [
    /\bBLACK\s*STAR\b/,        // Black Star Promos — a promo line
    /\bBLACK\s*BOLT\b/,        // a set
    /\bBLACK\s*(?:&|AND)\s*WHITE\b/, // an era
    /\bBLACK\s*DIAMOND\b/,     // MBA's product, not Beckett's label
  ];
  const decoyed = DECOYS.some((re) => re.test(U));

  const { grader, grade } = gradeFromTitle(title);
  if (grader !== "BGS") return null;

  if (!decoyed && /\bBLACK\s*LABEL\b/.test(U)) {
    // Beckett issues a black label at 10 and nowhere else
    return grade === 10 ? "black" : null;
  }
  if (/\bPRISTINE\b/.test(U) && grade === 10) return "gold";
  return null;
}

export async function fetchListings(opts: {
  name: string;
  setName?: string | null;
  /** which trading-card game, so the franchise can be kept out of the search
   *  terms — see searchableSetName */
  game?: string | null;
  number?: string | null;
  grader?: string | null;
  grade?: number | null;
  /** the slab's Beckett label variant, so asks can be narrowed to it */
  labelVariant?: "black" | "gold" | null;
  /** distinctive words the grading label printed. Used to find listings for
   *  THIS printing when we cannot name the printing — see labeltokens.ts */
  labelTokens?: string[] | null;
  /** internal: stops the label re-search from recursing */
  labelSearchDone?: boolean;
  /** internal: stops the broaden-on-empty retry from recursing */
  broadenDone?: boolean;
  /** The grader's non-numeric designation on this holder — "AUTHENTIC".
   *
   *  It changes what we search for, not just what we filter. A PSA AUTHENTIC
   *  card is normally an autograph, and its value is the signature rather than
   *  the card: a Mayumi Tanaka signed Luffy is listed at $69,000 while ordinary
   *  graded copies of the same card ask $88 to $750. Those listings do not
   *  carry the collector number — the signed one is a PRB01 reprint while the
   *  face reads OP05-119 — so searching on the number cannot find them, and
   *  filtering a number-based search finds nothing to keep. */
  designation?: string | null;
  limit?: number;
  /** everything we know in words about THIS copy — slab label lines, the card's
   *  own OCR, the vision model's printing call. Read for a printing, not
   *  searched on: adding "manga" to the query would hide untitled listings. */
  printingHint?: string | null;
  /** true when the card carries Japanese text */
  japanese?: boolean;
  /** the printing's language, where we could read it off the card. English is
   *  as much a fact as Japanese here: without it a 252-day-old CHINESE listing
   *  at $51 set the ceiling for an English card worth about $130. */
  language?: "en" | "ja" | "zh" | null;
  /** printed identifiers that narrow the search harder than a name does: a set
   *  code ("M2"), a rarity suffix ("SAR"), a treatment ("SP"), a sealed pack's
   *  artwork ("Scyther"). These are what sellers type into their titles. */
  extraTokens?: (string | null | undefined)[];
}): Promise<ListingResult | null> {
  const show = Math.min(opts.limit ?? 12, 24);
  // Fetch wide, show narrow. Printing and grade filtering discard most of what
  // comes back — on OP13-119 only 9 of 100 results are the printing we want —
  // so asking for 12 and filtering leaves nothing to compute a median from.
  const limit = 100;
  // strip glyphs that break eBay's text search the same way they break ours
  const clean = (s: string) => s.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  // The card NUMBER is the single most valuable token in the query. Without it
  // "Portgas.D.Ace Carrying On His Will BGS 9.5" returned a $28 Leader card
  // from the same set; with "OP13-119" the same search returns the actual card
  // at $900-$1,700, which is where its market really is.
  const number = opts.number ? clean(opts.number) : null;
  // A name is one signal among several and not always the best one. On a
  // Japanese card the catalog name is Japanese and the label name comes back
  // from OCR with the spaces gone, while "M2 110/080 SAR" identifies the card
  // exactly and is what every seller writes.
  // A name still carrying an OCR run-on ("MEGA CHARIZARDX eX") searches for a
  // string no seller has ever typed and quietly narrows the pool to the wrong
  // listings. With two or more printed identifiers in hand we are better off
  // without it: "M2 110/080 SAR PSA 10" finds the card exactly.
  const identifiers = (opts.extraTokens ?? []).filter(Boolean).length;
  const gluedRun = /[A-Z]{9,}/.test(opts.name);
  const usableName =
    gluedRun && identifiers >= 2 ? "" : clean(latinName(opts.name));
  const designation = opts.designation ? String(opts.designation).toUpperCase() : null;
  const parts = [usableName];
  // The collector number is normally the most valuable token in the query. For
  // a designation holder it is the one that guarantees a miss.
  if (number && !designation) parts.push(number);
  if (designation) parts.push("PSA AUTH");
  // The set, when the number cannot stand alone.
  //
  // "OP13-119" is a set-qualified address and identifies a card globally. A
  // bare "100" does not — it is every card numbered 100 ever printed. The set
  // used to be added ONLY when there was no number at all, so the Dragon
  // Frontiers Gold Star searched as "Charizard 100 BGS 8.5" and came back with
  // an XY Flashfire Charizard EX, a Crystal Guardians 4/100 and an Italian
  // Dragon holo — every one a different card, spanning $430 to $23,302.
  const numberIsQualified = Boolean(number && /[A-Za-z]/.test(number));
  if (
    (!number || !numberIsQualified) &&
    opts.setName &&
    !/[^\u0000-\u007F]/.test(opts.setName)
  ) {
    parts.push(clean(searchableSetName(opts.setName, opts.game)));
  }
  for (const t of opts.extraTokens ?? []) {
    const c = t ? clean(String(t)) : "";
    // keep the query tight: skip anything already present
    if (c && !parts.some((p) => p.toLowerCase().includes(c.toLowerCase()))) parts.push(c);
  }
  if (opts.grader && opts.grade != null) parts.push(`${opts.grader} ${opts.grade}`);
  const query = parts.filter(Boolean).join(" ").trim();
  if (!query) return null;

  const cardPrinting: Printing = readPrinting(opts.printingHint);
  if (opts.japanese) cardPrinting.language = "ja";
  else if (opts.language && !cardPrinting.language) cardPrinting.language = opts.language;
  const key = `${query}|${show}|${cardPrinting.family ?? ""}|${cardPrinting.language ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tok = await getToken();
  if (!tok) return null;

  try {
    recordUsage("ebay");
    const url =
      `${EBAY}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}` +
      // EXTENDED carries itemCreationDate, which is how long the ask has stood
      `&limit=${limit}&fieldgroups=EXTENDED`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[ebay] listings ${res.status} for "${query}"`);
      return null;
    }
    const body = (await res.json()) as any;
    const items: any[] = body.itemSummaries ?? [];

    const listings: Listing[] = items.map((it) => {
      const rawTitle = String(it.title ?? "");
      const { grader, grade } = gradeFromTitle(rawTitle);
      const labelVariant = labelFromTitle(rawTitle);
      const p = readPrinting(rawTitle);
      return {
        title: rawTitle.slice(0, 140),
        price: it.price?.value != null ? Number(it.price.value) : null,
        currency: String(it.price?.currency ?? "USD"),
        condition: it.condition ?? null,
        imageUrl: it.thumbnailImages?.[0]?.imageUrl ?? it.image?.imageUrl ?? null,
        url: String(it.itemWebUrl ?? ""),
        seller: it.seller?.username ?? null,
        sellerFeedbackPct:
          it.seller?.feedbackPercentage != null ? Number(it.seller.feedbackPercentage) : null,
        sellerFeedbackCount:
          it.seller?.feedbackScore != null ? Number(it.seller.feedbackScore) : null,
        bestOffer: Array.isArray(it.buyingOptions)
          ? it.buyingOptions.includes("BEST_OFFER")
          : false,
        grader,
        grade,
        labelVariant,
        printing: describePrinting(p),
        printingMatch: comparePrinting(cardPrinting, p),
        ageDays: it.itemCreationDate
          ? Math.max(0, Math.round((Date.now() - Date.parse(it.itemCreationDate)) / 86_400_000))
          : null,
      };
    });

    // Drop what is not a single copy of this card before anything else. On the
    // Charizard these were a $165 "read description" listing and an $11,250
    // bundle, sitting at opposite ends and both pulling the middle.
    let filtered = listings.filter((l) => !NOT_ONE_CARD.test(l.title));
    if (filtered.length < 3) filtered = listings;

    // Drop listings whose title carries a DIFFERENT card number. Sellers put the
    // number in the title, so this is a cheap and reliable way to reject the
    // wrong card from the right set — which is most of the noise.
    if (number) {
      const sameCard = listings.filter((l) => numberInTitle(l.title, number));
      if (sameCard.length >= 2) filtered = sameCard;
      else if (sameCard.length === 0) {
        // EVERY listing that says which card it is says a DIFFERENT one.
        //
        // The filter above declines when it finds nothing, on the reasoning
        // that plenty of sellers never write the number and a filter that
        // empties the pool has told us nothing. That reasoning is right when
        // the pool is silent and wrong when the pool is unanimous against us:
        // asking eBay for card 001 of MEP Black Star Promos came back as
        // twelve Meganiums that all name their number, and every one of them
        // was 010/132 from the main Mega Evolution set, 3/122 from BREAKpoint
        // or a Mega Meganium ex 010/217 from Ascended Heroes. The set filter
        // then declined too — none of them says "MEP" either — so a set whose
        // cards we cannot price was priced off three other sets.
        //
        // The distinction is whether the listings identified themselves. When
        // most of them did and not one is ours, this is the wrong pool, not a
        // thin one, and no median over it describes this card.
        const named = filtered.filter((l) => statesACardNumber(l.title));
        if (named.length >= 2 && named.length >= filtered.length * 0.6) {
          console.warn(
            `[listings] every numbered result names a different card than ${number} — ` +
              `refusing to price "${opts.name}" from ${filtered.length} of them`,
          );
          filtered = [];
        }
      }
    }

    // A collector number is only unique WITHIN a set. Card 100 exists in XY
    // Flashfire, in EX Dragon and in EX Dragon Frontiers, and those are three
    // different Charizards at $430, $1,400 and $17,377. Fixing the number
    // boundaries removed the cards that merely came from hundred-card sets;
    // these are cards genuinely numbered 100, and only the set tells them
    // apart.
    //
    // Every significant word of the set has to be there, which is what
    // separates "EX Dragon" from "EX Dragon Frontiers" — a shared first word
    // and an entirely different set. Applied only when at least two listings
    // carry the set, because plenty of sellers never name it and a filter that
    // empties the pool has told us nothing.
    if (opts.setName) {
      // Best overlap wins, rather than demanding every word.
      //
      // Requiring all of them works for a two-word set like "Dragon
      // Frontiers" and fails for an official product name: sellers of the
      // Baskin Robbins Nami write "One Piece Baskin Robbins ... Campaign
      // Card" and never write "Collection", so the strict test matched none
      // of them, declined to apply itself, and left the twelve wrong Namis in
      // place. Keeping the listings that carry the MOST of the set's words is
      // the same judgement without the cliff — it still separates "EX Dragon"
      // from "EX Dragon Frontiers", and it cannot empty the pool.
      const words = setWords(opts.setName, opts.game);
      if (words.length) {
        const scored = filtered.map((l) => {
          const U = l.title.toUpperCase();
          return { l, n: words.filter((w) => new RegExp(`\\b${w}`).test(U)).length };
        });
        const best = Math.max(0, ...scored.map((x) => x.n));
        const top = scored.filter((x) => x.n === best).map((x) => x.l);
        if (best > 0 && top.length >= 2) filtered = top;
      }
    }

    // Reject anything that is not this card at all.
    //
    // Before any median is taken, because a median over the wrong product is
    // still a number and still gets shipped. This is what stands between a
    // broken query and a five-figure Pokemon card priced from a $24 baseball
    // card that happened to share "#100" and "BGS 8.5".
    const relevant = filtered.filter((l) => mentionsCard(l.title, opts.name));
    // No sample-size gate on this one, unlike every other filter here. The
    // others narrow to a better subset and decline when the subset is too
    // small to be a median; this one REJECTS listings that are demonstrably a
    // different card, and a different card is not a comparable at any sample
    // size. Requiring two survivors meant that when exactly one genuine
    // listing came back the filter declined and priced from the rest: the
    // promo Meganium had one real ask at $0.94 among six Mega Meganium ex, and
    // keeping all seven is not a better answer than keeping the one.
    if (relevant.length > 0 && relevant.length < filtered.length) {
      console.log(
        `[listings] dropped ${filtered.length - relevant.length} listing(s) that are not "${opts.name}"`,
      );
      filtered = relevant;
    } else if (relevant.length > 0) {
      filtered = relevant;
    } else if (filtered.length >= 2 && relevant.length === 0 && latinName(opts.name)) {
      // NOTHING returned mentions the card. That is not a thin market, it is
      // the wrong search, and pricing from it would be inventing a figure.
      console.warn(
        `[listings] no listing mentions "${opts.name}" — refusing to price from ${filtered.length} unrelated results`,
      );
      filtered = [];
    }

    // When we know the card's grade, surface listings for THAT grade —
    // a PSA 10 asking price tells the owner of a PSA 5 very little.
    let filteredToGrade = false;
    let filteredToGrader = false;
    let filteredToLabel = false;

    // A graded card is never averaged against ungraded copies.
    //
    // The exact-grade filter only applied when it found two or more matches,
    // and fell back to EVERYTHING otherwise — raw singles included. So a slab
    // whose grade had too few listings got a median computed over loose cards,
    // which is the "slab quoted at its raw price" error arriving through the
    // asks instead of the catalogue.
    //
    // The cascade below narrows as far as the data allows and stops at graded.
    // It never returns to the full set, because a raw copy is not a comparable
    // for a card in a holder at any sample size.
    if (opts.grader) {
      const isGraded = (l: Listing) =>
        l.grader != null || /\b(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|GRADED|SLAB)\b/i.test(l.title);

      const exact =
        opts.grade != null
          ? filtered.filter((l) => l.grader === opts.grader && l.grade === opts.grade)
          : [];
      const sameGrader = filtered.filter((l) => l.grader === opts.grader);
      const anyGraded = filtered.filter(isGraded);

      if (exact.length >= 2) {
        filtered = exact;
        filteredToGrade = true;
        filteredToGrader = true;
      } else if (sameGrader.length >= 2) {
        filtered = sameGrader;
        filteredToGrader = true;
      } else if (anyGraded.length >= 2) {
        filtered = anyGraded;
      } else {
        // Nothing graded to compare against. Say so rather than quietly
        // pricing a slab from loose cards.
        console.warn(
          `[listings] no graded listings for ${opts.grader}${opts.grade != null ? " " + opts.grade : ""} ` +
            `— refusing to average ${filtered.length} ungraded copies against a slab`,
        );
        filtered = [];
      }
    } else {
      // ...and the same rule in the other direction, which was missing.
      //
      // "A graded card is never averaged against ungraded copies" was only
      // enforced when we KNEW the card was graded. Pricing a raw card left the
      // slabs in: Alakazam MEP009 came back as raw copies at $12-$25 alongside
      // two PSA 9s at $116 and $232, and the median was taken over all of them.
      // A slab is a different product with a different market, and one in a
      // twelve-listing pool moves the middle of it.
      //
      // No sample-size gate, for the same reason the graded branch above has
      // none at the bottom: a slab is a different product, not a noisy reading
      // of this one. MEP 001 Meganium came back as one loose copy at $71.97
      // and three slabs at $116, $120 and $630 — a threshold of three loose
      // listings left all four in and reported a range of $72 to $630 for a
      // raw card. One true reading beats four mixed ones.
      const looseOnly = filtered.filter(
        (l) => l.grader == null && !/\b(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|GRADED|SLAB)\b/i.test(l.title),
      );
      if (looseOnly.length > 0 && looseOnly.length < filtered.length) {
        console.log(
          `[listings] dropped ${filtered.length - looseOnly.length} graded listing(s) ` +
            `from a raw median for "${opts.name}"`,
        );
        filtered = looseOnly;
      } else if (looseOnly.length === 0 && filtered.length > 0) {
        // Every copy on sale is in a holder. That is a fact about the market
        // and not a price for a loose card, so it is reported as no answer
        // rather than as the slab price with the word "raw" over it.
        console.warn(
          `[listings] every listing for "${opts.name}" is graded — refusing to quote a raw card from slabs`,
        );
        filtered = [];
      }
    }

    // A refinement that destroys what it was refining is not a refinement.
    //
    // extraTokens exist to sharpen a search — a set code, a rarity, a
    // treatment marker. On a card where those words are not what sellers wrote,
    // they cut the result set below the two listings the grade filter needs,
    // filteredToGrade comes back false, and the caller discards the asks
    // entirely. The Dragon Frontiers Gold Star searched cleanly as
    // "Charizard 100 Dragon Frontiers BGS 8.5" and returned three genuine BGS
    // 8.5 listings; with its extra tokens attached it returned two, neither
    // usable, and the scan showed no asking market at all — leaving a sold
    // figure we had already established was contradicting its own grade ladder.
    //
    // So when a refined search cannot support a grade-filtered answer, drop
    // the refinement and ask again. The broad query is the honest fallback:
    // it is what we would have asked with no extra information.
    if (
      !opts.broadenDone &&
      (opts.extraTokens?.length ?? 0) > 0 &&
      opts.grader &&
      opts.grade != null &&
      filtered.filter((l) => l.grader === opts.grader && l.grade === opts.grade).length < 2
    ) {
      const broad = await fetchListings({ ...opts, extraTokens: [], broadenDone: true });
      if (broad && broad.filteredToGrade) {
        console.log(
          `[listings] "${query}" could not support a ${opts.grader} ${opts.grade} median; ` +
            `retried without the extra tokens and matched ${broad.matched}`,
        );
        return broad;
      }
    }

    // Narrow to the printing the LABEL names, whether or not we can name it.
    //
    // This runs before the variant and printing filters because it is the
    // most authoritative signal available: a grading company examined the card
    // and wrote down what it is. A PSA MAGAZINE EXCLUSIVE Luffy and the
    // OP05-060 Leader share a collector number and nothing else — $615 against
    // $0.65 raw — and no allowlist of printing names was ever going to keep up
    // with the promo lines that produce that gap.
    let filteredToLabelText = false;
    if (opts.labelTokens && opts.labelTokens.length) {
      const sameProduct = filtered.filter((l) =>
        listingMatchesLabel(l.title, opts.labelTokens!),
      );
      // two or more, or we are narrowing on one listing rather than on evidence
      if (sameProduct.length >= 2) {
        filtered = sameProduct;
        filteredToLabelText = true;
      } else if (!opts.labelSearchDone) {
        // Nothing in these results is the printing on the label — and no
        // amount of filtering rescues a search that never fetched it. The
        // query was built from the card we IDENTIFIED, and if that
        // identification landed on the base card sharing the number, the
        // promo's listings are not in this result set at all.
        //
        // So ask again WITHOUT the collector number.
        //
        // Not by adding the label's words to the query: OCR returns them glued
        // ("OFFLINEREGIONALFINALISTV2") and no seller ever typed that, so as a
        // search term it finds nothing. The number is what has to go — a prize
        // promo reprints a card's number but is listed under the promo's name,
        // so a number-anchored query returns the base card and only the base
        // card. Drop it, keep the card name and the grade, and let the label
        // token do the filtering afterwards, where a glued run works fine
        // because titles are compared with their spaces removed too.
        // The SET has to go too, and for the same reason as the number.
        //
        // A prize promo is catalogued under the set it reprints — this
        // Crocodile is Paramount War #OP02-053 — but it is listed under the
        // promo's own name. "Paramount War" appears in no Finalist title, so
        // keeping it excludes every one of them. Name and grade are the only
        // two things a promo listing reliably shares with its catalogue entry;
        // the label token does the rest of the work afterwards.
        const narrowed = await fetchListings({
          ...opts,
          number: null,
          setName: null,
          labelSearchDone: true,
        });
        // ...and keep it ONLY if dropping the number actually found the
        // labelled product.
        //
        // The number is the strongest signal there is, so giving it up has to
        // buy something. It was given up whenever the re-search returned two
        // of anything, which on a BGS 9.5 Portgas.D.Ace meant trading seven
        // listings that all said OP13-119 for twelve that said nothing at all
        // — every Ace at that grade, priced as one card. US$200 became US$21.
        //
        // The label token here was "MANGAARTSEC": OCR glues "MANGA ART SEC"
        // and no seller types it that way, so it matches nothing whether the
        // number is in the query or not. A token that cannot match is not
        // evidence the identification was wrong; it is evidence the token is
        // unusable. The prize-promo case this exists for is different — there
        // the re-search genuinely surfaces the promo, and filteredToLabelText
        // comes back true.
        if (narrowed && narrowed.matched >= 2 && narrowed.filteredToLabelText) {
          console.log(
            `[listings] broad search found no "${opts.labelTokens[0]}" listings; ` +
              `re-searched with the label's own words and found ${narrowed.matched}`,
          );
          return narrowed;
        }
        if (narrowed && narrowed.matched >= 2) {
          console.log(
            `[listings] dropping the number found ${narrowed.matched} listings but none ` +
              `carrying "${opts.labelTokens[0]}" either — keeping the numbered pool`,
          );
        }
      }
    }

    // Keep only listings that carry the same designation. Without this the
    // query's own words pull in ordinary graded copies, and an autograph gets
    // averaged with the base card.
    if (designation) {
      const signed = filtered.filter((l) => isDesignationListing(l.title));
      if (signed.length >= 2) {
        filtered = signed;
        filteredToLabelText = true;
      } else if (!opts.broadenDone && number) {
        // Nothing carrying this card's number is a designation listing.
        //
        // A signed card is usually a promo or reprint on a DIFFERENT set code
        // than the face it was printed from, so its listings do not carry the
        // face number and the filter above removed them all. Ask again without
        // the number — precision first, breadth only when precision found
        // nothing, so an ordinary card keeps its tight comp set.
        const wider = await fetchListings({ ...opts, number: null, broadenDone: true });
        if (wider && wider.matched >= 2) {
          console.log(
            `[listings] no ${designation} listing carries ${number}; widened to the ` +
              `designation alone and matched ${wider.matched}`,
          );
          return wider;
        }
      }
    }

    // A slab whose grade is not a number still must not be priced from raw
    // copies. PSA "AUTHENTIC" has no numeric grade, so the grade filter above
    // cannot run — and without SOME filter the median lands on ungraded cards
    // and proxy fan art: $5.99 for a holder whose graded copies ask $85 and up.
    // Narrowing to the same grading company is the weakest honest filter, and
    // it is still the difference between comparing slabs and comparing paper.
    // Skipped when a designation already narrowed the set. The grader is
    // parsed out of a title by finding the company name followed by a NUMBER,
    // and a designation holder has no number — "PSA AUTH" parses to no grader
    // at all. Running this after the designation filter therefore discards
    // exactly the listings we just went looking for, the $69,000 signed Luffy
    // among them.
    // Narrow again to the LABEL VARIANT where we know it.
    //
    // "BGS 10" is not one price. A Black Label — all four subgrades exactly 10
    // — and a gold-label Pristine share that string, and on the card that
    // prompted this the gap is roughly ten times: blended sold comps put BGS 10
    // near $1,364 while Black Label copies ask and sell above $12,700. Leaving
    // them mixed produces a median that describes neither.
    //
    // Same bar as the grade filter: at least two, or we are not narrowing on
    // evidence, we are narrowing on one listing.
    if (opts.labelVariant) {
      const sameLabel = filtered.filter((l) => l.labelVariant === opts.labelVariant);
      if (sameLabel.length >= 2) {
        filtered = sameLabel;
        filteredToLabel = true;
      }
    }
    // Narrow to OUR printing. This is the difference between pricing a card and
    // pricing a card number: the four printings of OP13-119 that share a number
    // ask $82 and $8,200 for the same three digits.
    //
    // Only listings that positively declare our printing are kept, and only
    // when enough of them exist to stand on their own. Silent listings are not
    // evidence against us, but they are not evidence for us either, and a
    // median built mostly on silence is the mixed figure we set out to remove.
    let filteredToPrinting = false;
    const otherPrintings: ListingResult["otherPrintings"] = [];
    if (cardPrinting.family || cardPrinting.language) {
      const matched = filtered.filter((l) => l.printingMatch === "match");
      const conflicting = filtered.filter((l) => l.printingMatch === "conflict");
      if (matched.length >= 3) {
        // report what we set aside, so the interface can name the alternatives
        const byName = new Map<string, number[]>();
        for (const l of conflicting) {
          if (l.price == null) continue;
          const n = l.printing ?? "other printing";
          byName.set(n, [...(byName.get(n) ?? []), l.price]);
        }
        for (const [name, ps] of byName) {
          ps.sort((a, b) => a - b);
          otherPrintings.push({ name, count: ps.length, low: ps[0], high: ps[ps.length - 1] });
        }
        otherPrintings.sort((a, b) => b.count - a.count);
        filtered = matched;
        filteredToPrinting = true;
      }
    }

    filtered.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

    // One listing relisted three times is one data point, not three. The 1999
    // Jungle pack search returned the same $4,750 multi-pack set three times
    // over, which on six results moved the median from $1,400 to $3,125.
    const seenListing = new Set<string>();
    const deduped = filtered.filter((l) => {
      const k = `${l.title.toLowerCase().replace(/\s+/g, " ").trim()}|${l.price ?? ""}`;
      if (seenListing.has(k)) return false;
      seenListing.add(k);
      return true;
    });

    const priced = deduped.filter((l) => l.price != null && l.url);
    const all = priced.map((l) => l.price as number).sort((a, b) => a - b);

    // Trim the extremes before taking the middle. Marketplace asks have a long
    // right tail — a seller who lists at ten times market loses nothing by
    // leaving it up — and a thin left tail of bait and misdescribed listings.
    // Neither end carries information about what the card trades at, so with
    // enough samples to afford it we cut a tenth off each end first.
    const cut = all.length >= 8 ? Math.floor(all.length * 0.1) : 0;
    const values = cut > 0 ? all.slice(cut, all.length - cut) : all;
    const rawMedian =
      values.length === 0
        ? null
        : values.length % 2
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;

    // What a listing FAILS to do is information too.
    //
    // The pool of live asks is survivorship-biased upward: a copy priced at
    // market sells and leaves, while one priced above market stays, renews, and
    // accumulates. Read naively the pool therefore drifts above the real price
    // — on a One Piece Ace the median ask was a listing that had sat unsold for
    // 199 days, quoted as the card's value against a A$1,000 sale.
    //
    // But an ask that has stood for two months without a buyer is proof the
    // market is below it. The cheapest such ask is the tightest upper bound the
    // live pool can give us, and it is a fact about this card rather than a
    // discount applied to one.
    const stale = priced
      .filter((l) => (l.ageDays ?? 0) >= STALE_DAYS && l.price != null)
      .sort((a, b) => (a.price as number) - (b.price as number));
    // ...but only where it is a bound on THIS market rather than a listing for
    // something else. The cheapest stale ask sat at $430 on the Gold Star while
    // the body of the pool ran to $30,000, and it was an XY Flashfire that the
    // number filter had wrongly admitted. Capping to it reported a median of
    // $430 beneath a range starting at $600 — a middle below its own low, which
    // is not a claim about a market so much as a contradiction.
    //
    // A genuine unsold ask sits ABOVE the market it is failing to clear, so it
    // lands inside the distribution, not underneath all of it. One that falls
    // below the whole body is evidence about the listing, not about the card.
    const low = values[0] ?? null;
    const ceilingListing =
      stale.find((l) => low == null || (l.price as number) >= low) ?? null;
    const staleCeiling = ceilingListing?.price ?? null;
    const cappedByStale = rawMedian != null && staleCeiling != null && staleCeiling < rawMedian;
    const median = cappedByStale ? staleCeiling : rawMedian;

    const v: ListingResult = {
      listings: priced.slice(0, show),
      total: Number(body.total ?? priced.length),
      matched: priced.length,
      query,
      filteredToGrade,
      filteredToGrader,
      filteredToLabel,
      filteredToLabelText,
      medianAsk: median,
      askLow: low,
      askHigh: values[values.length - 1] ?? null,
      trimmed: cut > 0 ? cut * 2 : 0,
      staleCeiling,
      staleCeilingDays: ceilingListing?.ageDays ?? null,
      cappedByStale,
      printing: describePrinting(cardPrinting),
      filteredToPrinting,
      otherPrintings,
    };
    cache.set(key, v);
    return v;
  } catch (err) {
    console.warn(`[ebay] listings failed for "${query}": ${(err as Error).message}`);
    return null;
  }
}
