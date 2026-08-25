import type { Grade } from "@grailcard/shared";

// Ximilar card-grader v2: trained grading models (corners/edges/surface/
// centering/final). Called only for scans that passed the quality gate —
// each call costs ~100 credits. Activated by XIMILAR_API_KEY.

const XIMILAR_URL = "https://api.ximilar.com/card-grader/v2/grade";

export type XimilarResult = {
  grade: Grade;
  condition: string | null;
  centeringRatios: { lr: number; tb: number } | null;
};

function parseRatio(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a + b > 0 ? (100 * a) / (a + b) : null;
}

export async function gradeWithXimilar(imageB64: string): Promise<XimilarResult | null> {
  const key = process.env.XIMILAR_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(XIMILAR_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ _base64: imageB64 }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { records?: Record<string, any>[] };
    const rec = body.records?.[0];
    const grades = rec?.grades as
      | {
          corners?: number;
          edges?: number;
          surface?: number;
          centering?: number;
          final?: number;
          condition?: string;
        }
      | undefined;
    if (!grades || grades.final == null) return null;

    const sub = (v: number | undefined | null) =>
      v == null ? null : { value: v, confidence: 0.8 };

    const grade: Grade = {
      overall: grades.final,
      band: {
        low: Math.max(1, Math.round((grades.final - 1) * 2) / 2),
        high: Math.min(10, Math.round((grades.final + 0.5) * 2) / 2),
      },
      subgrades: {
        centering: sub(grades.centering),
        corners: sub(grades.corners),
        edges: sub(grades.edges),
        surface: sub(grades.surface) ?? { value: 5, confidence: 0.1 },
      },
      findings: null, // our own scratch detector's findings are merged by the caller
      method: "ximilar-v2",
      notes: [
        "Graded by trained models (Ximilar card-grader v2)." +
          (grades.condition ? ` Condition read: ${grades.condition}.` : ""),
        "Front side only — the back is not yet analyzed for condition. Professional graders assess both sides.",
      ],
    };

    const cen = rec?.card?.[0]?.centering;
    const lr = parseRatio(cen?.["left/right"]);
    const tb = parseRatio(cen?.["top/bottom"]);

    return {
      grade,
      condition: grades.condition ?? null,
      centeringRatios: lr != null && tb != null ? { lr, tb } : null,
    };
  } catch {
    return null;
  }
}
