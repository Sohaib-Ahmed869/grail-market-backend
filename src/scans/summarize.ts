import type { Scan } from "@grailcard/shared";

function shape(overall: number): string {
  if (overall >= 9.5) return "in exceptional shape";
  if (overall >= 8.5) return "in very good shape overall";
  if (overall >= 7) return "in good shape with visible flaws";
  if (overall >= 5) return "in played condition";
  return "in rough condition";
}

/** Compose the human-readable condition summary strictly from what was
 *  measured — every sentence traces to a number in the report. */
export function buildSummary(scan: Scan): string | null {
  const g = scan.grade;
  if (!g) return null;
  const parts: string[] = [];
  const name = scan.identification?.name ?? "This card";

  parts.push(
    `${name} looks ${shape(g.overall)} — estimated ${g.overall.toFixed(1)}, band ${g.band.low.toFixed(1)}–${g.band.high.toFixed(1)}.`,
  );

  const cen = scan.measurement?.centering;
  if (cen?.front.measurable) {
    const f = cen.front;
    const worst = Math.max(f.lr, 100 - f.lr, f.tb, 100 - f.tb);
    const centeringWord = worst <= 55 ? "excellent" : worst <= 60 ? "solid" : worst <= 65 ? "noticeably off" : "poor";
    parts.push(
      `Centering measures ${f.lr.toFixed(0)}/${(100 - f.lr).toFixed(0)} left-right and ${f.tb.toFixed(0)}/${(100 - f.tb).toFixed(0)} top-bottom — ${centeringWord}${cen.passesAt.psa10 ? ", within PSA 10 tolerance" : cen.passesAt.psa9 ? ", PSA 9 territory" : ""}.`,
    );
    if (cen.back?.measurable) {
      parts.push(
        `The back measures ${cen.back.lr.toFixed(0)}/${(100 - cen.back.lr).toFixed(0)} and ${cen.back.tb.toFixed(0)}/${(100 - cen.back.tb).toFixed(0)}.`,
      );
    }
  } else if (cen) {
    parts.push(
      "Centering couldn't be measured — this design has no printed border to measure against, so we don't guess at it.",
    );
  }

  const co = g.subgrades.corners;
  const ed = g.subgrades.edges;
  if (co && ed) {
    if (co.value >= 9 && ed.value >= 9) {
      parts.push("Corners are sharp and the edges are clean.");
    } else if (co.value < 9 && ed.value >= 9) {
      parts.push(`Edges are clean, but corner wear holds it back (corners ${co.value.toFixed(1)}).`);
    } else if (co.value >= 9) {
      parts.push(`Corners are sharp, but the edges show wear (edges ${ed.value.toFixed(1)}).`);
    } else {
      parts.push(
        `Both corners (${co.value.toFixed(1)}) and edges (${ed.value.toFixed(1)}) show wear.`,
      );
    }
  } else if (!co || !ed) {
    parts.push(
      "Corner and edge condition couldn't be assessed on this design — the artwork runs to the card edge, leaving no border stock to judge.",
    );
  }

  const f = g.findings;
  if (f) {
    parts.push(
      f.scratchesDetected
        ? `The surface shows ${f.clusterCount} possible mark${f.clusterCount === 1 ? "" : "s"} (scratches or print lines), boxed on the detection view.`
        : "No surface scratches were detected above our threshold on this photo.",
    );
  }

  if (scan.captures[0]?.quality?.lowDetail) {
    parts.push("Note: the card is small in this photo, so all of the above carries reduced confidence — a closer shot would firm it up.");
  }
  if (scan.authenticity?.digitalLikely) {
    parts.push("Caution: this image looks digital (render or screen photo) — condition claims only mean something for a physical card.");
  }

  return parts.join(" ");
}
