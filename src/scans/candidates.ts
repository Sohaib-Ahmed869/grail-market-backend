import type { Identification, Valuation } from "@grailcard/shared";

export type Candidate = { identification: Identification; valuation?: Valuation | null };

// The runner-up matches, as a list somebody can choose from.
//
// Pure so the ordering and the de-duplication can be pinned by fixtures: the
// whole point of showing alternatives is that the top answer might be wrong,
// and a list that repeats the same card three times or buries the real one at
// the bottom is worse than no list.

/** How close two matches have to be before the second is worth offering.
 *
 *  A 0.95 match beside a 0.31 match is not a choice, it is noise with a
 *  radio button. Anything more than this far below the winner is dropped. */
export const OFFER_WITHIN = 0.25;

/** At most this many. A scrolling list of maybes is a way of not answering. */
export const MAX_CANDIDATES = 5;

const key = (i: Identification) =>
  i.cardId && i.cardId !== "llm" && i.cardId !== "described"
    ? `id:${i.cardId}`
    : `nm:${i.game}:${i.name.toLowerCase()}:${(i.setName ?? "").toLowerCase()}`;

/** Chosen first, then the plausible others, best first, no repeats.
 *
 *  Each carries the valuation the catalogue that found it returned. Keeping it
 *  means choosing an alternative is a swap rather than another round trip —
 *  the price was already paid for when every catalogue was asked. */
export function rankedCandidates(
  matches: Candidate[],
  chosen: Candidate,
): Candidate[] {
  const out: Candidate[] = [chosen];
  const seen = new Set([key(chosen.identification)]);
  const floor = (chosen.identification.matchScore ?? 0) - OFFER_WITHIN;

  for (const m of [...matches].sort(
    (a, b) => (b.identification.matchScore ?? 0) - (a.identification.matchScore ?? 0),
  )) {
    if (out.length >= MAX_CANDIDATES) break;
    const i = m.identification;
    if ((i.matchScore ?? 0) < floor) break;
    const k = key(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  // One entry is not a choice. Returning nothing tells the app to show no
  // picker at all, rather than a list of one that implies there was a decision.
  return out.length > 1 ? out : [];
}
