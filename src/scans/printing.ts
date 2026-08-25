// Printing / variant identity.
//
// A card number is not a card. OP13-119 is sold on eBay as at least four
// different products whose asking prices do not overlap at all:
//
//   Alternate Art SEC     $82 - $600
//   Parallel             $300 - $395
//   Wanted Poster SP     $400 - $1,200
//   Manga Alt Art SEC    $900 - $8,200
//
// Taking one median across that set answers a question nobody asked. It is the
// same failure as pricing a Shadowless Charizard off Unlimited sales, or a
// reverse holo off the normal print — the catalog match was right and the
// price was still wrong by an order of magnitude.
//
// So printings are matched, not averaged. This module reads a printing out of
// free text (a slab label, a card's OCR, an eBay title) and decides whether two
// such reads describe the same product.

/** Mutually exclusive printing lines. A card belongs to at most one. */
// Word boundaries are deliberately absent on the distinctive names. A grading
// label's condensed font comes back from OCR with the spaces gone, so the
// Beckett label reading "MANGA ART SEC" arrives as "MANGAARTSEC" — and \bmanga\b
// does not match inside it. These words are long and specific enough that
// matching them mid-token costs nothing.
const FAMILIES: [string, RegExp][] = [
  ["manga", /manga/i],
  ["parallel", /parallel/i],
  // "Wanted Poster", "Wanted SP" — one line, written many ways
  ["wanted", /wanted/i],
  ["shadowless", /shadowless/i],
  // Unlimited is a printing, not the absence of one. A 1999 Jungle Unlimited
  // pack and a 1st Edition pack are different products, and leaving Unlimited
  // unmatched let a 179-day-old Unlimited listing set the ceiling for a 1st
  // Edition card.
  ["unlimited", /unlimited/i],
  ["1st", /\b(1st|first)\s*ed(ition)?\b/i],
  ["reverse", /\b(reverse|rev)\s*(holo|foil)\b/i],
  ["staff", /\bstaff\b/i],
  // One Piece's "SP" treatment. Listed LAST on purpose: "Wanted SP" is the
  // wanted-poster line, and must resolve there rather than being swallowed by
  // the more general marker that also appears in its title.
  ["sp", /\bSP\b/],
];

/** Descriptors that CO-OCCUR with a family rather than replacing it.
 *  "Manga Alt Art" is one printing, not two, so alt-art cannot be a family. */
const MODIFIERS: [string, RegExp][] = [
  ["altart", /(alt|alternate|alternative)\s*art/i],
  ["fullart", /full\s*art/i],
  ["error", /\b(error|misprint|err)\b/i],
  ["gold", /\bgold\b/i],
  ["promo", /\bpromo\b/i],
];

/** Sealed product FORM. A 1999 Jungle booster pack and a 1999 Jungle booster
 *  box are both "1st Edition Jungle" and differ by an order of magnitude in
 *  price, so the form is part of the product's identity exactly as the printing
 *  is for a card. Ordered most-specific first: "booster box" must not match as
 *  "pack" simply because the word appears elsewhere in the title. */
const FORMS: [string, RegExp][] = [
  ["box", /(booster\s*box|display\s*box|\bbox\b|elite\s*trainer|\betb\b)/i],
  ["tin", /\btin\b/i],
  ["blister", /blister/i],
  ["pack", /(foil\s*pack|booster\s*pack|\bpack\b)/i],
];

const JA = /\b(jpn|japanese|japan|jp)\b/i;
const EN = /\b(eng|english|en)\b/i;
// Chinese printings are a third market, not a rounding error: the same Stussy
// SP asks $51-68 in Chinese, $100-124 in Japanese and $130-138 in English.
// Without this they averaged together into a figure true of no market at all.
const ZH = /\b(chinese|chs|cht|zh|china)\b/i;

export type Printing = {
  /** the exclusive printing line, where the text declares one */
  family: string | null;
  modifiers: string[];
  language: "ja" | "en" | "zh" | null;
  /** sealed product form, where the text describes sealed product at all */
  form: string | null;
};

export function readPrinting(text: string | null | undefined): Printing {
  const t = text ?? "";
  const family = FAMILIES.find(([, re]) => re.test(t))?.[0] ?? null;
  const modifiers = MODIFIERS.filter(([, re]) => re.test(t)).map(([k]) => k);
  // English is the default assumption everywhere, so only an explicit marker
  // counts; "en" inside another word must not trigger it (the \b guards do).
  const language = ZH.test(t) ? "zh" : JA.test(t) ? "ja" : EN.test(t) ? "en" : null;
  const form = FORMS.find(([, re]) => re.test(t))?.[0] ?? null;
  return { family, modifiers, language, form };
}

export type Verdict = "match" | "conflict" | "unknown";

/** Does `listing` describe the same printing as `card`?
 *
 *  "unknown" is a real and common answer — most sellers do not spell out the
 *  printing — and it is deliberately NOT folded into either other value. A
 *  listing that says nothing is weak evidence, not wrong evidence, and the
 *  caller decides whether it has enough positive matches to ignore it. */
export function comparePrinting(card: Printing, listing: Printing): Verdict {
  if (card.family && listing.family) {
    if (card.family !== listing.family) return "conflict";
  } else if (card.family && !listing.family) {
    return "unknown";
  } else if (!card.family && listing.family) {
    // We could not read a family off our own card. A listing that declares one
    // may still be ours, so this cannot be a conflict.
    return "unknown";
  }

  // Form splits sealed product the way family splits cards: a booster BOX is
  // not a booster PACK, and on a 1999 Jungle 1st Edition search the boxes ask
  // $4,750 against $1,400 for the packs.
  if (card.form && listing.form && card.form !== listing.form) return "conflict";

  // Language is a hard split where both sides state it: a Japanese print and
  // an English print of the same art are different products at different
  // prices, which is exactly the Base Set / Japanese Base Set trap.
  if (card.language && listing.language && card.language !== listing.language) {
    return "conflict";
  }

  if (card.family && listing.family === card.family) return "match";
  if (card.form && listing.form === card.form) return "match";
  return "unknown";
}

/** Human-readable name for a printing, for the interface to show. */
export function describePrinting(p: Printing): string | null {
  const parts: string[] = [];
  if (p.family) {
    parts.push(
      { manga: "Manga Art", parallel: "Parallel", wanted: "Wanted Poster",
        shadowless: "Shadowless", "1st": "1st Edition", unlimited: "Unlimited",
        reverse: "Reverse Holo",
        staff: "Staff", sp: "SP" }[p.family] ?? p.family,
    );
  }
  for (const m of p.modifiers) {
    parts.push(
      { altart: "Alt Art", fullart: "Full Art", error: "Error",
        gold: "Gold", promo: "Promo" }[m] ?? m,
    );
  }
  if (p.language === "ja") parts.push("Japanese");
  if (p.language === "zh") parts.push("Chinese");
  if (p.language === "en" && p.family) parts.push("English");
  if (p.form) parts.push({ box: "Box", tin: "Tin", blister: "Blister", pack: "Pack" }[p.form] ?? p.form);
  return parts.length ? parts.join(" · ") : null;
}
