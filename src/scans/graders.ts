// Which league a grading company plays in, and which listing titles name one.
//
// Mirrors TIERS in vision/app/pipeline/slab.py. Never price across tiers: a
// BCCG 10 and a BGS 10 are not comparable goods, and the whole point of
// keeping the grader on the price key is that nothing downstream has to guess.
//
// Lives here rather than beside one caller because both the scan path and the
// refresh job need it, and two copies of this table drifting apart is a bug
// that would show up as money.
export const GRADER_TIER: Record<string, string> = {
  PSA: "premium", BGS: "premium", BVG: "premium", CGC: "premium", SGC: "premium",
  TAG: "emerging", ACE: "emerging", AGS: "emerging", MNT: "emerging",
  GMG: "emerging", "ARENA CLUB": "emerging", "RARE EDITION": "emerging",
  BCCG: "discount", GMA: "discount", KSA: "discount", HGA: "discount", CSG: "discount",
  ISA: "discount", PGI: "discount", WCG: "discount", CGA: "discount",
};

export function graderTier(grader: string): string | null {
  return GRADER_TIER[grader.toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Reading a grading company off a listing title.
//
// One list, because the same question — is this listing a slab? — is asked of
// live asks (ebaylistings.ts) and of sold rows (thecardapi.ts), and a company
// known to one and not the other prices a slab as a loose card on whichever
// path missed it. A GMG 10 Josue De Paula asking US$24.50 sat in a raw pool of
// A$1.40-A$5.61 asks and was kept out only because the seller also typed the
// word "Graded".

/** Company names that cannot be anything else in a card title. */
const UNAMBIGUOUS = [
  "PSA", "BGS", "BECKETT", "BVG", "BCCG", "CGC", "SGC", "AGS", "HGA", "GMA",
  "KSA", "CSG", "GMG", "ISA", "PGI", "WCG", "CGA",
  "ARENA\\s+CLUB", "RARE\\s+EDITION",
];

/** Company names that are also ordinary card words, so they count only with a
 *  grade number against them.
 *
 *  "TAG TEAM" is a Pokemon mechanic and "Ace" is a One Piece character, both
 *  already in the old bare list — a raw Portgas D. Ace was being read as a
 *  slab and dropped from its own raw pool. "MNT" is how some sellers shorten
 *  mint ("GEM MNT"). */
const AMBIGUOUS = ["TAG", "ACE", "MNT"];

/** Not a slab, whatever else the title says — invariant 3. Raw Card Review
 *  carries a company name and a number and is priced as raw. */
const NOT_A_SLAB = /\b(?:BRCR|RCR|RAW\s+CARD\s+REVIEW)\b/i;

/** The seller said it is in a holder without naming who put it there. */
const GENERIC_SLAB = /\b(?:GRADED|SLABBED|SLAB)\b/i;

const COMPANY_RE = new RegExp(`\\b(?:${UNAMBIGUOUS.join("|")})\\b`, "i");
const COMPANY_NUMBERED_RE = new RegExp(
  `\\b(?:${AMBIGUOUS.join("|")})\\s*[-:]?\\s*\\d{1,3}(?:\\.5)?\\b`,
  "i",
);

/** Every company, for callers that want the grade too. Ambiguous names are in
 *  here as well, because this pattern only matches with a number attached. */
export const GRADER_ALTERNATION = [...UNAMBIGUOUS, ...AMBIGUOUS].join("|");

const GRADE_RE = new RegExp(
  `\\b(${GRADER_ALTERNATION})\\s*[-:]?\\s*(\\d{1,3}(?:\\.5)?)\\b`,
  "i",
);

/** Beckett writes itself several ways; BCCG is a different product entirely
 *  (invariant 3) and keeps its own name so it can never be read as BGS. */
export function canonicalGrader(raw: string): string {
  const s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  return s === "BECKETT" ? "BGS" : s;
}

/** Is this listing a card in a holder?
 *
 *  A named company wins outright. Failing that, the generic words count —
 *  unless the title is a Raw Card Review, which says "graded" about a card
 *  that is not in a slab at all. */
export function isGradedListing(title: string): boolean {
  if (COMPANY_RE.test(title) || COMPANY_NUMBERED_RE.test(title)) return true;
  if (NOT_A_SLAB.test(title)) return false;
  return GENERIC_SLAB.test(title);
}

/** Pull the grading company and grade out of a listing title.
 *  Sellers write "BGS 8.5", "PSA 10 GEM MINT", "CGC 9.5" — enough to tell a
 *  listing for this exact slab from one for a different grade of the same card.
 *
 *  `grade` stays null outside 1-10: a number off the scale is a print run or a
 *  card number that happened to follow a company name. */
export function gradeFromTitle(title: string): { grader: string | null; grade: number | null } {
  if (NOT_A_SLAB.test(title)) return { grader: null, grade: null };
  const m = GRADE_RE.exec(title);
  if (!m) return { grader: null, grade: null };
  const grade = Number(m[2]);
  return {
    grader: canonicalGrader(m[1]),
    grade: Number.isFinite(grade) && grade >= 1 && grade <= 10 ? grade : null,
  };
}
