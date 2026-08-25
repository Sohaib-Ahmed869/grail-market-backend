import type { Grade, Recommendation, Valuation } from "@grailcard/shared";

const GRADING_COST = Number(process.env.GRADING_COST ?? 25); // PSA bulk-ish, USD

function bucketOf(v: number): string {
  if (v >= 9.5) return "PSA 10";
  if (v >= 8.5) return "PSA 9";
  return "PSA 8";
}

/** NM market price -> plausible value of THIS copy given its grade estimate. */
export function conditionMultiplier(overall: number): number {
  if (overall >= 9.5) return 1.0;
  if (overall >= 8.5) return 0.85;
  if (overall >= 7.5) return 0.7;
  if (overall >= 6.5) return 0.55;
  if (overall >= 5) return 0.4;
  return 0.25;
}

export function buildRecommendation(
  grade: Grade | null | undefined,
  valuation: Valuation | null | undefined,
): Recommendation | null {
  if (!grade) return null;

  // the grading math must use what THIS copy is worth raw, in its condition
  const raw =
    valuation?.conditionAdjusted?.value ??
    valuation?.tcgplayer?.market ??
    valuation?.cardmarket?.trend ??
    valuation?.webEstimate?.value ??
    null;
  const graded = valuation?.graded ?? null;
  const likely = bucketOf(grade.overall);

  const rows = (
    [
      ["PSA 10", graded?.psa10],
      ["PSA 9", graded?.psa9],
      ["PSA 8", graded?.psa8],
    ] as const
  ).map(([label, value]) => ({
    grade: label,
    value: value ?? null,
    net: value != null && raw != null ? value - raw - GRADING_COST : null,
    inBand:
      label === bucketOf(grade.band.low) ||
      label === bucketOf(grade.band.high) ||
      label === likely,
  }));

  if (!graded || raw == null) {
    // no fabricated maybes: a determinate answer with honest reasoning
    return {
      verdict: "dont_grade",
      reasoning:
        "Don't grade this one on today's data. No market prices exist for this exact card in any database we reach — the eBay sold links below are the best pricing that exists for it. If real graded sales appear there and clearly beat the raw price plus fees, revisit.",
      gradingCost: GRADING_COST,
      rawValue: raw,
      likelyGrade: likely,
      rows,
    };
  }

  const likelyRow = rows.find((r) => r.grade === likely);
  const lowRow = rows.find((r) => r.grade === bucketOf(grade.band.low));
  const likelyNet = likelyRow?.net ?? null;
  const worstNet = lowRow?.net ?? null;

  // grade when the likely outcome clearly pays AND the low end of the band
  // risks only a small fraction of that upside (risking $50 to make $700 is
  // a good trade; risking $50 to make $60 is not)
  const upsideOk = likelyNet != null && likelyNet > Math.max(10, raw * 0.15);
  const downsideOk =
    worstNet == null || worstNet >= -Math.max(15, (likelyNet ?? 0) * 0.25);
  const verdict = upsideOk && downsideOk ? "grade" : "dont_grade";

  const fmt = (n: number | null | undefined) => (n == null ? "?" : `$${n.toFixed(2)}`);
  const estNote = !graded.estimated
    ? ""
    : graded.source === "web-search"
      ? " Note: graded values here were read off public web pages by our own lookup, not a pricing API — each figure was re-checked against the page it came from, but confirm via the sources before paying for grading."
      : " Note: graded values here are ESTIMATES (no verified sales found) — confirm with the eBay sold links before paying for grading.";
  const reasoning =
    (verdict === "grade"
      ? `Estimated grade band ${grade.band.low.toFixed(1)}–${grade.band.high.toFixed(1)} makes ${likely} the likely outcome. ` +
        `${likely} sells for ${fmt(likelyRow?.value)} vs ${fmt(raw)} raw; after ~$${GRADING_COST} grading cost that nets ${fmt(likelyNet)}.` +
        (worstNet != null && worstNet < 0
          ? ` Worst case in the band loses ${fmt(Math.abs(worstNet))} — small next to the upside.`
          : " Even the low end of the band covers costs.")
      : `Estimated grade band ${grade.band.low.toFixed(1)}–${grade.band.high.toFixed(1)} makes ${likely} the likely outcome, ` +
        `worth ${fmt(likelyRow?.value)} vs ${fmt(raw)} raw. After ~$${GRADING_COST} grading cost the expected net is ${fmt(likelyNet)}` +
        `${worstNet != null && worstNet < 0 ? `, and the low end of the band would lose ${fmt(Math.abs(worstNet))}` : ""}. ` +
        `The risk/reward doesn't justify grading.`) + estNote;

  return {
    verdict,
    reasoning,
    gradingCost: GRADING_COST,
    rawValue: raw,
    likelyGrade: likely,
    rows,
  };
}
