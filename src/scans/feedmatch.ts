import { similarity } from "./similarity.js";

// Is the card the price feed answered with the card we asked about?
//
// It very often is not. Asking JustTCG for "Lurantis ex" from Pitch Black
// returns three cards called "Lurantis" — from Unified Minds, Destined Rivals
// and Battle Styles — none of them the one asked for, and all of them worth
// about thirty cents against a card worth a hundred dollars.
//
// Nothing downstream noticed, because the pulse keeps OUR name and OUR set and
// takes THEIR price. So the dashboard printed a real card's name, a real set,
// and a completely unrelated price, with a chart of that other card's week
// under it. That is the exact shape of failure this system is supposed to
// refuse: not a missing number, a confident wrong one.

/** Suffixes that make a card a DIFFERENT card, not a variant of one.
 *
 *  A Charizard and a Charizard ex share a name and nothing else — different
 *  print run, different rarity, and prices orders of magnitude apart. Matching
 *  across them is the single biggest source of a wrong price here. */
const GRADE_WORDS = ["ex", "gx", "v", "vmax", "vstar", "star", "prime", "break", "lv.x"];

const norm = (s: string) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** The trailing marker on a name, if it has one. */
export function suffixOf(name: string): string | null {
  const words = norm(name).split(" ");
  const last = words[words.length - 1] ?? "";
  return GRADE_WORDS.includes(last) ? last : null;
}

export type MatchVerdict =
  | { ok: true; score: number }
  | { ok: false; why: "name" | "suffix" | "set" };

/**
 * Does the feed's card describe ours?
 *
 * Deliberately strict. A price shown against the wrong card is worse than no
 * price at all, and the cost of refusing is one empty row.
 */
export function feedMatches(
  ours: { name: string; setName?: string | null },
  theirs: { name: string; set?: string | null },
  { minScore = 0.86 } = {},
): MatchVerdict {
  // The suffix first, because it is the difference that similarity scores
  // worst: "Lurantis" against "Lurantis ex" is 0.9 by characters and a
  // hundredfold by price.
  if (suffixOf(ours.name) !== suffixOf(theirs.name)) return { ok: false, why: "suffix" };

  const score = similarity(norm(ours.name), norm(theirs.name));
  if (score < minScore) return { ok: false, why: "name" };

  // The set only has to agree when we know both. The feed's set ids are
  // slugs — "sm-unified-minds-pokemon" — so this asks whether ours appears
  // inside theirs rather than for an exact match.
  if (ours.setName && theirs.set) {
    const mine = norm(ours.setName).replace(/ /g, "-");
    const yours = norm(theirs.set).replace(/ /g, "-");
    const shares =
      yours.includes(mine) || mine.includes(yours) ||
      // a short set name inside a long slug, e.g. "base set" in "base-set-pokemon"
      norm(ours.setName).split(" ").every((w) => w.length < 3 || yours.includes(w));
    if (!shares) return { ok: false, why: "set" };
  }

  return { ok: true, score };
}
