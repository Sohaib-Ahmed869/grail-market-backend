// Match a slab's printing by what the label SAYS, not by what we anticipated.
//
// The printing matcher in printing.ts is a hand-written allowlist: manga,
// parallel, wanted, shadowless, unlimited, 1st, reverse, staff, sp. Anything
// not on that list has no printing, so the listings are never narrowed and the
// card is priced as whatever else shares its number.
//
// That list cannot be finished. One Piece alone ships Magazine Exclusive,
// Sound Loader, Convention Exclusive, Event Pack, Grevin Museum, Starter Deck
// promos — and a new line every few months. Each omission is a 10x to 100x
// pricing error, because a promo and the base card share a collector number
// and nothing else. A PSA MAGAZINE EXCLUSIVE Luffy sells around $615 while the
// OP05-060 Leader it was priced as is worth $0.65 raw.
//
// So this does not try to NAME the printing. It takes the distinctive words
// the grading company printed on the label and finds listings carrying the
// same words. The label is the most authoritative description of the card
// anywhere in the pipeline — a company examined the card and wrote down what
// it is — and we were using it for two fields.
//
// OCR loses the spaces in a label's condensed font ("PSA MAGAZINE EXCLUSIVE"
// arrives as "PSAMAGAZINEEXCLUSIVE"), so everything here compares on
// alphanumerics only, which sidesteps the problem entirely.

/** Words that appear on every label and therefore distinguish nothing. */
const FURNITURE = new Set([
  "PSA", "BGS", "BECKETT", "CGC", "SGC", "TAG", "ACE", "BVG", "BCCG", "HGA", "GMA",
  "GEM", "GEMMT", "MINT", "MT", "NM", "PRISTINE", "UNIVERSAL", "GRADE", "GRADED",
  "AUTHENTIC", "QUALIFIER", "CERT", "POP", "LABEL", "CENTERING", "CORNERS",
  "EDGES", "SURFACE", "TRADING", "CARD", "CARDS", "GAME", "TCG", "CCG",
  "POKEMON", "POKMON", "ONEPIECE", "ONE", "PIECE", "EN", "JP", "ENGLISH",
  "JAPANESE", "PROMO", "PROMOS", "HOLO", "FOIL", "RARE",
]);

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Distinctive fragments the label printed, longest first.
 *
 *  Anything already implied by the card's own name or set is dropped — those
 *  are on every listing for every printing and narrow nothing. */
export function labelTokens(
  labelText: string[],
  known: { name?: string | null; setName?: string | null } = {},
): string[] {
  const implied = new Set<string>();
  for (const s of [known.name, known.setName]) {
    if (!s) continue;
    for (const w of s.toUpperCase().split(/[^A-Z0-9]+/)) if (w.length >= 3) implied.add(w);
  }

  const out = new Set<string>();
  // Strip every word we already know about from wherever it appears in the
  // token, not just from the front. OCR glues the label into runs like
  // "MONKEYD.LUFFY" and "ONEPIECEEN", and matching only exact words let
  // "MONKEYD" and "PIECEEN" through — which then match every listing for the
  // card and narrow nothing while looking like they had.
  const strip = (w: string): string => {
    let cur = w;
    let changed = true;
    while (changed) {
      changed = false;
      for (const known of [...FURNITURE, ...implied]) {
        if (known.length < 3) continue;
        const i = cur.indexOf(known);
        if (i >= 0) {
          cur = cur.slice(0, i) + cur.slice(i + known.length);
          changed = true;
        }
      }
    }
    return cur;
  };

  for (const raw of labelText) {
    if (!raw) continue;
    for (const word of raw.toUpperCase().split(/[^A-Z0-9]+/)) {
      if (word.length < 5) continue;
      if (/^\d+$/.test(word)) continue;
      // What is left once everything we could already have named is removed.
      // If that is short, the token carried no new information.
      if (strip(word).length < 5) continue;
      out.add(word.replace(/^(?:PSA|BGS|CGC|SGC|TAG|BECKETT)/, ""));
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Does this listing describe the same printing the label names?
 *
 *  Substring on alphanumerics only, so a glued OCR token still matches a
 *  spaced-out listing title. */
export function listingMatchesLabel(title: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const t = norm(title);
  return tokens.some((tok) => tok.length >= 6 && t.includes(tok));
}

/** Is the raw price plausible for a card someone paid to grade and slab?
 *
 *  A general safety net that needs no list of printings. Nobody pays $15 plus
 *  postage to grade a 65-cent common, so a trivial raw price beneath a
 *  substantial graded market means we are looking at the wrong product — the
 *  base card sharing a number with the promo actually in the holder.
 *
 *  It does not correct anything. It says the identification is not trustworthy
 *  enough to hang a confident figure on, which is the difference between this
 *  system and one that guesses. */
export function rawGradedDivergence(
  rawUsd: number | null | undefined,
  gradedUsd: number | null | undefined,
): { suspect: boolean; ratio: number | null; reason: string | null } {
  if (rawUsd == null || gradedUsd == null || rawUsd <= 0 || gradedUsd <= 0) {
    return { suspect: false, ratio: null, reason: null };
  }
  const ratio = gradedUsd / rawUsd;
  // Grading a card costs real money, so a slab implies the raw card was worth
  // grading. Twenty times is comfortably past normal slab premium and into
  // "these are different products".
  if (rawUsd < 5 && ratio > 20) {
    return {
      suspect: true,
      ratio,
      reason:
        `The card we identified has a raw market price of $${rawUsd.toFixed(2)}, ` +
        `but the graded market for it is around $${gradedUsd.toFixed(0)} — ${Math.round(ratio)}x. ` +
        `Nobody pays to grade a card worth $${rawUsd.toFixed(2)}, so this is very likely a ` +
        `different printing that shares the same collector number.`,
    };
  }
  return { suspect: false, ratio, reason: null };
}
