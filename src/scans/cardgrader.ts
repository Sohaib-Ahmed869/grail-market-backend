import type { GradedPrices } from "@grailcard/shared";
import { recordUsage } from "./usage.js";

// CardGrader.AI market module as a graded-price BACKUP (their comps come
// from eBay sold data). Costs 1 credit (~$0.20) per call — used only when
// PPT has nothing. Skips silently on 402 (no credits) or timeout.

const BASE = "https://cardgrader.ai";

export async function fetchCardGraderMarket(
  frontB64: string,
  idemKey: string,
): Promise<GradedPrices | null> {
  const key = process.env.CARDGRADER_API_KEY;
  if (!key) return null;

  try {
    const bytes = Buffer.from(frontB64, "base64");
    const form = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
    form.append("front", blob, "front.jpg");
    form.append("back", blob, "back.jpg"); // their API requires a back image
    form.append("modules", "market");

    recordUsage("cardgrader");
    const submit = await fetch(`${BASE}/v1/scans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Idempotency-Key": idemKey },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!submit.ok) return null; // 402 insufficient credits, etc.
    const { id } = (await submit.json()) as { id: number };

    // poll up to ~70s
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      const res = await fetch(`${BASE}/v1/scans/${id}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as any;
      if (body.status === "failed") return null;
      if (body.status === "completed") {
        const spread = (body.value?.gradedValueSpread ?? []) as {
          grade: number;
          value: number;
        }[];
        const at = (g: number) => spread.find((s) => Math.round(s.grade) === g)?.value ?? null;
        const graded: GradedPrices = {
          source: "cardgrader",
          psa8: at(8),
          psa9: at(9),
          psa10: at(10),
          estimated: true, // their spread mixes comps with model estimates
        };
        return graded.psa8 == null && graded.psa9 == null && graded.psa10 == null
          ? null
          : graded;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Always-available floor: multiplier estimates from the raw NM price.
 *  Clearly labeled — these are heuristics, not sales. Grade premiums
 *  COMPRESS as raw value rises (a $5 card can 6x in a PSA 10 slab; a
 *  $2,000 card rarely does 2.5x), so the multipliers are value-banded. */
export function estimateGradedFromRaw(raw: number): GradedPrices {
  const [m8, m9, m10] =
    raw >= 500 ? [1.0, 1.3, 2.5] : raw >= 50 ? [1.1, 1.7, 4.0] : [1.2, 2.0, 6.0];
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    source: "estimate",
    psa8: r(raw * m8),
    psa9: r(raw * m9),
    psa10: r(raw * m10),
    estimated: true,
  };
}
