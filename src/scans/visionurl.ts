import type { VisionAnalyzeResponse } from "@grailcard/shared";

/** `VISION_URL=off` runs the API with no vision service at all — no OCR, no
 *  DINOv2, no picture matching. Every scan then falls through to Gemini naming
 *  the card from the raw photo, which is already the chain's last resort.
 *
 *  For a machine without the memory for the vision process (up to 1.2 GB).
 *  Read per call, like the recognition thresholds, so tests can flip it. */
export function visionDisabled(raw: string | undefined = process.env.VISION_URL): boolean {
  return /^(off|none|false|0|disabled)$/i.test((raw ?? "").trim());
}

/** What `/analyze` would have said about a photo it never saw: accepted, and
 *  nothing read off it. `ocr` is present but empty on purpose — runScan only
 *  enters identification when it exists, and identification is where Gemini
 *  is asked. Every catalogue lookup returns null on an empty name list. */
export function blankAnalysis(): VisionAnalyzeResponse {
  return {
    ok: true,
    quality: null,
    rejection: null,
    measurement: null,
    grade: null,
    authenticity: null,
    ocr: {
      nameCandidates: [],
      collectorNumber: null,
      setCode: null,
      slab: null,
      texts: [],
      language: "unknown",
      japaneseTextDetected: false,
    },
    warpedImageB64: null,
    overlayImageB64: null,
  };
}

/** Render's blueprint `fromService` injects a bare host ("x.onrender.com")
 *  with no scheme, and a schemeless URL makes fetch() throw. Accept both.
 *
 *  Lives in its own module because both scans.service.ts and tcgdex.ts need it
 *  at module-init time, and those two already import each other — putting it in
 *  either would make the cycle resolve to `undefined` at load.  */
export function normaliseVisionUrl(raw?: string): string {
  if (!raw) return "http://localhost:8100";
  // switched off: callers check visionDisabled() before fetching
  if (visionDisabled(raw)) return "";
  const trimmed = raw.replace(/\/+$/, "");
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  // A bare service name with no dot ("grailcard-vision") is what Render's
  // `fromService … property: host` injects. It looks like a host but resolves
  // nowhere, and the only symptom is a 503 on every scan — so say so at boot
  // rather than letting it fail silently on each request.
  const host = url.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  if (host !== "localhost" && !host.includes(".")) {
    console.warn(
      `[vision] VISION_URL="${raw}" has no domain — resolved to ${url}, which will not route. ` +
        "Set it to the service's full public host.",
    );
  }
  return url;
}
