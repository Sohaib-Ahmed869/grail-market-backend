import { similarity } from "./similarity.js";

// Proof of WHICH PRINTING a scan is, and the rule that nothing unproven is priced.
//
// Every catalogue we identify against answers a NAME with a card, and a name
// is not a printing. Measured on 2026-09-15 against the live APIs:
//
//   Blue-Eyes White Dragon  78 printings on ygoprodeck. The card-level price is
//                           US$0.13 (the cheapest reprint); LOB-001 is US$62.15
//                           and LOB-E001 US$681.49. The scan took the first set
//                           in the list (a 2016 tin) and quoted US$0.13 at a
//                           match score of 1.0.
//   Orcish Bowmasters       6 printings on Scryfall, US$48 to US$193. Search
//                           with unique=cards returns one default print.
//   Charizard               dozens on TCGdex. With no number read and no
//                           picture check, Base Set came back as the 2024
//                           McDonald's promo and was priced.
//
// So a match carries `printingConfirmed`. It is true only when something on the
// card itself settles the printing: a set code or collector number read off the
// face, a picture comparison that wins clearly, or a name that has exactly one
// printing. Otherwise the scan still names the card, but it asserts no set,
// no number and no price. A missing answer is cheap; somebody else's price is
// not. See CLAUDE.md.

export type ProofIdentity = {
  cardId?: string | null;
  printingConfirmed?: boolean | null;
};

/** May a price be attached to this identity?
 *
 *  An AI-named or text-described card has no catalogue row to price. A
 *  catalogue row whose printing we did not confirm is one printing chosen from
 *  many, and pricing it prices a different card. Only an explicit `false`
 *  blocks: the exact-code paths (slab label, set code) predate the flag and
 *  are confirmed by construction. */
export function isPriceable(ident: ProofIdentity | null | undefined): boolean {
  if (!ident?.cardId) return false;
  if (ident.cardId === "llm" || ident.cardId === "described") return false;
  return ident.printingConfirmed !== false;
}

// ---- Yu-Gi-Oh -------------------------------------------------------------------

/** Set codes printed under the artwork: LOB-001, LOB-E001, LOB-EN001, CT13-EN008.
 *
 *  Every code that could be one is returned, because OCR reads a card's other
 *  text too and one wrong guess must not hide the right one. The printings list
 *  decides which is real, so a false candidate costs nothing. */
export function readYgoSetCodes(texts: readonly string[]): string[] {
  const out: string[] = [];
  const re = /(?<![A-Z0-9])([A-Z0-9]{2,4})\s*[-–]\s*([A-Z]{1,2})?\s*(\d{3})(?!\d)/gi;
  for (const raw of texts) {
    // OCR reads a zero as the letter O inside a code often enough to matter
    const text = String(raw ?? "").toUpperCase();
    for (const m of text.matchAll(re)) {
      const prefix = m[1]!.toUpperCase();
      const region = (m[2] ?? "").toUpperCase();
      const code = `${prefix}-${region}${m[3]}`;
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

export type YgoSet = { set_code: string; set_name: string; set_rarity?: string; set_price?: string | number };

/** The printing whose set code was read off the card, or null.
 *
 *  Exact codes only. LOB-001 (the North American first print), LOB-E001 and
 *  LOB-EN001 are three printings at three prices — US$62, US$681 and a reprint
 *  — so a region letter that differs is a different card, not a near match. */
export function ygoPrintingFor<T extends YgoSet>(sets: readonly T[] | null | undefined, codes: readonly string[]): T | null {
  if (!sets?.length || !codes.length) return null;
  const want = new Set(codes.map((c) => c.toUpperCase().replace(/\s+/g, "")));
  const hits = sets.filter((s) => want.has(String(s.set_code).toUpperCase()));
  // The same code listed twice at two rarities (an Ultra and an Ultimate
  // Rare share LOB-001 in some reprints) is still not one printing.
  return hits.length === 1 ? hits[0]! : null;
}

/** A printing's own price, or null. ygoprodeck reports "0" for printings it
 *  holds no price for; zero is "unknown", never "free". */
export function ygoSetPrice(set: YgoSet | null): number | null {
  const n = set ? Number(set.set_price) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- Magic: The Gathering -------------------------------------------------------

/** Set code and collector number from the bottom-left of a Magic card.
 *
 *  Modern frames print "R 0103" over "LTR • EN"; older frames "103/281 R" over
 *  "LTR • EN". Numbers alone are everywhere on a card (power/toughness, mana
 *  value), so candidates are only returned alongside a set code, and the
 *  caller still has to find a real card at that set and number whose name
 *  matches before anything counts as confirmed. */
export function readMtgPrinting(texts: readonly string[]): { sets: string[]; numbers: string[] } {
  const sets: string[] = [];
  const numbers: string[] = [];
  const LANG = "(?:EN|DE|FR|IT|ES|SP|PT|JA|JP|KO|RU|ZHS|ZHT|PH)";
  const setRe = new RegExp(`(?<![A-Z0-9])([A-Z0-9]{3,5})\\s*[•·*.]\\s*${LANG}(?![A-Z])`, "g");
  const withTotal = /(?<!\d)0*(\d{1,4}[a-z]?)\s*\/\s*\d{2,4}(?!\d)/gi;
  const withRarity = /(?:(?<![A-Z])[CURMSLTP]\s+0*(\d{1,4})(?!\d))|(?:(?<!\d)0*(\d{1,4})\s+[CURMSLTP](?![A-Z]))/g;
  for (const raw of texts) {
    const text = String(raw ?? "");
    const upper = text.toUpperCase();
    for (const m of upper.matchAll(setRe)) {
      const code = m[1]!;
      if (/^\d+$/.test(code)) continue; // "2023 • EN" is a year, not a set
      if (!sets.includes(code)) sets.push(code);
    }
    for (const m of text.matchAll(withTotal)) if (!numbers.includes(m[1]!)) numbers.push(m[1]!);
    for (const m of upper.matchAll(withRarity)) {
      const n = m[1] ?? m[2];
      if (n && !numbers.includes(n)) numbers.push(n);
    }
  }
  return { sets: sets.slice(0, 3), numbers: numbers.slice(0, 4) };
}

// ---- Lorcana --------------------------------------------------------------------

/** "103/204 • EN • 5": collector number, total, language, set number. */
export function readLorcanaPrinting(texts: readonly string[]): { number: string; setCode: string } | null {
  const re = /(?<!\d)(\d{1,3})\s*\/\s*\d{2,3}\s*[•·.]\s*[A-Z]{2}\s*[•·.]\s*(\d{1,2})(?!\d)/i;
  for (const raw of texts) {
    const m = String(raw ?? "").match(re);
    if (m) return { number: String(Number(m[1])), setCode: String(Number(m[2])) };
  }
  return null;
}

// ---- names ----------------------------------------------------------------------

const NOT_A_NAME_WORD = new Set([
  "the", "of", "and", "ex", "gx", "v", "vmax", "vstar", "jr", "sr", "ii", "iii", "iv", "de", "la", "le", "van", "von",
]);

/** Is this name actually printed on the card we read?
 *
 *  The AI can name a card from its picture alone, and for a sports card with
 *  no catalogue behind it that name is never checked against anything. It
 *  named a Stephen Curry "Trayce Jackson-Davis" while the text on the card
 *  read "SELECT". The surname is the part a card always prints, so that is
 *  what has to be found — fuzzily, because OCR reads "Charirard". */
export function nameOnCard(name: string, texts: readonly string[]): boolean {
  const words = String(name ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NOT_A_NAME_WORD.has(w));
  if (!words.length) return false;
  const surname = words[words.length - 1]!;
  const tokens = texts
    .flatMap((t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/))
    .filter((t) => t.length >= 3);
  const squashed = texts.map((t) => String(t ?? "").toLowerCase().replace(/[^a-z]/g, "")).join(" ");
  if (surname.length >= 5 && squashed.includes(surname)) return true;
  // Letters OCR got wrong, not a similarity score: "Charirard" is one letter
  // off "Charizard" but scores 0.75 on bigrams, while "Demir" and "Messi" are
  // nothing alike. One slip allowed from five letters, two from eight.
  const allowed = surname.length >= 8 ? 2 : surname.length >= 5 ? 1 : 0;
  return tokens.some((t) => t === surname || (allowed > 0 && editDistance(t, surname) <= allowed));
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

// ---- Pokemon ----------------------------------------------------------------------

/** Does the collector number read off the card name THIS card?
 *
 *  "4/102" is card 4 of a 102-card set, and the "/102" is half the proof. The
 *  number alone put a Base Set Charizard (4/102) into Crystal Guardians as
 *  Charizard δ (4/100). So when a total was read it must equal the set's
 *  printed count. Secret rares print above it (173/165) and still carry the
 *  set's own count, so it is the OFFICIAL count that is compared.
 *
 *  `setCounts` maps a set id to the counts it could print; null means the set
 *  list could not be fetched, and then the number is judged on its own as it
 *  always was. A set missing from a list we DID fetch is not a match. */
export function pokemonNumberMatches(
  card: { id: string; localId: string | number },
  collectorNumber: string | null | undefined,
  setCounts: ReadonlyMap<string, readonly number[]> | null,
): boolean {
  if (!collectorNumber) return false;
  const [num, total] = String(collectorNumber).split("/");
  if (String(Number(card.localId)) !== String(Number(num))) return false;
  if (total == null || !setCounts) return true;
  const setId = card.id.slice(0, card.id.lastIndexOf("-"));
  const counts = setCounts.get(setId);
  return Boolean(counts?.includes(Number(total)));
}
