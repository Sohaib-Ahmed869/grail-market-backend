import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { rankedCandidates } from "./candidates.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Identification, Scan, VisionAnalyzeResponse } from "@grailcard/shared";
import { db } from "../db.js";
import { identifyApiTcg } from "./apitcg.js";
import { fetchWebPrices } from "./geminiprice.js";
import { normaliseVisionUrl } from "./visionurl.js";
import { fetchCardGraderMarket } from "./cardgrader.js";
import { identifyWithGemini } from "./gemini.js";
import { fetchJustTcgPrice } from "./justtcg.js";
import type { GradePoint } from "./gradedprices.js";
import { gradedPricesFor, priceForSlab, estimateForSlab } from "./pricing.js";
import { findInversions, soldVsAsk, gradeIsInverted } from "./ladder.js";
import { fetchListings } from "./ebaylistings.js";
import { readPrinting } from "./printing.js";
import { readSetCode, readOnePieceCode, identifyBySetCode, isSealedProduct } from "./setcode.js";
import { recordScan, recordWeakResult, withScan } from "./ledger.js";
import { graderTier } from "./graders.js";
import { labelTokens, rawGradedDivergence } from "./labeltokens.js";
import { visionGate, GateSaturated } from "./gate.js";
import {
  writeGradePrices,
  readGradePrices,
  noteCatalogCard,
  readRawPrice,
  writeRawPrice,
} from "../cards.store.js";

import {
  identifyDigimon,
  identifyLorcana,
  identifyOnePiece,
  identifyScryfall,
  identifySwu,
  identifyYgo,
} from "./othergames.js";
import { buildRecommendation } from "./recommend.js";
import { similarity } from "./similarity.js";
import { fetchRelated } from "./related.js";
import { buildSummary } from "./summarize.js";
import { identifyCard, identifyFromSlabLabel } from "./tcgdex.js";

const BRAND_HINTS: [RegExp, string][] = [
  [/top\s*trumps/i, "Top Trumps"],
  [/topps/i, "Topps"],
  [/panini/i, "Panini"],
  [/upper\s*deck/i, "Upper Deck"],
  [/marvel/i, "Marvel"],
  [/fleer/i, "Fleer"],
];

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s-])[a-z]/g, (m) => m.toUpperCase());
}

const VISION_URL = normaliseVisionUrl(process.env.VISION_URL);
const STORAGE_ROOT = join(process.cwd(), "storage");


@Injectable()
export class ScansService {
  async createFromUpload(
    front: Express.Multer.File,
    back?: Express.Multer.File,
  ): Promise<Scan> {
    // Everything below runs inside a context that collects what each provider
    // charged, so the ledger records a real cost rather than an assumed one.
    //
    // The ledger write happens HERE, where every path converges, rather than
    // beside the final return. runScan returns early for an already-graded
    // slab, and putting the write next to one of two returns counted one scan
    // in three — which is precisely the drift this was meant to end.
    return withScan(async (scanId) => {
      const scan = await this.runScan(scanId, front, back);
      const v = scan.valuation;
      const sold =
        v?.slabGrader && v?.slabGrade != null
          ? v.pricesByGrader?.[v.slabGrader]?.[String(v.slabGrade).replace(/\.0$/, "")]?.price ??
            null
          : null;
      // not awaited: worth counting, never worth delaying the answer for
      void recordScan({
        id: scanId,
        outcome:
          scan.status === "rejected"
            ? "rejected"
            : scan.identification
              ? "identified"
              : "failed",
        cardName: scan.identification?.name ?? null,
        setName: scan.identification?.setName ?? null,
        cardNumber: scan.identification?.localId ?? null,
        grader: v?.slabGrader ?? null,
        grade: v?.slabGrade ?? null,
        priceUsd: sold ?? v?.liveAsk?.median ?? v?.tcgplayer?.market ?? null,
        priceSource: sold ? "sold" : v?.liveAsk ? "ask" : v?.tcgplayer?.market ? "catalog" : null,
      });

      // House rule: every result below MEDIUM confidence goes in the backlog,
      // with its inputs. A weak answer is indistinguishable from a strong one
      // from the outside, so without this the only bad cases we ever learn
      // about are the ones somebody complains about — which is a terrible
      // sample for a system whose promise is that it would rather say nothing
      // than say something wrong. Each row should be enough to rebuild the
      // case as a fixture.
      // A general check that needs no list of printing names: nobody pays to
      // grade a card worth 65 cents. When the raw price of the card we
      // identified is trivial and the graded market for it is not, we are
      // almost certainly looking at a different printing that shares the
      // collector number — which is how a $615 PSA Magazine Exclusive Luffy
      // came to be priced as a $0.65 OP05-060 Leader.
      const divergence = rawGradedDivergence(
        v?.tcgplayer?.market ?? v?.cardmarket?.trend ?? null,
        sold ?? v?.liveAsk?.median ?? null,
      );
      if (divergence.suspect) {
        if (scan.valuation) {
          scan.valuation.identificationSuspect = divergence.reason;
        }
        void recordWeakResult({
          scanId,
          reason: "raw-graded-divergence",
          cardName: scan.identification?.name ?? null,
          setName: scan.identification?.setName ?? null,
          catalogId: scan.identification?.cardId ?? null,
          grader: v?.slabGrader ?? null,
          grade: v?.slabGrade ?? null,
          confidence: "low",
          priceUsd: sold ?? v?.liveAsk?.median ?? null,
          priceSource: "suspect",
          inputs: {
            rawUsd: v?.tcgplayer?.market ?? v?.cardmarket?.trend ?? null,
            ratio: divergence.ratio,
            reason: divergence.reason,
            ocrNames: scan.ocrNames ?? [],
          },
        });
        console.warn(`[identify] ${divergence.reason}`);
      }

      // The card's own grade ladder contradicting itself, and the asking
      // market contradicting our sold comps. Both are visible from the numbers
      // alone and both mean the figure is shakier than its confidence says.
      const ownGrades = v?.slabGrader ? v?.pricesByGrader?.[v.slabGrader] : null;
      const inversions = ownGrades ? findInversions(ownGrades) : [];
      if (inversions.length) {
        const i = inversions[0];
        console.warn(
          `[ladder] ${v!.slabGrader} ${i.higher} (${i.higherPrice.toFixed(0)}) is below ` +
            `${v!.slabGrader} ${i.lower} (${i.lowerPrice.toFixed(0)}) — thin or contaminated comps`,
        );
        void recordWeakResult({
          scanId, reason: "grade-ladder-inverted",
          cardName: scan.identification?.name ?? null,
          setName: scan.identification?.setName ?? null,
          catalogId: scan.identification?.cardId ?? null,
          grader: v?.slabGrader ?? null, grade: v?.slabGrade ?? null,
          confidence: "low", priceUsd: sold ?? null, priceSource: "sold",
          inputs: { inversions },
        });
      }
      const askGap = soldVsAsk(sold, v?.liveAsk?.median ?? null);
      if (askGap.diverged) {
        if (scan.valuation) scan.valuation.marketNote = askGap.note;
        void recordWeakResult({
          scanId, reason: "sold-ask-divergence",
          cardName: scan.identification?.name ?? null,
          setName: scan.identification?.setName ?? null,
          catalogId: scan.identification?.cardId ?? null,
          grader: v?.slabGrader ?? null, grade: v?.slabGrade ?? null,
          confidence: "low", priceUsd: sold ?? null, priceSource: "sold",
          inputs: { askMedian: v?.liveAsk?.median ?? null, ratio: askGap.ratio },
        });
      }

      const weak = classifyWeakness(scan, sold);
      if (weak) {
        void recordWeakResult({
          scanId,
          reason: weak.reason,
          cardName: scan.identification?.name ?? null,
          setName: scan.identification?.setName ?? null,
          cardNumber: scan.identification?.localId ?? null,
          catalogId: scan.identification?.cardId ?? null,
          game: scan.identification?.game ?? null,
          grader: v?.slabGrader ?? null,
          grade: v?.slabGrade ?? null,
          confidence: weak.confidence,
          sampleSize: weak.sampleSize,
          priceUsd: sold ?? v?.liveAsk?.median ?? v?.tcgplayer?.market ?? null,
          priceSource: sold ? "sold" : v?.liveAsk ? "ask" : v?.tcgplayer?.market ? "catalog" : null,
          inputs: {
            status: scan.status,
            rejection: scan.rejection?.reason ?? null,
            ocrNames: scan.ocrNames ?? [],
            matchScore: scan.identification?.matchScore ?? null,
            valuationSource: v?.source ?? null,
            gradersHeld: v?.pricesByGrader ? Object.keys(v.pricesByGrader) : [],
            estimated: v?.graded?.estimated ?? null,
            hasWebEstimate: Boolean(v?.webEstimate),
          },
        });
      }
      return scan;
    });
  }

  private async runScan(
    scanId: string,
    front: Express.Multer.File,
    back?: Express.Multer.File,
  ): Promise<Scan> {
    const id = scanId;
    const createdAt = new Date().toISOString();
    // free text gathered along the way that might name this copy's printing
    const printingHints: string[] = [];
    // printed identity read off the label and the card face, needed again at
    // pricing time to build a search that does not depend on a clean name
    let codeRead: ReturnType<typeof readSetCode> = null;
    let slabLines: (string | null | undefined)[] = [];
    let sealed = false;
    /** "SP" where One Piece printed its Special treatment flush against the
     *  card number. The plain SR of OP07-085 asks $2; the SP asks $130. */
    let treatment: string | null = null;
    const dir = join(STORAGE_ROOT, id);
    mkdirSync(dir, { recursive: true });

    const frontKey = `${id}/front.jpg`;
    writeFileSync(join(STORAGE_ROOT, frontKey), front.buffer);
    if (back) {
      writeFileSync(join(STORAGE_ROOT, `${id}/back.jpg`), back.buffer);
    }

    const [frontRes, backRes] = await Promise.all([
      this.analyze(front, "front"),
      back ? this.analyze(back, "back") : Promise.resolve(null),
    ]);

    const scan: Scan = {
      id,
      status: frontRes.ok ? "analyzed" : "rejected",
      createdAt,
      captures: [
        { kind: "front", imageKey: frontKey, quality: frontRes.quality ?? null },
        ...(back
          ? [
              {
                kind: "back" as const,
                imageKey: `${id}/back.jpg`,
                quality: backRes?.quality ?? null,
              },
            ]
          : []),
      ],
      rejection: frontRes.rejection ?? null,
      backRejection: backRes?.rejection ?? null,
      measurement: frontRes.measurement ?? null,
      grade: frontRes.grade ?? null,
      authenticity: frontRes.authenticity ?? null,
      identification: null,
      valuation: null,
      origin: frontRes.ocr
        ? {
            language: frontRes.ocr.language ?? "unknown",
            japaneseTextDetected: frontRes.ocr.japaneseTextDetected ?? false,
            note: frontRes.ocr.japaneseTextDetected
              ? "Japanese text detected on the card — this is (or includes) a Japanese-language printing."
              : (frontRes.ocr.language ?? "unknown") === "en"
                ? "Rules text reads as English — treated as an English-language printing. Stylized art lettering (which can be Japanese on promos) is not part of this call."
                : "Card language could not be determined from the photo.",
          }
        : null,
      recommendation: null,
    };


    // identification runs even for rejected fronts — a bad photo can still
    // tell the user which card we saw (and what it's worth). All supported
    // game catalogs are searched in parallel; the best match wins.
    if (frontRes.ocr) {
    // Grading furniture is not a card name, and the guard for that already
    // existed — it was just never applied here. "GEM MT" arrives from OCR as
    // the glued run "GEMMT", lands first in nameCandidates, and a Crocodile
    // Offline Regional Finalist was published as a card called "Gemmt". A
    // search for "Gemmt PSA 10" returns Pokemon Gym cards and a Pau Gasol.
      scan.ocrNames = (frontRes.ocr.nameCandidates ?? []).filter(
        (n) => !NOT_A_NAME.some((re) => re.test(String(n).trim())),
      );
      // Every scrap of text that might name the PRINTING. The card number does
      // not identify a product — OP13-119 is four products — so the printing
      // has to come from somewhere else: the slab label (Beckett prints the
      // variant), the card's own text, and the vision model's read of the art.
      printingHints.push(...(frontRes.ocr.texts ?? []).map(String));
      if (/(?:^|[^A-Z])SP\s*(?:OP|ST|EB|PRB)\d{2}/i.test((frontRes.ocr.texts ?? []).join(" "))) {
        treatment = "SP";
        // stated as its own token so the printing matcher can see it: glued to
        // the number as "SPOP07-085SR" there is no word boundary to match on
        printingHints.push("SP");
      }
      if (frontRes.ocr.slab) {
        const L = frontRes.ocr.slab as Record<string, any>;
        printingHints.push(
          ...[L.setLine, L.name, L.gradeText, ...(L.setCandidates ?? [])]
            .filter(Boolean)
            .map(String),
        );
      }
      const names = scan.ocrNames.slice(0, 3);

      // A graded slab carries its own answer key: the label prints the set and
      // the collector number, which resolve to exactly one card. That beats
      // fuzzy name matching outright — name matching is what let a $970
      // "Charizard Star" resolve to a $13 "Charizard VSTAR".
      if (frontRes.ocr.slab) {
        const L = frontRes.ocr.slab;
        console.log(
          `[slab-label] ${L.company} ${L.gradeText} | year=${L.year ?? "-"} | set=${L.setLine ?? "-"} | num=${L.cardNumber ?? "-"} | name=${L.name ?? "-"}`,
        );
      }
      // A printed SET CODE outranks everything below it. "M2a", "SV8a" and the
      // "110/080 SAR" on the card face are exact identifiers, not names to be
      // scored: the set either exists at that id or it does not. Matching names
      // instead is what put a Japanese Mega Charizard X ex SAR — M2 #110, about
      // A$1,500 — into the English set Phantasmal Flames as #013 Double Rare,
      // a $5 card, and then priced it there with a straight face.
      codeRead = readSetCode([
        ...(frontRes.ocr.texts ?? []).map(String),
        ...(frontRes.ocr.slab
          ? [
              (frontRes.ocr.slab as any).setLine,
              (frontRes.ocr.slab as any).name,
              ...((frontRes.ocr.slab as any).setCandidates ?? []),
            ].filter(Boolean).map(String)
          : []),
      ]);
      let codeMatch = codeRead
        ? await identifyBySetCode(
            codeRead,
            (frontRes.ocr.slab as any)?.cardNumber ?? null,
            labelDisplayName(frontRes.ocr.slab as any),
          )
        : null;
      // The catalog names Japanese cards in Japanese ("メガゲンガーex") and the
      // label prints them in a condensed font OCR returns glued together
      // ("MEGAGENGAReX"). Neither is searchable: every sold comp and every
      // listing for this card is written in English, so a Japanese or
      // run-together name finds nothing and the card ends up with no price at
      // all despite being identified exactly right.
      if (codeMatch && needsEnglishName(codeMatch.name)) {
        const en = await identifyWithGemini(
          front.buffer.toString("base64"),
          front.mimetype,
        );
        if (en?.printing) printingHints.push(en.printing);
        if (en?.name && !needsEnglishName(en.name)) {
          codeMatch = { ...codeMatch, name: en.name, ocrName: codeMatch.ocrName };
        }
      }
      if (codeRead) {
        console.log(
          `[set-code] ${codeRead.code} ${codeRead.printedNumber ?? codeRead.number ?? "?"} ` +
            `${codeRead.rarity ?? ""} -> ${codeMatch?.cardId ?? "unresolved"}`,
        );
      }

      // A sealed pack is a product, not a card. Nothing below this point can
      // identify one — there is no collector number and no catalog entry — and
      // trying produced card #1 of Jungle from the "1ST" in "1ST EDITION".
      slabLines = frontRes.ocr.slab
        ? [
            (frontRes.ocr.slab as any).setLine,
            (frontRes.ocr.slab as any).name,
            ...((frontRes.ocr.slab as any).setCandidates ?? []),
          ]
        : [];
      sealed = isSealedProduct(slabLines);
      const sealedMatch =
        sealed && frontRes.ocr.slab
          ? { identification: sealedIdentification(frontRes.ocr.slab as any), valuation: null }
          : null;
      if (sealed) console.log(`[sealed] ${slabLines.filter(Boolean).join(" | ")}`);

      const labelMatch = sealedMatch
        ? sealedMatch
        : codeMatch
          ? { identification: codeMatch, valuation: null }
          : frontRes.ocr.slab
            ? await identifyFromSlabLabel(frontRes.ocr.slab)
            : null;

      const matches = labelMatch
        ? [labelMatch]
        : (
        await Promise.all([
          identifyCard(frontRes.ocr, frontRes.warpedImageB64),
          identifyScryfall(names),
          identifyYgo(names),
          identifyOnePiece(
            // vision's setCode reader is Pokemon-Japanese; the One Piece number
            // is on the card face and needs its own, O-for-zero tolerant read
            frontRes.ocr.setCode ?? readOnePieceCode(frontRes.ocr.texts ?? []),
            frontRes.warpedImageB64,
          ),
          identifyLorcana(names),
          identifyDigimon(names),
          identifySwu(names),
          identifyApiTcg(names),
        ])
      ).filter((m): m is NonNullable<typeof m> => m != null);
      matches.sort((a, b) => b.identification.matchScore - a.identification.matchScore);
      let match = matches[0];

      // arbitration: anything short of a near-certain catalog match
      // ("LARA" -> Pokemon's "Klara" scored 0.86) gets a second opinion from
      // the vision LLM; a different game verdict means false positive — drop it
      if (match && match.identification.matchScore < 0.93) {
        const opinion = await identifyWithGemini(
          front.buffer.toString("base64"),
          front.mimetype,
        );
        if (opinion?.printing) printingHints.push(opinion.printing);
        if (opinion?.edition) printingHints.push(opinion.edition);
        if (opinion && opinion.game !== match.identification.game) {
          match = undefined as unknown as typeof match;
          scan.identification = {
            cardId: "llm",
            name: opinion.name,
            setId: "",
            setName:
              [opinion.setName, opinion.edition].filter(Boolean).join(" · ") || "Unknown set",
            localId: "",
            rarity: null,
            imageUrl: null,
            matchScore: 0.6,
            ocrName: names[0] ?? "(from image)",
            game: opinion.game,
          };
        } else if (
          opinion &&
          opinion.game === match.identification.game &&
          opinion.setName &&
          match.identification.setName &&
          similarity(opinion.name, match.identification.name) >= 0.75 &&
          similarity(opinion.setName, match.identification.setName) < 0.45
        ) {
          // same card name but the LLM sees a different SET — same-name cards
          // across sets differ in value by orders of magnitude (Base Set
          // Charizard vs Dragon Frontiers Charizard). The catalog row is the
          // wrong printing: keep the LLM identity, honest and price-less.
          match = undefined as unknown as typeof match;
          scan.identification = {
            cardId: "llm",
            name: opinion.name,
            setId: "",
            setName:
              [opinion.setName, opinion.edition].filter(Boolean).join(" · ") || "Unknown set",
            localId: "",
            rarity: null,
            imageUrl: null,
            matchScore: 0.6,
            ocrName: names[0] ?? "(from image)",
            game: opinion.game,
          };
        } else if (
          opinion &&
          opinion.game === match.identification.game &&
          similarity(opinion.name, match.identification.name) < 0.75
        ) {
          // same game but a very different card name: OCR fragments matched
          // the wrong card (generic "Charizard" beating "Mega Charizard X ex").
          // Redo the catalog lookup with the LLM's full name.
          const redoOcr = {
            nameCandidates: [opinion.name],
            collectorNumber: frontRes.ocr.collectorNumber ?? null,
            setCode: frontRes.ocr.setCode ?? null,
            texts: frontRes.ocr.texts ?? [],
            language: (frontRes.ocr.language ?? "unknown") as "en" | "ja" | "unknown",
            japaneseTextDetected: frontRes.ocr.japaneseTextDetected ?? false,
          };
          const redo =
            opinion.game === "pokemon"
              ? await identifyCard(redoOcr, frontRes.warpedImageB64)
              : opinion.game === "mtg"
                ? await identifyScryfall([opinion.name])
                : opinion.game === "yugioh"
                  ? await identifyYgo([opinion.name])
                  : opinion.game === "lorcana"
                    ? await identifyLorcana([opinion.name])
                    : null;
          if (redo) match = redo;
        } else if (!opinion && match.identification.matchScore < 0.72) {
          // no second opinion available and the match is weak — asserting it
          // would be guessing. Fall through to the described-from-text path.
          match = undefined as unknown as typeof match;
        }
        // the vision LLM reads Japanese art text the OCR model can't — its
        // language verdict outranks the OCR-based origin guess
        if (opinion?.language === "ja" && scan.origin) {
          scan.origin = {
            language: "ja",
            japaneseTextDetected: true,
            note: "Japanese text identified on the card by AI vision — this is (or includes) a Japanese-language printing.",
          };
        }
      }

      if (match) {
        scan.identification = match.identification;
        scan.valuation = match.valuation;
        // Keep the ones we did not choose. They cost nothing — every catalogue
        // was already asked — and they are the only way somebody can correct a
        // wrong pick without rescanning and getting the same wrong pick.
        scan.candidates = rankedCandidates(matches, match);
      } else if (!scan.identification) {
        // catalogs failed — ask the vision LLM to NAME the card (identification
        // only, never condition or price). If it names a catalog-supported
        // game, loop the name back through the real catalog for verified data.
        const llm = await identifyWithGemini(front.buffer.toString("base64"), front.mimetype);
        if (llm) {
          if (llm.printing) printingHints.push(llm.printing);
          if (llm.edition) printingHints.push(llm.edition);
          const pseudoOcr = {
            nameCandidates: [llm.name],
            collectorNumber: frontRes.ocr.collectorNumber ?? null,
            setCode: frontRes.ocr.setCode ?? null,
            texts: frontRes.ocr.texts ?? [],
            language: (frontRes.ocr.language ?? "unknown") as "en" | "ja" | "unknown",
            japaneseTextDetected: frontRes.ocr.japaneseTextDetected ?? false,
          };
          const verified =
            llm.game === "pokemon"
              ? await identifyCard(pseudoOcr, frontRes.warpedImageB64)
              : llm.game === "mtg"
                ? await identifyScryfall([llm.name])
                : llm.game === "yugioh"
                  ? await identifyYgo([llm.name])
                  : llm.game === "lorcana"
                    ? await identifyLorcana([llm.name])
                    : llm.game === "digimon"
                      ? await identifyDigimon([llm.name])
                      : llm.game === "starwars"
                        ? await identifySwu([llm.name])
                        : null;
          if (verified) {
            scan.identification = verified.identification;
            scan.valuation = verified.valuation;
          } else {
            scan.identification = {
              cardId: "llm",
              name: llm.name,
              setId: "",
              setName: [llm.setName, llm.edition].filter(Boolean).join(" · ") || "Unknown set",
              localId: "",
              rarity: null,
              imageUrl: null,
              matchScore: 0.6,
              ocrName: names[0] ?? "(from image)",
              game: llm.game,
            };
          }
        }
      }
      if (!scan.identification && names.length > 0) {
        // no catalog knows this card — describe it from what's printed on it,
        // clearly labeled as such (matchScore 0 = described, not matched)
        const allText = (frontRes.ocr.texts ?? []).join(" ");
        const brands = BRAND_HINTS.filter(([re]) => re.test(allText)).map(([, b]) => b);
        // name banners are usually caps, and person/card names are usually
        // multi-word — prefer multi-word caps over single logo words
        // A long unbroken run of capitals is a LABEL line, not a card name.
        // OCR glues a label's condensed font into things like
        // "OFFLINEREGIONALFINALISTV2"; a character name off the card face
        // comes through as an ordinary word. Preferring the short candidate is
        // what separates "Crocodile" from the product line printed above it.
        const pick = pickDescribedName(names);
        scan.identification = {
          cardId: "described",
          name: titleCase(pick),
          setId: "",
          setName: brands.join(" ") || "Unknown set",
          localId: "",
          rarity: null,
          imageUrl: null,
          matchScore: 0,
          ocrName: names[0],
          game: "other",
        };
      }
    }

    // PPT graded + raw prices for the identification that actually survived.
    //
    // This runs ONCE here rather than inside a single identification branch.
    // It used to live in the `if (match)` arm only, so a card identified via
    // the vision-LLM fallback (catalogs return 0 matches on a cropped or
    // glare-heavy photo, then the LLM names it and we re-verify against the
    // catalog) reached the page with a correct card ID and no prices at all —
    // the same Gold Star priced fine from its slab photo and blank from a
    // hand-held one.
    // A photo we declined does not get priced.
    //
    // Identification still runs above, because naming the card helps someone
    // retake the shot. Pricing is different: every source below costs money,
    // and the answer would be built on a read we have already said we do not
    // trust. On a blurry PSA slab that produced a raw-card price for a $94,000
    // Championship Finalist — the grade is the whole value of a slab, and a
    // grade we could not see is not a grade we can price around.
    //
    // Cheaper too, which is the smaller point: a rejected scan now spends
    // nothing at any provider.
    if (frontRes.rejection) {
      console.warn(
        `[scan] ${frontRes.rejection.reason} — not pricing; ` +
          `identification kept for context only`,
      );
      return scan;
    }

    let pptByGrade: Record<string, GradePoint> | null = null;
    let pptByGrader: Record<string, Record<string, GradePoint>> | null = null;
    const ident = scan.identification;

    // Register the card before pricing it, for EVERY game rather than just the
    // one we can price today. The refresh job's work list is this table, so a
    // card that is never registered is a card that never gets a batch price —
    // and the games with no price source right now are exactly the ones we
    // most want queued for when they get one.
    if (ident) {
      void noteCatalogCard({
        catalogId: ident.cardId,
        game: ident.game,
        name: ident.name,
        setName: ident.setName,
        cardNumber: ident.localId,
      });
    }

    if (
      ident &&
      ident.game === "pokemon" &&
      ident.cardId !== "llm" &&
      ident.cardId !== "described"
    ) {
      // Prices are READ from our own store first, and bought only when the
      // store cannot answer. The order lives in pricing.ts because the search
      // path needs exactly the same one — a scan and a search that land on the
      // same card must not quote two different figures for it.
      const looked = await gradedPricesFor({
        catalogId: ident.cardId,
        name: ident.name,
        number: ident.localId,
        setName: ident.setName,
      });
      pptByGrader = looked.byGrader;
      pptByGrade = looked.byGrade;

      if (pptByGrade) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        scan.valuation.graded = {
          source: looked.source === "store" ? "grailcard-store" : "pokemonpricetracker",
          psa8: pptByGrade["8"]?.price ?? null,
          psa9: pptByGrade["9"]?.price ?? null,
          psa10: pptByGrade["10"]?.price ?? null,
          estimated: false,
        };
      }
      // vintage sets often have NO price in the free catalogs — the ungraded
      // market price fills that gap
      if (looked.rawUsd != null && !scan.valuation?.tcgplayer?.market) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        scan.valuation.source =
          looked.source === "store" ? "grailcard-store" : "pokemonpricetracker";
        scan.valuation.tcgplayer = {
          unit: "USD", variant: "market",
          low: null, mid: null, high: null, market: looked.rawUsd,
        };
      }
    }

    // sibling cards from the same set with live prices (free, best-effort)
    if (scan.identification && scan.identification.cardId !== "described") {
      scan.related = await fetchRelated(scan.identification);
    }

    // price gap-fill: catalogs without prices (Digimon, Union Arena...) get
    // them from JustTCG when its free key is present
    if (scan.identification && !scan.valuation?.tcgplayer && !scan.valuation?.cardmarket) {
      const filled = await fetchJustTcgPrice(
        scan.identification.name,
        scan.identification.game,
        scan.identification.setName,
      );
      if (filled) scan.valuation = { ...filled, graded: scan.valuation?.graded ?? null };
    }

    // graded-price fallback chain: PPT sold data (above) -> CardGrader
    // market module (their eBay comps; costs a credit) -> multiplier
    // estimate from raw (always available, clearly labeled estimated).
    // Every card gets SOME graded picture, with its provenance stated.
    if (scan.identification && !scan.valuation?.graded) {
      const backup = await fetchCardGraderMarket(
        front.buffer.toString("base64"),
        `gc-market-${id}`,
      );
      if (backup) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        scan.valuation.graded = backup;
      }
    }
    // still nothing? read the open web: Gemini + Google Search reports prices
    // off pages it actually retrieved, and every figure is re-checked against
    // the page it cites before we keep it. Our own reading, not a price feed —
    // so it lands as `estimated` with its sources attached.
    if (
      scan.identification &&
      scan.identification.cardId !== "described" &&
      !scan.valuation?.graded
    ) {
      const web = await fetchWebPrices(scan.identification);
      if (web) {
        scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
        if (web.graded) {
          scan.valuation.graded = { ...web.graded, citations: web.citations };
        }
        if (web.rawUsd != null && web.rawUsd > 0) {
          scan.valuation.webEstimate = {
            value: web.rawUsd,
            sampleSize: web.sampleSize,
            citations: web.citations,
          };
        }
      }
    }

    // estimateGradedFromRaw is gone from the chain.
    //
    // It multiplied a raw price by a fixed constant to invent graded figures
    // where no sales existed. On a BGS 9.5 One Piece card that reported A$16.66
    // against a real market around A$1,750 — because our graded-price source
    // covers Pokemon only, so every One Piece, Magic, Yu-Gi-Oh and Lorcana card
    // fell through to the multiplier and got a number with no evidence behind
    // it whatsoever.
    //
    // Where we hold no sales for a card at its grade the correct answer is to
    // say so. The live listings panel still shows what the market is asking,
    // which is real data, and the interface names the gap instead of filling
    // it with arithmetic.
    // Separate the graded prices by the company that actually issued them.
    // Everything we can buy today is PSA sale data, so PSA is the only key that
    // gets populated — and that is precisely the point: a Beckett card now
    // shows an empty Beckett tab rather than PSA numbers wearing a BGS badge.
    // Separate the graded prices by the company that actually issued them.
    //
    // Gated on the per-grader data, NOT on valuation.graded. That flat field
    // carries psa8/psa9/psa10 and nothing else, so it is null for a card with
    // no PSA sales — and this whole block used to hang off it. A card with 23
    // Beckett sales and zero PSA sales therefore dropped every one of them and
    // persisted nothing, which is the failure this table exists to prevent,
    // arriving from the other direction.
    let byGrader: Record<string, Record<string, GradePoint>> =
      pptByGrader && Object.keys(pptByGrader).length ? { ...pptByGrader } : {};
    if (!Object.keys(byGrader).length && scan.valuation?.graded) {
      // no per-grade evidence, only the bare flat numbers — keep them, under
      // the grader that actually issued them
      const g = scan.valuation.graded;
      const psa: Record<string, GradePoint> = {};
      if (g.psa8 != null) psa["8"] = { price: g.psa8 };
      if (g.psa9 != null) psa["9"] = { price: g.psa9 };
      if (g.psa10 != null) psa["10"] = { price: g.psa10 };
      if (Object.keys(psa).length) byGrader = { PSA: psa };
    }

    if (Object.keys(byGrader).length > 0) {
      scan.valuation ??= { source: "tcgdex", tcgplayer: null, cardmarket: null };
      scan.valuation.pricesByGrader = byGrader;

      // Persist under the composite key so the grader survives storage. Until
      // this table existed the schema had psa8/psa9/psa10 columns and no
      // grader dimension at all, which is why a Beckett card could only ever
      // be shown a PSA figure — there was nowhere else to read one from.
      const catalogId = scan.identification?.cardId;
      if (catalogId && catalogId !== "llm" && catalogId !== "described") {
        const rows = Object.entries(byGrader).flatMap(([grader, grades]) =>
          Object.entries(grades).map(([grade, pt]) => ({ grader, grade, pt })),
        );
        void writeGradePrices(
          catalogId,
          rows.map(({ grader, grade, pt }) => ({
            grader,
            grade: Number(grade),
            tier: graderTier(grader),
            price: pt.price ?? null,
            sampleSize: pt.count ?? null,
            confidence: pt.confidence ?? null,
            method: pt.method ?? null,
            low: pt.low ?? null,
            high: pt.high ?? null,
            median: pt.median ?? null,
            source: scan.valuation?.graded?.source ?? "pokemonpricetracker",
          })),
        );
      }
    }

    // the grader and grade as read off the label, so the UI never re-derives
    // them from a display string
    const labelSlab = frontRes.ocr?.slab as
      | { grader?: string | null; grade?: number | null; label?: string | null }
      | undefined;
    // A card can be identified exactly and still have no price source: Japanese
    // Pokemon sets carry no TCGplayer or Cardmarket feed, and our graded-sales
    // provider is English-only. Everything downstream — the grader, the grade,
    // the asking-price fallback — hung off `valuation` being non-null, so those
    // cards silently skipped the entire pricing stage and showed nothing at all
    // despite us knowing precisely what they were.
    if (!scan.valuation && labelSlab?.grader) {
      scan.valuation = { source: "label", updatedAt: null };
    }
    if (scan.valuation && labelSlab?.grader) {
      scan.valuation.slabGrader = labelSlab.grader;
      scan.valuation.slabGrade = labelSlab.grade ?? null;
      scan.valuation.slabLabelVariant = labelSlab.label ?? null;

      // The figure for THIS holder, down the ladder: a sale at this exact
      // (company, grade) first; this company's own neighbouring grades next;
      // a measured cross-grader ratio only after that, labelled and with an
      // interval. Reaching for PSA first is what this replaces — a PSA 10 sale
      // is evidence about PSA 10 and about nothing else.
      const ladder = await priceForSlab(
        scan.valuation.pricesByGrader ?? null,
        labelSlab.grader,
        labelSlab.grade ?? null,
      );
      if (ladder) {
        scan.valuation.slabPrice = {
          price: ladder.price,
          low: ladder.low,
          high: ladder.high,
          sampleSize: ladder.sampleSize,
          confidence: ladder.confidence,
          basis: ladder.basis,
          method: ladder.method,
          explain: ladder.explain,
          suspect: ladder.suspect ?? null,
          suspectReason: ladder.suspectReason ?? null,
        };
        if (ladder.basis !== "observed" || ladder.suspect) {
          void recordWeakResult({
            scanId,
            reason: ladder.suspect ? "estimate-out-of-envelope" : `derived-${ladder.basis}`,
            cardName: scan.identification?.name ?? null,
            setName: scan.identification?.setName ?? null,
            catalogId: scan.identification?.cardId ?? null,
            grader: labelSlab.grader,
            grade: labelSlab.grade ?? null,
            confidence: ladder.confidence,
            sampleSize: ladder.sampleSize,
            priceUsd: ladder.price,
            priceSource: ladder.basis,
            inputs: { method: ladder.method, explain: ladder.explain, suspectReason: ladder.suspectReason ?? null },
          });
        }
      }

      // Beckett's 10 is not one product, and our source does not know that.
      //
      // A gold-label "10 Pristine" and a Black Label 10 — all four subgrades
      // exactly 10 — are different goods. PPT reports a single `bgs10` key
      // that blends them, so the median it gives is right for the gold label
      // and off by an order of magnitude for the black one: this very card
      // reports a blended BGS 10 of $1,364 while Black Label copies sell
      // between $12,700 and $14,300.
      //
      // We can read the black label off the holder — vision already does, from
      // four subgrades of 10 — and we cannot price it. So say exactly that.
      // Quoting the blended figure under a Black Label badge is the confident
      // wrong answer this system is supposed to refuse.
      const variant = labelSlab.label ?? null;
      const gradeKey = String(labelSlab.grade ?? "").replace(/\.0$/, "");
      const ownPoint =
        scan.valuation.pricesByGrader?.[labelSlab.grader]?.[gradeKey] ?? null;
      if (ownPoint && variant === "black") {
        ownPoint.blended = true;
        ownPoint.confidence = "low";
        void recordWeakResult({
          scanId,
          reason: "label-variant-unpriced",
          cardName: scan.identification?.name ?? null,
          setName: scan.identification?.setName ?? null,
          catalogId: scan.identification?.cardId ?? null,
          grader: labelSlab.grader,
          grade: labelSlab.grade ?? null,
          confidence: "low",
          sampleSize: ownPoint.count ?? null,
          priceUsd: ownPoint.price ?? null,
          priceSource: "sold-blended",
          inputs: {
            labelVariant: variant,
            note:
              "Black Label priced from a source that does not separate label " +
              "variants; the figure blends gold-label Pristine sales and understates it",
            subgrades: (frontRes.ocr?.slab as any)?.subgrades ?? null,
          },
        });
        console.warn(
          `[slab] ${labelSlab.grader} ${gradeKey} BLACK LABEL — our figure blends label variants and understates it`,
        );
      }
    }

    // Where we hold no SOLD comps at the card's own grade, fall back to what
    // the market is currently ASKING for the same slab.
    //
    // The alternative was quoting the raw price, and on a One Piece BGS 9.5 the
    // raw price is $1.99 while nine live listings for that exact card at that
    // exact grade sit between $109 and $2,374. Answering "$2.78" there is not
    // conservative, it is wrong by three orders of magnitude — and the evidence
    // contradicting it was already on the same screen, in our own listings
    // panel. An ask is weaker than a sale and is labelled as one, but it beats
    // a number drawn from a different market entirely.
    const askGrader = scan.valuation?.slabGrader ?? null;
    const askGrade = scan.valuation?.slabGrade ?? null;
    // A RAW card needs this too when it carries a special printing. TCGplayer
    // quotes the base print: the plain SR of OP07-085 is $1.90, and the SP
    // treatment of the identical card number is about $130. Quoting $1.90 for
    // the SP is the same error as quoting a raw price for a slab.
    // A raw card needs a card NUMBER before its listings mean anything. The
    // number is what makes a search specific; without it "Charizard Base Set
    // 1st Edition" matches a category, and a stale $8.95 listing in that
    // category capped a raw Base Set Charizard that TCGplayer prices at $489.
    const rawSpecialPrinting =
      !askGrader &&
      Boolean(readPrinting(printingHints.join(" ")).family) &&
      Boolean(scan.identification?.localId);
    // A slab with no NUMERIC grade still has a market.
    //
    // PSA "AUTHENTIC" is a designation, not a grade — the company verified the
    // card and declined to grade it. The gate here used to demand a number, so
    // an Authentic holder fetched no listings at all and the card came back
    // with no price and an empty listings panel, while eighty-odd copies of it
    // were listed on eBay at the time. A blank is the right answer when we
    // know nothing; it is the wrong answer when the asks are right there.
    const slabWithoutNumericGrade = Boolean(
      askGrader && askGrader !== "UNKNOWN" && askGrade == null,
    );
    if (
      scan.valuation &&
      ((askGrader && askGrader !== "UNKNOWN" && askGrade != null) ||
        slabWithoutNumericGrade ||
        rawSpecialPrinting)
    ) {
      const sold =
        askGrader && askGrade != null
          ? scan.valuation.pricesByGrader?.[askGrader]?.[String(askGrade)]?.price
          : null;
      // A recorded sale normally means the asking market is not needed. It is
      // not enough when that sale contradicts its own grade ladder.
      //
      // The Charizard Gold Star came back at BGS 8.5 = $10,500 sitting UNDER
      // the BGS 8 = $12,715 below it, while three BGS 8.5 copies were listed
      // at a A$24,153 median and the owner had been told 25-30k. The ladder
      // check that catches exactly this already existed in priceForSlab, and
      // could never once have fired: it needs the asks, and the asks were only
      // fetched when there was no sale to compare them against. A rule that
      // runs only where its input is absent by construction is dead code.
      //
      // Same condition as the search path in market.controller.ts, so a scan
      // and a search of one card cannot disagree about whether to look.
      const soldIsSuspect = Boolean(
        askGrader &&
          askGrade != null &&
          gradeIsInverted(scan.valuation.pricesByGrader?.[askGrader] ?? {}, askGrade),
      );
      const wantAsks = sold == null || soldIsSuspect;
      if (soldIsSuspect) {
        console.warn(
          `[ask] ${askGrader} ${askGrade} = ${sold} is below a lower grade in its own ladder — fetching asks to check it`,
        );
      }
      // What the label and the card print, over and above the name.
      const askTokens = [
        codeRead?.code,
        // For a card no catalogue knows, the label's own product line is the
        // only thing separating it from the ordinary print. "Crocodile" alone
        // is fifty listings; "Crocodile Offline Regional Finalist" is the card.
        scan.identification?.cardId === "described"
          ? (frontRes.ocr?.slab as any)?.name ?? null
          : null,
        // A rarity token only helps when it tells the printings apart. On a
        // Japanese Pokemon card "SAR" is exactly the discriminator; on this One
        // Piece card the base print and the SP treatment are BOTH "SR", so
        // adding it stopped discriminating and started skewing — the search
        // filled with $2 base copies and pushed the $130 SP ones out.
        codeRead?.rarity ??
          (readPrinting(printingHints.join(" ")).family
            ? null
            : rarityToken(scan.identification?.rarity)),
        // a One Piece treatment marker printed flush against the number
        treatment,
        // for a sealed pack the artwork IS the product: a Scyther Jungle pack
        // and a Wigglytuff Jungle pack are different things at different prices
        sealed ? sealedArtwork(slabLines) : null,
      ];

      // A name we cannot search with produces a search for something else. On a
      // Japanese Gengar the catalog name "メガゲンガーex" returned a $272 median
      // across $60-$1,390 of unrelated cards. Better to show no figure than a
      // confident one drawn from the wrong listings.
      // An unusable name is only fatal when nothing else identifies the card.
      // "240 M2a SAR PSA 10" finds the Gengar exactly without naming it, and
      // those tokens are what sellers put in their titles anyway.
      const hasPrintedId = Boolean(
        codeRead?.code || scan.identification?.localId || askTokens.filter(Boolean).length >= 2,
      );
      if (
        wantAsks &&
        scan.identification &&
        needsEnglishName(scan.identification.name) &&
        !hasPrintedId
      ) {
        console.warn(
          `[ask] no searchable name and no printed identifier for "${scan.identification.name}"`,
        );
      } else if (wantAsks && scan.identification) {
        try {
          // Which PRINTING is this copy? Nothing so far had to answer that:
          // the catalog match resolves a card NUMBER, and a number is not a
          // product. OP13-119 is sold as manga art, alternate art, parallel and
          // wanted-poster SP, asking $82 to $8,200 for the same three digits,
          // so pricing without the printing averages four different cards.
          //
          // The label and the card's own text usually do not name it — "manga
          // art" is a collector's term, not something printed on the card — so
          // where they come up empty we ask the vision model, which can see the
          // artwork. One extra call, spent only when it changes the answer.
          if (!readPrinting(printingHints.join(" ")).family) {
            const p = await identifyWithGemini(
              front.buffer.toString("base64"),
              front.mimetype,
            );
            if (p?.printing) printingHints.push(p.printing);
            if (p?.edition) printingHints.push(p.edition);
          }
          // An AUTHENTIC slab's comps are other AUTHENTIC slabs, so that word
          // is the discriminator here. It is passed explicitly because
          // labelTokens treats "AUTHENTIC" as grading furniture — which it is
          // on every other label, and is precisely not on this one.
          const qual = (labelSlab as any)?.qualifier
            ? String((labelSlab as any).qualifier).toUpperCase()
            : null;
          const askLabelTokens =
            slabWithoutNumericGrade && qual
              ? [qual]
              : labelTokens(
                  [
                    (frontRes.ocr?.slab as any)?.name,
                    (frontRes.ocr?.slab as any)?.setLine,
                    ...(((frontRes.ocr?.slab as any)?.setCandidates ?? []) as string[]),
                  ].filter(Boolean) as string[],
                  {
                    name: scan.identification?.name ?? null,
                    setName: scan.identification?.setName ?? null,
                  },
                );

          const live = await fetchListings({
            name: scan.identification.name,
            setName: scan.identification.setName,
            game: scan.identification.game ?? null,
            number: scan.identification.localId,
            grader: askGrader,
            grade: askGrade,
            // Beckett's 10 is two products; ask for the one on this holder.
            labelVariant:
              (labelSlab?.label === "black" || labelSlab?.label === "gold")
                ? labelSlab.label
                : null,
            // the words the grading company printed, so the asks can be
            // narrowed to THIS printing even when we cannot name it
            labelTokens: askLabelTokens,
            // An AUTHENTIC holder is normally an autograph, and its market is
            // other autographs — not other copies of the card number printed
            // on its face.
            designation: slabWithoutNumericGrade && qual === "AUTHENTIC" ? qual : null,
          });
          // filteredToGrade is the condition, not a nicety: an unfiltered median
          // mixes a PSA 10 ask into a BGS 8 valuation, which is the cross-grader
          // error this whole redesign exists to stop.
          // Grade filtering is required only when there IS a grade to filter
          // to. A raw card has none, and demanding it here meant the raw path
          // fetched its listings and then threw them away.
          // A gradeless slab needs SOME slab-to-slab filter before its median
          // means anything. Same grading company, or the same designation on
          // the label — either is enough; neither, and we would be quoting raw
          // copies for a card in a holder.
          const gradeOk =
            askGrader && askGrade != null
              ? live?.filteredToGrade
              : slabWithoutNumericGrade
                ? Boolean(live?.filteredToGrader || live?.filteredToLabelText)
                : true;
          if (live?.medianAsk != null && gradeOk) {
            scan.valuation.liveAsk = {
              median: live.medianAsk,
              low: live.askLow ?? null,
              high: live.askHigh ?? null,
              count: live.listings.length,
              total: live.total,
              grader: askGrader,
              grade: askGrade,
              printing: live.filteredToPrinting ? live.printing : null,
              raw: !askGrader,
              staleCeiling: live.staleCeiling,
              staleCeilingDays: live.staleCeilingDays,
              cappedByStale: live.cappedByStale,
              otherPrintings: live.otherPrintings,
            };

            // Re-run the ladder now that the asking market is known. It could
            // not be consulted the first time — asks are fetched well after
            // the graded figures — and it is the only thing that can overrule
            // a recorded sale which contradicts its own grade ladder.
            if (labelSlab?.grader && labelSlab.grade != null) {
              const withAsk = await priceForSlab(
                scan.valuation.pricesByGrader ?? null,
                labelSlab.grader,
                labelSlab.grade,
                {
                  median: live.medianAsk,
                  count: live.listings.length,
                  filteredToGrade: Boolean(live.filteredToGrade),
                },
              );
              // No recorded sale anywhere for this key — every non-Pokemon
              // card, today. Estimate it from the live listings, weighted, or
              // decline. docs/pricing-algorithm.md.
              if (!scan.valuation.slabPrice && live.listings.length) {
                const est = await estimateForSlab(live.listings, {
                  grader: labelSlab?.grader ?? null,
                  grade: labelSlab?.grade ?? null,
                  labelTokens: askLabelTokens,
                });
                if (est) {
                  scan.valuation.slabPrice = {
                    price: est.price, low: est.low, high: est.high,
                    sampleSize: est.sampleSize, confidence: est.confidence,
                    basis: est.basis, method: est.method, explain: est.explain,
                    suspect: null, suspectReason: null,
                  };
                  console.log(`[estimate] ${est.method} -> ${est.price.toFixed(2)}`);
                } else {
                  console.warn(
                    `[estimate] declined — listings for this card do not agree well ` +
                      `enough to price from`,
                  );
                }
              }

              if (withAsk && withAsk.basis === "ask-over-suspect-sale") {
                scan.valuation.slabPrice = {
                  price: withAsk.price,
                  low: withAsk.low,
                  high: withAsk.high,
                  sampleSize: withAsk.sampleSize,
                  confidence: withAsk.confidence,
                  basis: withAsk.basis,
                  method: withAsk.method,
                  explain: withAsk.explain,
                  suspect: withAsk.suspect ?? null,
                  suspectReason: withAsk.suspectReason ?? null,
                };
                console.warn(
                  `[ladder] ${labelSlab.grader} ${labelSlab.grade}: recorded sale ` +
                    `contradicts its own ladder — using the ${live.listings.length}-listing ask market instead`,
                );
              }
            }
          }
        } catch {
          // asks are a fallback; failing to get them is not a failed scan
        }
      }
    }

    // market prices are near-mint; adjust to THIS copy's estimated condition
    const nmPrice =
      scan.valuation?.tcgplayer?.market ??
      scan.valuation?.cardmarket?.trend ??
      scan.valuation?.webEstimate?.value;
    // conditionAdjusted is gone with the grade that produced it. Discounting a
    // market price by our own condition opinion turned an $84 card into $21 on
    // the strength of a 2.5 the heuristics should never have issued. Raw cards
    // are now quoted at the raw market price, which is what that price is.

    // a slabbed card is already professionally graded — say so, link the cert,
    // and mark our through-the-plastic estimate as non-authoritative
    const slab = frontRes.ocr?.slab;
    if (slab) {
      scan.slab = {
        company: slab.company,
        gradeText: slab.gradeText,
        certNumber: slab.certNumber ?? null,
        verifyUrl:
          slab.company === "PSA" && slab.certNumber
            ? `https://www.psacard.com/cert/${slab.certNumber}`
            : null,
      };
      scan.grade?.notes.unshift(
        `This card is in a ${slab.company} slab (label reads ${slab.gradeText}). ` +
          "Estimates below were made through the case plastic and are NOT authoritative — " +
          "the certified label grade takes precedence.",
      );
      // our through-plastic condition estimate must not discount a card whose
      // condition is CERTIFIED on the label — slab value ≠ raw value
      if (scan.valuation) scan.valuation.conditionAdjusted = null;
      scan.recommendation = {
        verdict: "dont_grade",
        reasoning:
          `Already professionally graded: ${slab.company} ${slab.gradeText}` +
          (slab.certNumber ? `, cert #${slab.certNumber}` : "") +
          ". There is no grading decision to make — the certified grade is the card's grade." +
          (scan.slab.verifyUrl ? " Verify the cert via the link above." : ""),
        gradingCost: 0,
        rawValue: scan.valuation?.tcgplayer?.market ?? null,
        likelyGrade: null,
        rows: [],
      };
      scan.summary = buildSummary(scan);
      db.prepare(
        "INSERT INTO scans (id, created_at, status, record) VALUES (?, ?, ?, ?)",
      ).run(id, createdAt, scan.status, JSON.stringify(scan));
      return scan;
    }

    scan.recommendation = buildRecommendation(scan.grade, scan.valuation);
    // a provisional grade from a gate-rejected photo must never drive a
    // grading decision — the money math needs a real grade first
    if (scan.status === "rejected" && scan.recommendation) {
      scan.recommendation = {
        verdict: "dont_grade",
        reasoning:
          "Don't act on this scan: the photo failed the quality gate, so the grade above is only a rough impression. " +
          "Re-shoot the card (closer, flat, even light) and decide from that scan.",
        gradingCost: scan.recommendation.gradingCost,
        rawValue: scan.recommendation.rawValue,
        likelyGrade: null,
        rows: [],
      };
    }
    scan.summary = buildSummary(scan);

    db.prepare(
      "INSERT INTO scans (id, created_at, status, record) VALUES (?, ?, ?, ?)",
    ).run(id, createdAt, scan.status, JSON.stringify(scan));

    return scan;
  }

  getById(id: string): Scan | null {
    const row = db.prepare("SELECT record FROM scans WHERE id = ?").get(id) as
      | { record: string }
      | undefined;
    return row ? (JSON.parse(row.record) as Scan) : null;
  }

  /** Choose one of the alternatives.
   *
   *  Never re-runs vision: the photograph has not changed, only our reading of
   *  it, and re-analysing would cost the vision box a slot to arrive at the
   *  same pixels. The candidate list is
   *  kept as it was so the choice can be changed again — a picker that
   *  disappears after one use is a picker you get one attempt at.
   *
   *  Nothing is fetched: each candidate already carries the valuation the
   *  catalogue that found it returned, so this is a swap. */
  pickCandidate(id: string, cardId: string): Scan | null {
    const scan = this.getById(id);
    if (!scan) return null;
    const pick = (scan.candidates ?? []).find(
      (c) =>
        c.identification.cardId === cardId ||
        `${c.identification.game}:${c.identification.name}` === cardId,
    );
    if (!pick) return null;

    scan.identification = pick.identification;
    scan.valuation = pick.valuation ?? null;
    // The summary quotes the identification, so it has to be rebuilt or the
    // page ends up describing the card the user just rejected.
    scan.summary = buildSummary(scan);

    db.prepare("UPDATE scans SET record = ? WHERE id = ?").run(JSON.stringify(scan), id);
    return scan;
  }

  listRecent(limit = 20): Scan[] {
    const rows = db
      .prepare("SELECT record FROM scans ORDER BY created_at DESC LIMIT ?")
      .all(limit) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as Scan);
  }

  private async analyze(
    file: Express.Multer.File,
    kind: "front" | "back",
  ): Promise<VisionAnalyzeResponse> {
    // Bounded, because the vision process is a single copy of a 350 MB model
    // and nothing else stands between it and however many people press the
    // button at once. Waiting for a slot is fine; waiting in an unbounded
    // queue is just a slower way to time out, so past a point we refuse.
    try {
      return await visionGate.run(() => this.callVision(file, kind));
    } catch (err) {
      if (err instanceof GateSaturated) {
        console.warn(`[vision] ${err.message}`);
        throw new ServiceUnavailableException(
          "too many scans in progress — try again in a moment",
        );
      }
      throw err;
    }
  }

  private async callVision(
    file: Express.Multer.File,
    kind: "front" | "back",
  ): Promise<VisionAnalyzeResponse> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname ?? `${kind}.jpg`,
    );
    form.append("kind", kind);

    let res: Response;
    try {
      res = await fetch(`${VISION_URL}/analyze`, { method: "POST", body: form });
    } catch {
      throw new ServiceUnavailableException(
        `vision service unreachable at ${VISION_URL}`,
      );
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(`vision service error ${res.status}`);
    }
    return (await res.json()) as VisionAnalyzeResponse;
  }
}

/** The English card name a grading label prints.
 *
 *  The label carries it in English even for a Japanese card — "MEGA GENGAR ex"
 *  over メガゲンガーex — which is what the owner sees through the case and what
 *  every seller writes. Reading it was previously limited to whichever single
 *  line the slab reader had guessed was the name, and on this card it guessed
 *  "SPECIALARTRARE", so the English name was lost and the display fell back to
 *  Japanese. Every label line is considered now, and the ones that are plainly
 *  not names are ruled out instead.
 */
export const NOT_A_NAME = [
  /^(SPECIAL|ILLUSTRATION|SPECIALART|ART)?\s*(ART)?\s*RARE$/i,   // rarity lines
  /^(GEM\s*MT|GEMMT|MINT|NM\s*MT|PRISTINE|BLACK\s*LABEL)/i,      // grade wording
  /^(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|WOTC)\b/i,                  // grader furniture
  // No \b after the year. A label's condensed font comes back from OCR with
  // the spaces gone, so the year line arrives as "2023ONEPIECEPROMO" — and
  // \b never matches between "3" and "O", both being word characters. The
  // rule read correctly and caught nothing on exactly the input it was for.
  /^\d{4}(?!\d)/,                                                // the year line
  /^\d+$/,                                                        // cert or number
  /\bJP\b|\bJAPANESE\b|\bENGLISH\b/i,                          // the set/language line
  /^(CENTERING|CORNERS|EDGES|SURFACE)/i,                          // Beckett subgrades
];

export function labelDisplayName(
  slab:
    | { name?: string | null; setCandidates?: string[] | null; setLine?: string | null }
    | null
    | undefined,
): string | null {
  const lines = [slab?.name, ...(slab?.setCandidates ?? [])]
    .filter((l): l is string => Boolean(l && l.trim().length >= 3))
    .map((l) => l.trim());

  const candidates = lines.filter((l) => {
    const flat = l.replace(/\s+/g, " ");
    if (NOT_A_NAME.some((re) => re.test(flat))) return false;
    // needs enough letters to be a name at all
    return [...flat].filter((c) => /[A-Za-z]/.test(c)).length >= 4;
  });
  if (candidates.length === 0) return null;

  // A card name carries the game's own suffixes; when one line does and the
  // others do not, that line is the name.
  const suffixed = candidates.find((c) => /(ex|gx|vmax|vstar|v)$/i.test(c.replace(/\s+/g, "")));
  const raw = suffixed ?? candidates[0];

  // Not a general de-compounder: splitting on case boundaries turns
  // "MEGACHARIZARDXeX" into "MEGACHARIZARD Xe X", which reads as a name, passes
  // the usability check, and finds nothing. Only the two boundaries Pokemon
  // names genuinely have are split — a known prefix and a known suffix — which
  // is enough to recover "MEGA GENGAR ex" from "MEGAGENGAReX" without guessing
  // where any other word begins.
  const split = raw
    .replace(/^(MEGA|DARK|SHINING|RADIANT|ORIGIN|PRIMAL)(?=[A-Z])/i, "$1 ")
    // the game's suffix comes off before the form letter, or "CHARIZARDXeX"
    // still ends in a letter and the form letter has nothing to detach from
    .replace(/(?<=[A-Za-z]{3})(vmax|vstar|ex|gx|v)$/i, " $1")
    // Mega Charizard X / Mega Mewtwo Y: the form letter is its own word, and
    // glued on it leaves "Charizardx", which is not a card
    .replace(/([A-Z]{5,})([XY])(?=\s|$)/, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!split) return null;

  // Labels are set in all caps. Displayed as-is that shouts, and it also hides
  // the convention that carries meaning: "ex" is lowercase on the card, "GX"
  // and "VMAX" are not. Judged on the ORIGINAL line — by this point the split
  // has already introduced lowercase of its own.
  // ...and ignoring the suffix when judging it, since "MEGAGENGAReX" carries a
  // lowercase e that has nothing to do with how the rest is set
  const stem = raw.replace(/(vmax|vstar|ex|gx|v)$/i, "");
  const shouted = stem === stem.toUpperCase();
  const cased = shouted
    ? split.replace(/[^\s.'-]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    : split;
  return cased
    .replace(/\b(ex)\b/gi, "ex")
    .replace(/\b(gx|vmax|vstar|sar|sr|ar|ur)\b/gi, (m) => m.toUpperCase())
    .trim();
}

/** Is this name unusable as a search term?
 *  Two ways it can be: written in a non-Latin script, or returned by OCR with
 *  the spaces missing. Both find zero listings on a marketplace whose sellers
 *  all write English. */
export function needsEnglishName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (/[^\u0000-\u007F]/.test(n)) return true;          // any non-ASCII script
  // A run-together name is one with NO separator at all. Punctuation counts as
  // a separator: "Portgas.D.Ace" is exactly how that card is written and eBay
  // finds it, whereas "MEGACHARIZARDXeX" is OCR losing the spaces.
  if (n.length > 12 && !/[\s.'’\-·&]/.test(n)) return true;
  return false;
}

/** Build an identification for a sealed product straight off the label.
 *  There is no catalog behind it, so the label IS the product record: year,
 *  set, and what kind of sealed thing it is. */
export function sealedIdentification(slab: {
  year?: string | null;
  setLine?: string | null;
  name?: string | null;
  setCandidates?: string[] | null;
}): Identification {
  // OCR returns these labels with the spaces gone ("JUNGLEFOILPACK"), and a
  // run-together name searches for nothing. The product words are a closed set,
  // so they can be split back out reliably rather than guessed at.
  const PRODUCT = /(FOIL\s*PACK|BOOSTER\s*PACK|BOOSTER\s*BOX|BLISTER|ELITE\s*TRAINER\s*BOX|ETB|PACK|BOX|TIN)/gi;
  const EDITION = /(1ST\s*EDITION|FIRST\s*EDITION|UNLIMITED|SHADOWLESS)/gi;
  const title = (w: string) =>
    w.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());

  const clean = (raw: string) =>
    raw
      .toUpperCase()
      // OCR reads the 1 of "1ST" as a capital I
      // OCR reads the 1 of "1ST" as a capital I, and the label glues the
      // words together, so a \b anchor here never fired: one scan of the
      // Jungle pack named it "1st Edition" and the next "Istedition",
      // which then priced against Unlimited packs — $1,400 and $1,000 for
      // the same photograph.
      .replace(/\bIST(?=\b|EDITION)/g, "1ST")
      .replace(/[-–]/g, " ")
      // normalise to the canonical spelling, so "JUNGLEFOILPACK" becomes
      // "JUNGLE FOIL PACK" rather than "JUNGLE FOILPACK"
      .replace(PRODUCT, (m) => ` ${m.replace(/\s+/g, "").replace(
        /^(FOILPACK|BOOSTERPACK|BOOSTERBOX|ELITETRAINERBOX)$/,
        (w) => ({ FOILPACK: "FOIL PACK", BOOSTERPACK: "BOOSTER PACK",
                  BOOSTERBOX: "BOOSTER BOX", ELITETRAINERBOX: "ELITE TRAINER BOX" }[w] ?? w),
      )} `)
      // normalise the match, not just space around it: "1STEDITION" left
      // as it stands is still one word and still unreadable
      .replace(EDITION, (m) => {
        const w = m.replace(/\s+/g, "");
        return ` ${{ "1STEDITION": "1ST EDITION", FIRSTEDITION: "1ST EDITION" }[w] ?? w} `;
      })
      .replace(/\s{2,}/g, " ")
      .trim();

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [slab.setLine, slab.name, ...(slab.setCandidates ?? [])]) {
    if (!raw) continue;
    for (const word of clean(String(raw)).split(" ")) {
      // drop the grading furniture and the noise lines
      if (!word || word.length < 2) continue;
      // the brand is supplied once by the caller; the label repeats it
      if (/^(GEM|MT|GEMMT|MINT|NM|PSA|BGS|CGC|SGC|WOTC|POKEMON|PKMN)$/.test(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      parts.push(word);
    }
  }
  // "1ST" alone reads as nothing; the label means 1st Edition. Only when the
  // word is not already there, or a label that spelled it out becomes
  // "1st Edition Edition".
  const hasEdition = parts.includes("EDITION");
  const words = parts.map((w) => (w === "1ST" && !hasEdition ? "1ST EDITION" : w));
  const name = title([slab.year, "Pokemon", ...words].filter(Boolean).join(" "))
    .replace(/\b1st\b/gi, "1st");
  return {
    cardId: "sealed",
    name,
    setId: "",
    setName: [slab.year, "sealed product"].filter(Boolean).join(" \u00b7 "),
    localId: "",
    rarity: null,
    imageUrl: null,
    matchScore: 1,
    ocrName: name,
    game: "pokemon",
  };
}

/** The short rarity code sellers actually write, from the catalog's long name.
 *  TCGdex says "Special illustration rare"; every eBay title says "SAR". */
export function rarityToken(rarity: string | null | undefined): string | null {
  const r = (rarity ?? "").toLowerCase();
  if (!r) return null;
  if (r.includes("special illustration")) return "SAR";
  if (r.includes("illustration")) return "AR";
  if (r.includes("hyper") || r.includes("ultra")) return "UR";
  if (/^(sar|csr|chr|ssr|rrr|ur|ar|sr|rr|sec|secret)$/i.test(rarity ?? "")) {
    return (rarity as string).toUpperCase();
  }
  return null;
}

/** The artwork named on a sealed pack's label.
 *  Packs from one set carry different cover art and are priced separately: a
 *  1999 Jungle Scyther pack and a Jungle Wigglytuff pack are not
 *  interchangeable. The label prints it — "1ST EDITION - SCYTHER". */
export function sealedArtwork(lines: (string | null | undefined)[]): string | null {
  for (const raw of lines) {
    if (!raw) continue;
    const m = /(?:1ST|IST|2ND|UNLIMITED|EDITION)[^A-Z]*[-\u2013]\s*([A-Z][A-Z ]{2,20})$/i.exec(
      String(raw).trim(),
    );
    if (m) return m[1].trim();
  }
  return null;
}

/** Is this answer weak enough to belong in the backlog, and why?
 *
 *  Ordered by severity: the worst thing we can do is not know what the card
 *  is, then to know the card and have no number for it, then to have a number
 *  we cannot stand behind. A confident answer from a real sale returns null
 *  and is never logged — the backlog is for work, not for volume.
 */
export function classifyWeakness(
  scan: { status?: string; identification?: unknown; valuation?: any },
  soldPrice: number | null,
): { reason: string; confidence: string | null; sampleSize: number | null } | null {
  if (scan.status === "rejected") return null; // a declined photo is not a weak answer
  if (!scan.identification) {
    return { reason: "no-identification", confidence: null, sampleSize: null };
  }

  const v = scan.valuation;
  const grader = v?.slabGrader ?? null;
  const grade = v?.slabGrade ?? null;
  const point =
    grader && grade != null
      ? v?.pricesByGrader?.[grader]?.[String(grade).replace(/\.0$/, "")] ?? null
      : null;

  const anyPrice = soldPrice ?? v?.liveAsk?.median ?? v?.tcgplayer?.market ?? null;
  if (anyPrice == null) {
    return { reason: "no-price", confidence: null, sampleSize: null };
  }

  // A slab we can name but hold no sales for at ITS grade. The number on
  // screen is an ask or a raw price standing in for a graded one, which is
  // exactly the substitution the grader-keyed model exists to prevent.
  if (grader && grade != null && soldPrice == null) {
    return { reason: "no-sales-at-grade", confidence: null, sampleSize: null };
  }

  if (v?.graded?.estimated || v?.webEstimate) {
    return { reason: "estimated-only", confidence: "low", sampleSize: null };
  }

  const confidence = point?.confidence ?? null;
  const sampleSize = point?.count ?? null;
  if (confidence === "low") return { reason: "low-confidence", confidence, sampleSize };
  // A median over three sales is arithmetic, not evidence.
  if (sampleSize != null && sampleSize < 5) {
    return { reason: "tiny-sample", confidence, sampleSize };
  }
  return null;
}


/** The best card name among OCR candidates, for a card no catalogue knows.
 *
 *  A long unbroken run of capitals is a LABEL line, not a card name. OCR glues
 *  a label's condensed font into runs like "OFFLINEREGIONALFINALISTV2", while
 *  a character name off the card face arrives as an ordinary word. Preferring
 *  the short candidate is what separates "Crocodile" from the product line
 *  printed above it — and grading furniture has already been filtered out of
 *  these by NOT_A_NAME before they get here.
 */
export function pickDescribedName(names: string[]): string {
  const notGlued = names.filter((n) => !/[A-Z0-9]{20,}/.test(String(n)));
  const pool = notGlued.length ? notGlued : names;
  const caps = pool.filter((n) => n === n.toUpperCase() && /[A-Z]{3,}/.test(n));
  return (
    caps.find((n) => n.trim().split(/\s+/).length >= 2) ?? caps[0] ?? pool[0] ?? names[0] ?? ""
  );
}
