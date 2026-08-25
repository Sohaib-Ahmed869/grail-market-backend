// Set-code identification — reading the product identity a label actually prints.
//
// A graded label is not a hint, it is an answer key. "2025 POKEMON M2a JP /
// MEGA GENGAR ex / SPECIAL ART RARE / #240" names exactly one product in the
// world. We were scoring that line against English set NAMES, where "POKEMON
// M2a JP" resembles nothing, so it scored below threshold and fell through to
// fuzzy name matching — which put a Japanese Mega Charizard X ex SAR (M2 #110,
// a A$1,500 card) into the English set Phantasmal Flames as #013 Double Rare,
// a $5 card, and then priced it there.
//
// M2 and M2a are not names to be matched, they are set CODES to be looked up,
// and TCGdex serves them directly under the ja locale. Codes are exact: either
// the set exists at that id or it does not, so a wrong answer is impossible in
// the way a 0.72-similarity name match never is.

import type { Identification } from "@grailcard/shared";

const TCGDEX_ROOT = (process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en").replace(
  /\/(en|ja|fr|de|es|it|pt)$/,
  "",
);

/** Japanese-only rarity suffixes. Their presence is what tells us the card is a
 *  Japanese printing at all — English sets never print "SAR" or "CHR". */
const JP_RARITY = "SAR|CSR|CHR|SSR|RRR|UR|AR|SR|RR|ACE|BWR|K";
/** "110/080 SAR", "240/193 SAR" — number, set size, rarity */
const JP_NUMBER_RE = new RegExp(`\\b(\\d{1,3})\\s*/\\s*(\\d{1,3})\\s*(${JP_RARITY})\\b`, "i");
/** the label's own wording: "2025 POKEMON M2a JP" */
const LABEL_CODE_RE = /POKEMON\s*([A-Z]{1,3}\d{1,2}[a-z]?)\s*JP\b/i;
/** a bare set code printed on the card itself, bottom-left: "M2", "SV8a" */
const BARE_CODE_RE = /^(?:SV|S|M|SM|XY|BW|CP|SC|SD|G|L|P)[A-Za-z]?\d{0,2}[a-z]?$/;

export type SetCodeRead = {
  code: string;
  locale: "ja";
  /** the printed collector number, e.g. "240" */
  number: string | null;
  /** the full printed form sellers actually search on, e.g. "240/193" */
  printedNumber: string | null;
  rarity: string | null;
};

/** Read a Japanese set code + number out of everything we OCR'd.
 *
 *  Deliberately conservative: without a Japanese rarity suffix or an explicit
 *  "<CODE> JP" on the label we return null rather than guess, because a wrong
 *  set code resolves confidently to the wrong card. */
export function readSetCode(texts: string[]): SetCodeRead | null {
  const joined = texts.join(" ");
  const compact = joined.replace(/\s+/g, "");

  const num = JP_NUMBER_RE.exec(joined) ?? JP_NUMBER_RE.exec(compact);
  const labelCode = LABEL_CODE_RE.exec(joined) ?? LABEL_CODE_RE.exec(compact);
  if (!num && !labelCode) return null;

  // The label spells the code out next to "JP", which is the most reliable
  // source. Failing that, the card prints it alone in the bottom-left corner.
  let code = labelCode?.[1] ?? null;
  if (!code) {
    for (const t of texts) {
      const tok = t.trim();
      if (BARE_CODE_RE.test(tok) && /\d/.test(tok)) {
        code = tok;
        break;
      }
    }
  }
  if (!code) return null;

  return {
    code,
    locale: "ja",
    number: num?.[1] ?? null,
    printedNumber: num ? `${num[1]}/${num[2]}` : null,
    rarity: num?.[3]?.toUpperCase() ?? null,
  };
}

type JaCard = { id: string; localId: string | number; name: string; image?: string };

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Resolve a set code + number to the real catalog card.
 *
 *  `labelNumber` is the "#240" the grading label prints, used when the card's
 *  own "240/193" did not survive OCR — the two agree by construction. */
export async function identifyBySetCode(
  read: SetCodeRead,
  labelNumber?: string | null,
  displayName?: string | null,
): Promise<Identification | null> {
  const wanted = read.number ?? (labelNumber ? String(labelNumber) : null);
  if (!wanted) return null;

  const set = await getJson(`${TCGDEX_ROOT}/${read.locale}/sets/${read.code}`);
  if (!set?.cards?.length) return null;

  const target = String(Number(wanted));
  const card: JaCard | undefined = set.cards.find(
    (c: JaCard) => String(Number(String(c.localId).split("/")[0])) === target,
  );
  if (!card) return null;

  const detail = await getJson(`${TCGDEX_ROOT}/${read.locale}/cards/${card.id}`);

  // Prefer the English name the LABEL prints over the catalog's Japanese one:
  // it is what the owner sees through the case, and what eBay sellers write.
  const name = displayName?.trim() || card.name;
  const image = detail?.image ?? card.image;

  return {
    cardId: card.id,
    name,
    // keep the catalog's own-language name; the interface shows both
    nameLocal: card.name && card.name !== name ? card.name : null,
    setId: String(set.id),
    setName: String(set.name ?? read.code),
    // the printed form ("240/193") is what sellers search on; keep it whole
    localId: read.printedNumber ?? String(card.localId),
    rarity: read.rarity ?? detail?.rarity ?? null,
    imageUrl: image ? `${image}/high.png` : null,
    // a set code is exact — this is a lookup, not a similarity score
    matchScore: 1,
    ocrName: displayName ?? card.name,
    game: "pokemon",
  };
}

/** Sealed product — a pack, box, tin or bundle rather than a single card.
 *
 *  A sealed pack has no collector number and no catalog card behind it, so
 *  every card-shaped step downstream either fails or, worse, succeeds on the
 *  wrong thing: a "1999 JUNGLE FOIL PACK / 1ST EDITION" label produced card #1
 *  of Jungle out of the "1ST". It is still a product with a market, and the
 *  label names it precisely enough to price. */
// No \b anchors: OCR returns these labels with the spaces gone, so the words
// sit flush inside a longer run ("JUNGLEFOILPACK"). Anchoring on word
// boundaries meant a sealed pack was never recognised as one.
const SEALED_RE =
  /(foil\s*pack|booster\s*pack|booster\s*box|blister|elite\s*trainer|etb|sealed\s*(pack|box)|pack\b|\bbox\b|\btin\b)/i;

export function isSealedProduct(labelLines: (string | null | undefined)[]): boolean {
  return labelLines.filter(Boolean).some((l) => SEALED_RE.test(String(l)));
}
