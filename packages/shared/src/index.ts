import { z } from "zod";

// ---------------------------------------------------------------------------
// The scan record is the single contract between web, api, and vision.
// The vision service mirrors these shapes in Pydantic (services/vision/app/schemas.py).
// ---------------------------------------------------------------------------

export const CaptureKind = z.enum([
  "front",
  "back",
  "corner_tl",
  "corner_tr",
  "corner_bl",
  "corner_br",
]);
export type CaptureKind = z.infer<typeof CaptureKind>;

export const CaptureQuality = z.object({
  blurScore: z.number(), // Laplacian variance on the card crop; higher = sharper
  glarePct: z.number(), // % of card pixels inside specular clusters
  glareRegions: z
    .array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
    .default([]),
  cardAreaPct: z.number(), // card quad area / image area
  resolutionOk: z.boolean(), // warped card meets minimum pixel density
  lowDetail: z.boolean().default(false), // graded, but from a small card image
});
export type CaptureQuality = z.infer<typeof CaptureQuality>;

export const Capture = z.object({
  kind: CaptureKind,
  imageKey: z.string(),
  quality: CaptureQuality.nullish(),
});
export type Capture = z.infer<typeof Capture>;

export const RejectionReason = z.enum([
  "card_not_found",
  "too_blurry",
  "too_much_glare",
  "card_too_small",
  "resolution_too_low",
]);
export type RejectionReason = z.infer<typeof RejectionReason>;

export const Rejection = z.object({
  reason: RejectionReason,
  userMessage: z.string(), // plain-language explanation
  retryHint: z.string(), // concrete instruction: "tilt the card ~15° away from the light"
});
export type Rejection = z.infer<typeof Rejection>;

// Centering: a measurement, not an opinion. Ratios are left/top share in percent,
// e.g. lr = 52 means 52/48 left/right.
export const SideCentering = z.object({
  lr: z.number(),
  tb: z.number(),
  measurable: z.boolean(), // false for borderless / full-art
});
export type SideCentering = z.infer<typeof SideCentering>;

export const CenteringMeasurement = z.object({
  front: SideCentering,
  back: SideCentering.nullish(),
  // PSA standards: 10 requires ~60/40 or better front; 9 allows ~65/35 front.
  passesAt: z.object({ psa10: z.boolean(), psa9: z.boolean() }),
  overlayImageKey: z.string().nullish(), // annotated image showing measured border lines
});
export type CenteringMeasurement = z.infer<typeof CenteringMeasurement>;

export const Measurement = z.object({
  centering: CenteringMeasurement,
  confidence: z.object({ centering: z.number().min(0).max(1) }),
});
export type Measurement = z.infer<typeof Measurement>;

// What the OCR read off the card front (vision-service output)
export const OcrReading = z.object({
  nameCandidates: z.array(z.string()),
  collectorNumber: z.string().nullish(), // "031/064"
  setCode: z.string().nullish(), // "OP07-109" — exact id even on Japanese cards
  slab: z
    .object({
      company: z.string(), // PSA | BGS | CGC | ...
      gradeText: z.string(), // "GEM MT 10"
      certNumber: z.string().nullish(),
      // the label's own identification: year + set + collector number pins a
      // graded card exactly, without fuzzy name matching
      year: z.string().nullish(),
      setLine: z.string().nullish(), // "EX DRAGON FRONTIERS"
      cardNumber: z.string().nullish(), // "100"
      name: z.string().nullish(), // "CHARIZARD GOLD STAR HOLO R"
    })
    .nullish(),
  texts: z.array(z.string()),
  language: z.enum(["en", "ja", "unknown"]).default("unknown"),
  japaneseTextDetected: z.boolean().default(false),
});
export type OcrReading = z.infer<typeof OcrReading>;

// Catalog match (TCGdex), resolved by the API from the OCR reading
export const Identification = z.object({
  cardId: z.string(), // tcgdex id, e.g. "me05-031"
  name: z.string(),
  setId: z.string(),
  setName: z.string(),
  localId: z.string(),
  rarity: z.string().nullish(),
  imageUrl: z.string().nullish(), // official card render
  matchScore: z.number(), // 0..1 name-similarity of the accepted match
  ocrName: z.string(), // what we actually read, shown for honesty
  /** the catalog's own-language name, where it differs from the display
   *  name. A Japanese card is メガゲンガーex on the card and "Mega Gengar ex"
   *  everywhere it is bought and sold; a collector wants to see both. */
  nameLocal: z.string().nullish(),
  game: z.string().default("pokemon"), // pokemon | mtg | yugioh
});
export type Identification = z.infer<typeof Identification>;

export const GradedPrices = z.object({
  source: z.string(), // pokemonpricetracker | cardgrader | estimate
  psa8: z.number().nullish(),
  psa9: z.number().nullish(),
  psa10: z.number().nullish(),
  // true when these are model/multiplier estimates, NOT verified sales
  estimated: z.boolean().default(false),
  // for source "web-search": the pages each figure was read from and
  // re-verified against. Empty for API-sourced prices.
  citations: z.array(z.object({ label: z.string(), url: z.string() })).nullish(),
});
export type GradedPrices = z.infer<typeof GradedPrices>;

/** Prices keyed by grading company, then by grade.
 *
 *  The flat psa8/psa9/psa10 shape above cannot express "we hold PSA sales but
 *  no Beckett sales", so a BGS 8.5 was silently read off the PSA 8 column.
 *  This keeps each grader's data separate, which lets the UI show a Beckett
 *  tab that honestly says "no data" instead of PSA numbers under a BGS badge.
 *
 *  Shape: { PSA: { "8": 14299, "9": 15125, "10": 58723 } }
 */
/** One grade's worth of market evidence.
 *
 *  A bare number hides how much is behind it. The same "price" can be the
 *  median of 400 sales or a single anecdote, and the reader cannot tell. Both
 *  the sample size and the provider's own confidence travel with the figure.
 */
export const GradePoint = z.object({
  price: z.number(),
  /** how many completed sales the figure is drawn from */
  count: z.number().nullish(),
  /** the source's own rating of the figure */
  confidence: z.enum(["high", "medium", "low"]).nullish(),
  /** e.g. "90day_filtered_weighted" — how the source computed it */
  method: z.string().nullish(),
  /** raw spread of the underlying sales, before filtering */
  low: z.number().nullish(),
  high: z.number().nullish(),
  /** unfiltered median, kept so a filtered figure can be sanity-checked */
  median: z.number().nullish(),
  /** when WE fetched this figure, ISO-8601.
   *
   *  A price carries confidence and sample size already; this is the third
   *  leg. Without it a figure cached six days ago renders identically to one
   *  fetched a second ago, and the reader has no way to tell — which for a
   *  market that moves on a weekly cadence is the difference between evidence
   *  and a rumour. Null means the figure came straight from the source in this
   *  request. */
  asOf: z.string().nullish(),
  /** True when the source does not separate label variants and this figure
   *  therefore BLENDS them.
   *
   *  Beckett's 10 is not one product. A gold-label "10 Pristine" and a Black
   *  Label 10 — all four subgrades exactly 10 — are different goods: the same
   *  Destined Rivals Mewtwo shows a blended BGS 10 median near $1,360 while
   *  Black Label copies sell between $12,700 and $14,300. A blended median is
   *  right for the gold label and off by a factor of ten for the black one,
   *  and nothing about the number itself says which you are looking at. */
  blended: z.boolean().nullish(),
});
export type GradePoint = z.infer<typeof GradePoint>;

export const PricesByGrader = z.record(
  z.string(),                    // grader: PSA | BGS | CGC | SGC | ...
  z.record(z.string(), GradePoint), // grade as written ("8", "9.5", "10")
);
export type PricesByGrader = z.infer<typeof PricesByGrader>;

export const Valuation = z.object({
  source: z.string(),
  updatedAt: z.string().nullish(),
  graded: GradedPrices.nullish(),
  // grader-separated prices; the flat `graded` above stays for now so older
  // callers keep working
  pricesByGrader: PricesByGrader.nullish(),
  // what the slab actually is, carried alongside so the UI never has to infer
  // a grader from a bare number
  slabGrader: z.string().nullish(),
  slabGrade: z.number().nullish(),
  /** The label variant printed on the holder: black | gold | pristine | gem.
   *
   *  Part of the price key, not decoration — see GradePoint.blended. The
   *  vision service reads it off the slab and it used to stop there. */
  slabLabelVariant: z.string().nullish(),
  /** Set when the price and the identification contradict each other badly
   *  enough that the identification is the likelier culprit — a slabbed card
   *  whose raw price is trivial is almost always a different printing sharing
   *  the collector number. Carries the explanation, and means: do not lead
   *  with the figure. */
  identificationSuspect: z.string().nullish(),
  /** Set when the asking market and our completed sales disagree by more than
   *  a normal ask premium. Either the market moved since our comps, or the
   *  comps are not all this card — a reader is served by being told, not by
   *  our quietly choosing one. */
  marketNote: z.string().nullish(),
  /** The figure for THIS holder — this card, this company, this grade.
   *
   *  Carries how it was reached, because "a sale of this exact slab" and "a
   *  ratio measured across nine other cards" are both useful and must never
   *  look alike. `basis` says which. A modelled figure always arrives low
   *  confidence and with an interval. */
  slabPrice: z
    .object({
      price: z.number(),
      low: z.number().nullish(),
      high: z.number().nullish(),
      sampleSize: z.number().nullish(),
      confidence: z.enum(["high", "medium", "low"]),
      basis: z.enum([
        "observed",
        "same-grader-interpolated",
        "same-grader-nearest",
        "modelled-cross-grader",
        "ask-over-suspect-sale",
      ]),
      method: z.string(),
      /** one sentence for the "how this number was reached" list */
      explain: z.string(),
      /** the figure failed a plausibility check and must not be led with */
      suspect: z.boolean().nullish(),
      suspectReason: z.string().nullish(),
    })
    .nullish(),
  /** printing/variant as the catalog names it: Holofoil, Reverse Holofoil… */
  variant: z.string().nullish(),
  /** Median LIVE ASKING price for this card at THIS grader and grade, from
   *  current eBay listings. Populated only where we hold no sold comps at the
   *  card's grade — an ask is weaker evidence than a sale and never displaces
   *  one. It exists because the alternative was quoting a $2 raw price for a
   *  slab the market is asking $1,100 for, which is the worse error by far. */
  liveAsk: z
    .object({
      median: z.number(),
      low: z.number().nullish(),
      high: z.number().nullish(),
      /** listings behind the median, and how many matched the search overall */
      count: z.number(),
      total: z.number(),
      /** null on a raw card priced from listings because its printing is not
       *  what the catalog quotes — an SP treatment, a manga art, a parallel */
      grader: z.string().nullish(),
      grade: z.number().nullish(),
      /** true when these asks are for an UNGRADED copy */
      raw: z.boolean().default(false),
      /** the printing these figures are for — a card number is not a product */
      printing: z.string().nullish(),
      /** cheapest ask that has stood unsold long enough to prove the market is
       *  below it, and how many days it has stood */
      staleCeiling: z.number().nullish(),
      staleCeilingDays: z.number().nullish(),
      /** true when that ceiling pulled the headline figure down */
      cappedByStale: z.boolean().default(false),
      /** printings of the same number we excluded, with their asking ranges */
      otherPrintings: z
        .array(z.object({
          name: z.string(), count: z.number(), low: z.number(), high: z.number(),
        }))
        .default([]),
    })
    .nullish(),
  // market price × condition multiplier derived from the grade estimate —
  // what THIS copy is plausibly worth raw, not a near-mint copy
  conditionAdjusted: z
    .object({ value: z.number(), multiplier: z.number() })
    .nullish(),
  // last-resort raw price read off public web pages by the grounded LLM
  // lookup. NOT a pricing API: our own reading of cited pages, every figure
  // re-checked against the page it came from. Always shown as an estimate.
  webEstimate: z
    .object({
      value: z.number(),
      sampleSize: z.number(),
      citations: z.array(z.object({ label: z.string(), url: z.string() })),
    })
    .nullish(),
  tcgplayer: z
    .object({
      unit: z.string(),
      variant: z.string(), // holofoil | normal | reverseHolofoil
      low: z.number().nullish(),
      mid: z.number().nullish(),
      high: z.number().nullish(),
      market: z.number().nullish(),
    })
    .nullish(),
  cardmarket: z
    .object({
      unit: z.string(),
      low: z.number().nullish(),
      trend: z.number().nullish(),
      avg30: z.number().nullish(),
    })
    .nullish(),
});
export type Valuation = z.infer<typeof Valuation>;

export const Subgrade = z.object({
  value: z.number(),
  confidence: z.number().min(0).max(1),
});
export type Subgrade = z.infer<typeof Subgrade>;

export const Grade = z.object({
  overall: z.number(),
  band: z.object({ low: z.number(), high: z.number() }),
  subgrades: z.object({
    // null = honestly not assessable on this card (full-bleed art, etc.)
    centering: Subgrade.nullish(),
    corners: Subgrade.nullish(),
    edges: Subgrade.nullish(),
    surface: Subgrade,
  }),
  findings: z
    .object({
      scratchesDetected: z.boolean(),
      clusterCount: z.number(),
      clusters: z.array(
        z.object({
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          areaPx: z.number(),
        }),
      ),
      defectFrac: z.number(),
    })
    .nullish(),
  method: z.string(), // "heuristic-v0" until trained analyzers land
  notes: z.array(z.string()),
});
export type Grade = z.infer<typeof Grade>;

export const Origin = z.object({
  language: z.enum(["en", "ja", "unknown"]),
  japaneseTextDetected: z.boolean(),
  note: z.string(),
});
export type Origin = z.infer<typeof Origin>;

export const Recommendation = z.object({
  verdict: z.enum(["grade", "dont_grade", "insufficient_data"]),
  reasoning: z.string(),
  gradingCost: z.number(),
  rawValue: z.number().nullish(),
  likelyGrade: z.string().nullish(), // "PSA 9"
  rows: z.array(
    z.object({
      grade: z.string(), // "PSA 10"
      value: z.number().nullish(),
      net: z.number().nullish(), // value - raw - grading cost
      inBand: z.boolean(), // falls inside the estimated grade band
    }),
  ),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const Authenticity = z.object({
  digitalLikely: z.boolean(),
  noiseFloor: z.number(),
});
export type Authenticity = z.infer<typeof Authenticity>;

export const ScanStatus = z.enum(["captured", "processing", "rejected", "analyzed", "failed"]);
export type ScanStatus = z.infer<typeof ScanStatus>;

export const Scan = z.object({
  id: z.string(),
  status: ScanStatus,
  createdAt: z.string(),
  captures: z.array(Capture),
  rejection: Rejection.nullish(),
  backRejection: Rejection.nullish(), // back photo failed the gate; front result stands
  measurement: Measurement.nullish(),
  grade: Grade.nullish(),
  authenticity: Authenticity.nullish(),
  identification: Identification.nullish(),
  valuation: Valuation.nullish(),
  origin: Origin.nullish(),
  recommendation: Recommendation.nullish(),
  // what OCR read as possible names — shown when no catalog match is found
  ocrNames: z.array(z.string()).nullish(),
  // human-readable condition summary composed from the measurements
  summary: z.string().nullish(),
  // sibling cards from the same set, with live prices (free catalog APIs)
  related: z
    .array(
      z.object({
        name: z.string(),
        localId: z.string(),
        imageUrl: z.string().nullish(),
        price: z.number().nullish(),
        unit: z.string(),
      }),
    )
    .nullish(),
  // detected grading-company slab (card is already professionally graded)
  slab: z
    .object({
      company: z.string(),
      gradeText: z.string(),
      certNumber: z.string().nullish(),
      verifyUrl: z.string().nullish(),
    })
    .nullish(),
});
export type Scan = z.infer<typeof Scan>;

// ---------------------------------------------------------------------------
// Vision service HTTP contract (api -> vision)
// ---------------------------------------------------------------------------

export const VisionAnalyzeResponse = z.object({
  ok: z.boolean(),
  quality: CaptureQuality.nullish(),
  rejection: Rejection.nullish(),
  measurement: Measurement.nullish(),
  grade: Grade.nullish(),
  authenticity: Authenticity.nullish(),
  ocr: OcrReading.nullish(), // present when a card was detected (front only)
  warpedImageB64: z.string().nullish(), // canonical 750x1050 crop, png
  overlayImageB64: z.string().nullish(), // centering annotation, png
});
export type VisionAnalyzeResponse = z.infer<typeof VisionAnalyzeResponse>;
