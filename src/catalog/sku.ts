// The canonical card identity.
//
// A catalog_id — "base1-4" — names an entry in a catalogue. It does not name a
// PRODUCT. The same Charizard entry covers a 1st Edition, a Shadowless and an
// Unlimited print, in English and in Japanese, holo and reverse holo, and the
// prices do not overlap. Keying anything on catalog_id alone is how a
// Shadowless gets priced off Unlimited sales.
//
// So the SKU is the catalogue entry plus the axes that make it a different
// thing to buy:
//
//   game · set · collector number · language · edition · finish
//
// and a GRADE sits on top of that, never inside it, because a grade is a
// property of (card + grading company) — invariant 1. A PSA 10 of a Shadowless
// and a PSA 10 of an Unlimited are two prices; the grade did not make them one
// card, the SKU did not make them one grade.
//
// Two entities hang off this and are deliberately NOT the same thing:
//
//   GRADE TIER      (sku, grader, grade, qualifier, label) — a price lives
//                   here. There are many cards at PSA 10.
//   GRADE INSTANCE  (grader, cert number) — ONE physical slab. A population
//                   count counts instances; a price describes a tier.
//
// Conflating those is what lets a cert number appear on two listings without
// anything noticing, and it is why `repeat.ts` can treat that as a
// contradiction rather than a coincidence.

/** Language of the printing. Null means nobody has told us, which is NOT the
 *  same as English — see the vision service's `decide_language`, where
 *  defaulting to English priced a Japanese card as the English printing. */
export type Language = "en" | "ja" | "zh" | "ko" | "de" | "fr" | "es" | "it" | "pt";

/** Print run / edition. These are not decoration: a Base Set Charizard is
 *  1st Edition, Shadowless or Unlimited, and the spread between them is the
 *  largest single factor in what it is worth. */
export type Edition = "1st" | "shadowless" | "unlimited" | "promo" | "reprint";

/** Surface treatment. "normal" is a real value, not an absence — a normal and
 *  a reverse holo of the same card are different products. */
export type Finish = "normal" | "holo" | "reverse" | "foil" | "etched" | "textured";

export type Sku = {
  catalogId: string;
  game: string | null;
  setName: string | null;
  number: string | null;
  language: Language | null;
  edition: Edition | null;
  finish: Finish | null;
};

const LANGUAGES = new Set<string>(["en", "ja", "zh", "ko", "de", "fr", "es", "it", "pt"]);
const EDITIONS = new Set<string>(["1st", "shadowless", "unlimited", "promo", "reprint"]);
const FINISHES = new Set<string>(["normal", "holo", "reverse", "foil", "etched", "textured"]);

const one = <T extends string>(v: unknown, allowed: Set<string>, alias: Record<string, string> = {}): T | null => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  const k = alias[s] ?? s;
  return allowed.has(k) ? (k as T) : null;
};

/** Spellings that mean the same axis value. Kept small and explicit: a loose
 *  alias table is how "1st" starts matching "1st place". */
const EDITION_ALIAS: Record<string, string> = {
  "1st edition": "1st", "first edition": "1st", first: "1st", "1e": "1st",
  unlimited: "unlimited", shadowless: "shadowless",
};
// Measured against what is actually in the `printings` table on 14 September,
// not guessed: Cold Foil 811, Normal 371, Holofoil 232, Foil 183, Reverse
// Holofoil 76. "Cold Foil" is Lorcana's name for its foil treatment and is the
// same axis value as Foil; keeping it as a separate finish would split one
// product line across two SKUs for no gain.
const FINISH_ALIAS: Record<string, string> = {
  "reverse holo": "reverse", "reverse holofoil": "reverse", rev: "reverse",
  "holo rare": "holo", holofoil: "holo",
  "cold foil": "foil", "rainbow foil": "foil",
  "non-holo": "normal", nonholo: "normal", plain: "normal",
};
const LANGUAGE_ALIAS: Record<string, string> = {
  english: "en", japanese: "ja", jpn: "ja", jp: "ja", chinese: "zh",
  korean: "ko", german: "de", french: "fr", spanish: "es", italian: "it",
};

export const asLanguage = (v: unknown) => one<Language>(v, LANGUAGES, LANGUAGE_ALIAS);
export const asEdition = (v: unknown) => one<Edition>(v, EDITIONS, EDITION_ALIAS);
export const asFinish = (v: unknown) => one<Finish>(v, FINISHES, FINISH_ALIAS);

/** Build a SKU from whatever a caller has, normalising the three axes and
 *  refusing values it does not recognise rather than storing them. An
 *  unrecognised finish is null — "we were not told" — and never a new axis
 *  value invented at the call site. */
export function toSku(raw: {
  catalogId: string;
  game?: unknown; setName?: unknown; number?: unknown;
  language?: unknown; edition?: unknown; finish?: unknown;
}): Sku {
  const txt = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s === "" ? null : s;
  };
  return {
    catalogId: String(raw.catalogId),
    game: txt(raw.game),
    setName: txt(raw.setName),
    number: txt(raw.number),
    language: asLanguage(raw.language),
    edition: asEdition(raw.edition),
    finish: asFinish(raw.finish),
  };
}

/** A stable string form, for a cache key, a log line or a column.
 *
 *  Unknown axes render as "-" rather than being omitted, so the shape is fixed
 *  and two SKUs can never collide by one of them having fewer parts. And "-"
 *  is distinguishable from a real value, which matters: "we do not know the
 *  language" must not read as "English". */
export function skuKey(s: Sku): string {
  return [s.catalogId, s.language ?? "-", s.edition ?? "-", s.finish ?? "-"].join("|");
}

/** Do two SKUs describe the same product?
 *
 *  An unknown axis does NOT match a known one. This is the strict reading and
 *  it is deliberate: treating null as a wildcard is how an Unlimited card gets
 *  priced off 1st Edition sales, because the seller simply did not say. Where
 *  a caller wants the loose reading it has to ask for it. */
export function sameSku(a: Sku, b: Sku): boolean {
  return skuKey(a) === skuKey(b);
}

/** The loose reading, for a caller that knows it is guessing: unknown on
 *  EITHER side is treated as compatible, but two different known values are
 *  still a conflict. Returns "unknown" where an axis is undecided, so the
 *  caller can lower its confidence rather than pretend. */
export function compareSku(a: Sku, b: Sku): "match" | "conflict" | "unknown" {
  if (a.catalogId !== b.catalogId) return "conflict";
  let undecided = false;
  for (const axis of ["language", "edition", "finish"] as const) {
    const x = a[axis];
    const y = b[axis];
    if (x && y && x !== y) return "conflict";
    if (!x || !y) undecided = true;
  }
  return undecided ? "unknown" : "match";
}

/** How to say a SKU to a person. Null when there is nothing worth saying —
 *  an all-unknown SKU should render as the card's name alone, not as
 *  "Charizard (unknown, unknown, unknown)". */
export function describeSku(s: Sku): string | null {
  const LABEL: Record<string, string> = {
    "1st": "1st Edition", shadowless: "Shadowless", unlimited: "Unlimited",
    promo: "Promo", reprint: "Reprint", holo: "Holo", reverse: "Reverse Holo",
    foil: "Foil", etched: "Etched", textured: "Textured", normal: "Non-Holo",
    ja: "Japanese", zh: "Chinese", ko: "Korean", de: "German", fr: "French",
    es: "Spanish", it: "Italian", pt: "Portuguese",
  };
  const parts = [
    // English is the unmarked case in this market; saying it adds nothing.
    s.language && s.language !== "en" ? LABEL[s.language] : null,
    s.edition ? LABEL[s.edition] : null,
    // "Non-Holo" is only worth saying when something else distinguishes it.
    s.finish && s.finish !== "normal" ? LABEL[s.finish] : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
