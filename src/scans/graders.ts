// Which league a grading company plays in.
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
  BCCG: "discount", GMA: "discount", KSA: "discount", HGA: "discount", CSG: "discount",
};

export function graderTier(grader: string): string | null {
  return GRADER_TIER[grader.toUpperCase()] ?? null;
}
