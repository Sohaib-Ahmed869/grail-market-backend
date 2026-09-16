import { normaliseVisionUrl, visionDisabled } from "./visionurl.js";

// Image recognition: the flattened card against every catalogue render we
// hold, by picture rather than by the text printed on it.
//
// The text chain reads a name and a number and asks catalogues; it fails on
// exactly the cards people care about — holo glare over the collector line,
// Japanese print, stylised fonts — and every such miss went to Gemini, which is
// slow, capped and nondeterministic. The vision service embeds the card with
// DINOv2 (free, Apache-2.0, run locally) and returns the nearest renders with
// their catalogue ids. See vision/app/pipeline/cardindex.py and
// vision/scripts/build_index.py.

const VISION_URL = normaliseVisionUrl(process.env.VISION_URL);

export type ImageMatch = {
  game: string;
  cardId: string;
  name: string | null;
  setId: string | null;
  setName: string | null;
  number: string | null;
  imageUrl: string | null;
  score: number;
  language?: string | null;
};

export type Recognition = {
  matches: ImageMatch[];
  /** best score minus the best score of a DIFFERENT card (printings of one card are one card) */
  margin: number | null;
  indexSize: number;
};

/** Null when the service, its model or its index is not there — recognition
 *  is an addition to the text chain, never a dependency of it. */
export async function recognizeCard(
  warpedImageB64: string | null | undefined,
  games?: string[],
): Promise<Recognition | null> {
  if (!warpedImageB64 || visionDisabled()) return null;
  try {
    const form = new FormData();
    // As a FILE: starlette caps a non-file field at 1 MB and a warped card is
    // several times that (see printingpicker.ts, which learned this first).
    form.append("file", new Blob([Buffer.from(warpedImageB64, "base64")]), "card.png");
    if (games?.length) form.append("games", games.join(","));
    form.append("k", "12");
    const res = await fetch(`${VISION_URL}/recognize`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[recognize] vision /recognize ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      available?: boolean; reason?: string; matches?: ImageMatch[]; margin?: number | null; indexSize?: number;
    };
    if (!data.available) return null;
    return { matches: data.matches ?? [], margin: data.margin ?? null, indexSize: data.indexSize ?? 0 };
  } catch (err) {
    console.warn(`[recognize] unavailable: ${(err as Error).message}`);
    return null;
  }
}

const envNumber = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return process.env[k] != null && process.env[k] !== "" && Number.isFinite(n) ? n : d;
};

/** How close the nearest render must be, and how far ahead of any OTHER card,
 *  before the picture alone names the card. Read per call so they can be tuned
 *  without a deploy.
 *
 *  Measured 2026-09-15 on 56 stored, catalogue-confirmed One Piece scans
 *  (vision/scripts/eval_index.py): the right card ranked first on 90% of raw
 *  photos and 73% of slab photos. Every wrong first match had a margin under
 *  0.026 over the next card. At margin >= 0.05 the picture named 40 of 56 on
 *  its own with ZERO wrong; the score floor barely matters once the margin
 *  holds, so it sits at 0.65 as a guard against junk photos. Re-measure before
 *  loosening either. */
export const recognizeThresholds = () => ({
  minScore: envNumber("RECOGNIZE_MIN_SCORE", 0.65),
  minMargin: envNumber("RECOGNIZE_MIN_MARGIN", 0.05),
  /** lead over every OTHER printing of the same name before the picture is
   *  allowed to settle the printing too */
  minPrintingLead: envNumber("RECOGNIZE_MIN_PRINTING_LEAD", 0.04),
});

/** The card the picture is sure of, or null. */
export function confidentMatch(r: Recognition | null): ImageMatch | null {
  const top = r?.matches[0];
  if (!r || !top) return null;
  const t = recognizeThresholds();
  if (top.score < t.minScore) return null;
  if (r.margin != null && r.margin < t.minMargin) return null;
  return top;
}

/** Which CARD a match is, ignoring which printing — the same rule as
 *  vision's cardindex.card_key. Catalogues spell the printing into the name
 *  ("Sabo (001) (Alternate Art)"), and One Piece printings share a number. */
export function cardKey(m: Pick<ImageMatch, "game" | "name" | "number">): string {
  if (m.game === "onepiece" && m.number) return `onepiece:${m.number.toUpperCase()}`;
  return `${m.game}:${(m.name ?? "").replace(/\s*\([^)]*\)/g, "").trim().toLowerCase()}`;
}

const sameName = (a: ImageMatch, b: ImageMatch) => cardKey(a) === cardKey(b);

/** The best match's lead over the nearest OTHER printing of the same card, or
 *  null when no other printing is near. Printings share artwork, so this is
 *  usually small; only a clear lead lets the picture pick the printing. */
export function printingLead(r: Recognition): number | null {
  const top = r.matches[0];
  if (!top) return null;
  const rival = r.matches.slice(1).find((m) => m.cardId !== top.cardId && sameName(m, top));
  return rival ? Math.round((top.score - rival.score) * 10_000) / 10_000 : null;
}

/** Does the picture settle the printing as well as the card? */
export function pictureProvesPrinting(r: Recognition): boolean {
  const lead = printingLead(r);
  return lead == null || lead >= recognizeThresholds().minPrintingLead;
}
