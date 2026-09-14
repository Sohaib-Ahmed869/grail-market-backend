import { normaliseVisionUrl } from "./visionurl.js";

// Choosing between printings that share a card number.
//
// This is the gap every per-game text fix has been working around. A card
// number resolves a CARD; what separates the printings of that card is almost
// always the artwork, and we identify from text, which usually does not name
// it. So the printing came from whatever text happened to carry it — "MANGA ART
// SEC" on a Beckett label, "SCYTHER" on a PSA one, an "SP" glued to a card
// number, a set code, or the vision model describing the art in words. Each
// worked for its case and none generalised, because for most cards the only
// difference is the picture.
//
// Every catalogue already gives one image per printing, so the picture is
// available for exactly the comparison that decides it. On a One Piece Koby the
// catalogue returned the base art and the Alternate Art, we took the first, and
// priced a $10 card at $2.
//
// Two measures, not one, and the second is the one that pays.
//
// dHash alone was here first: a 64-bit gradient signature over an 8x9
// greyscale thumbnail. It is right about 98% of the time, and it is colour
// blind by construction — which is fatal on exactly the cards that matter,
// because the difference between a Super Alternate Art and a Red Super
// Alternate Art is that one of them is red. Measured over 264 simulated phone
// photos of the demo-cards set, dHash's winning margin on the US$19,999 Red
// Super Alternate Art averaged 0.031, under the threshold below. So it
// declined, the caller fell back to catalogue order, and the base card was
// priced. That IS the A$197 defect.
//
// The vision service now scores colour alongside structure, normalised for
// light and stripped of glare (see vision/app/pipeline/match.py for why the
// naive version is worse than nothing). On the same 264 trials the pair was
// right every time and never had to decline, and the margin on that card went
// from 0.031 to 0.220.

const VISION_URL = normaliseVisionUrl(process.env.VISION_URL);

/** How far ahead the best match must be before the picture is allowed to
 *  decide.
 *
 *  Set from measurement, not taste. Under realistic photography the combined
 *  measure's margin on a correct pick averaged 0.279 and never fell below this
 *  line; when the two measures genuinely disagree it collapses, which is the
 *  case this threshold exists to catch. Raising it does not buy accuracy — it
 *  buys questions the app has to ask the member. */
const MIN_MARGIN = 0.05;

export type PrintingCandidate = {
  /** the catalogue's image for this printing — the thing being compared */
  imageUrl: string | null;
  /** anything else that hints at the printing, e.g. "(Alternate Art)" */
  label?: string | null;
};

export type PrintingChoice<T> = {
  pick: T;
  /** every candidate with its visual score, best first — the interface can
   *  offer these as "not this one?" rather than making the user re-scan */
  ranked: { candidate: T; score: number | null; imageUrl: string | null }[];
  /** how the choice was made, so a low-confidence pick reads as one */
  method: "visual" | "single" | "fallback";
  /** margin between the best and second-best. A thin margin is a coin toss. */
  margin: number | null;
};

async function visualScores(
  warpedImageB64: string,
  urls: string[],
  parts: Map<string, { structure: number; colour: number }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (urls.length === 0) return out;
  try {
    const form = new FormData();
    // As a FILE, not a form field: starlette caps a non-file part at 1 MB and a
    // warped card is several times that, so every one of these was rejected as a
    // malformed body before the service saw it.
    form.append("file", new Blob([Buffer.from(warpedImageB64, "base64")]), "card.png");
    form.append("urls", JSON.stringify(urls));
    const res = await fetch(`${VISION_URL}/similarity`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`[printing] vision /similarity ${res.status}`);
      return out;
    }
    const data = (await res.json()) as {
      scores: {
        url: string;
        similarity: number | null;
        /** the two halves, for the log line when a pick turns out wrong */
        structure?: number;
        colour?: number;
      }[];
    };
    for (const s of data.scores) {
      if (s.similarity == null) continue;
      out.set(s.url, s.similarity);
      if (s.structure != null && s.colour != null) {
        parts.set(s.url, { structure: s.structure, colour: s.colour });
      }
    }
  } catch (err) {
    console.warn(`[printing] visual match unavailable: ${(err as Error).message}`);
  }
  return out;
}

/** Pick which printing the photographed card actually is.
 *
 *  Falls back to the caller's own order when there is no photo to compare
 *  against or the vision service is unreachable — a wrong pick is bad, and no
 *  answer at all is worse. The method is reported either way so nothing
 *  downstream mistakes a fallback for a decision. */
export async function pickPrinting<T extends PrintingCandidate>(
  candidates: T[],
  warpedImageB64: string | null | undefined,
): Promise<PrintingChoice<T> | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return {
      pick: candidates[0],
      ranked: [{ candidate: candidates[0], score: null, imageUrl: candidates[0].imageUrl }],
      method: "single",
      margin: null,
    };
  }

  const urls = candidates.map((c) => c.imageUrl).filter((u): u is string => Boolean(u));
  const parts = new Map<string, { structure: number; colour: number }>();
  const scores = warpedImageB64
    ? await visualScores(warpedImageB64, urls, parts)
    : new Map<string, number>();

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: candidate.imageUrl ? scores.get(candidate.imageUrl) ?? null : null,
      imageUrl: candidate.imageUrl,
    }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const scored = ranked.filter((r) => r.score != null);
  if (scored.length === 0) {
    return { pick: candidates[0], ranked, method: "fallback", margin: null };
  }

  const margin =
    scored.length > 1 ? (scored[0].score as number) - (scored[1].score as number) : null;

  // A win by a hair is not a win.
  //
  // dHash reduces a card to a 64-bit gradient signature. That is enough to ask
  // "is this the right card at all", which is what it was added for, and NOT
  // enough to separate printings that share a character, a pose and a frame and
  // differ in the artwork behind them. Measured on the five printings of
  // OP13-119 the best score beat the second by 0.016 — noise. Acting on that is
  // worse than not looking, because it overrides text evidence that was right.
  //
  // So below the threshold this reports what it saw and declines to choose. The
  // ranked list still goes back, because offering the alternatives is the
  // honest move when the picture genuinely does not settle it.
  if (margin != null && margin < MIN_MARGIN) {
    console.log(
      `[printing] ${scored.length} compared, top margin ${margin.toFixed(3)} < ${MIN_MARGIN} — ` +
        `too close to call, keeping the catalogue's order`,
    );
    return { pick: candidates[0], ranked, method: "fallback", margin };
  }

  const half = scored[0].imageUrl ? parts.get(scored[0].imageUrl) : undefined;
  console.log(
    `[printing] ${scored.length} printings compared -> "${
      (scored[0].candidate.label ?? "").slice(0, 40)
    }" ${scored[0].score?.toFixed(3)}` +
      (half ? ` [structure ${half.structure.toFixed(3)} colour ${half.colour.toFixed(3)}]` : "") +
      (margin != null ? ` (margin ${margin.toFixed(3)})` : ""),
  );
  return { pick: scored[0].candidate, ranked, method: "visual", margin };
}
