import type { Identification, OcrReading, Valuation } from "@grailcard/shared";
import { normaliseVisionUrl } from "./visionurl.js";

const TCGDEX = process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en";
const MIN_MATCH_SCORE = 0.6;

type TcgdexBrief = { id: string; localId: string; name: string; image?: string };

/** Dice coefficient on character bigrams — tolerant of OCR mangling. */
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const norm = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const set = new Map<string, number>();
    for (let i = 0; i < norm.length - 1; i++) {
      const bg = norm.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [bg, n] of A) {
    overlap += Math.min(n, B.get(bg) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function querySeeds(ocr: OcrReading): string[] {
  const seeds = new Set<string>();
  for (const name of ocr.nameCandidates.slice(0, 2)) {
    seeds.add(name);
    for (const token of name.split(/\s+/)) {
      if (token.length >= 4) seeds.add(token);
    }
  }
  return [...seeds].slice(0, 5);
}

const VISION_URL = normaliseVisionUrl(process.env.VISION_URL);

/** dHash the scanned card against candidate catalog images (vision service). */
async function visualScores(
  warpedImageB64: string,
  urls: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const form = new FormData();
    // As a FILE, not a form field: starlette caps a non-file part at 1 MB and a
    // warped card is several times that, so every one of these was rejected as a
    // malformed body before the service saw it.
    form.append("file", new Blob([Buffer.from(warpedImageB64, "base64")]), "card.png");
    form.append("urls", JSON.stringify(urls));
    const res = await fetch(`${VISION_URL}/similarity`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      scores: { url: string; similarity: number | null }[];
    };
    for (const s of data.scores) {
      if (s.similarity != null) out.set(s.url, s.similarity);
    }
  } catch {
    /* visual verification is best-effort */
  }
  return out;
}

export async function identifyCard(
  ocr: OcrReading,
  warpedImageB64?: string | null,
): Promise<{ identification: Identification; valuation: Valuation | null } | null> {
  if (ocr.nameCandidates.length === 0) return null;
  const names = ocr.nameCandidates.slice(0, 3);
  const collectorLocalId = ocr.collectorNumber
    ? String(Number(ocr.collectorNumber.split("/")[0]))
    : null;

  const candidates = new Map<string, { card: TcgdexBrief; score: number; ocrName: string }>();
  for (const seed of querySeeds(ocr)) {
    const list = (await fetchJson(
      `${TCGDEX}/cards?name=${encodeURIComponent(seed)}`,
    )) as TcgdexBrief[] | null;
    if (!list) continue;
    for (const card of list) {
      // OCR ordering is unreliable — score against every candidate name
      let score = -1;
      let matchedName = names[0];
      for (const n of names) {
        const s = similarity(n, card.name);
        if (s > score) {
          score = s;
          matchedName = n;
        }
      }
      if (collectorLocalId && String(Number(card.localId)) === collectorLocalId) {
        score += 0.2;
      }
      const prev = candidates.get(card.id);
      if (!prev || score > prev.score) {
        candidates.set(card.id, { card, score, ocrName: matchedName });
      }
    }
  }

  // tie-break equal scores toward the more specific (longer) card name —
  // "Charizard" exact-matches dozens of cards; "Mega Charizard X ex" is
  // nearly unique
  let ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score || b.card.name.length - a.card.name.length)
    .slice(0, 5);

  // visual cross-check: dHash the scan against the top candidates' images.
  // Confirms the name match and separates same-name cards from different sets.
  let bestVisual: number | null = null;
  if (warpedImageB64 && ranked.length > 0) {
    const urlOf = (c: TcgdexBrief) => (c.image ? `${c.image}/low.png` : null);
    const urls = ranked.map((r) => urlOf(r.card)).filter((u): u is string => !!u);
    const visual = await visualScores(warpedImageB64, urls);
    if (visual.size > 0) {
      ranked = ranked
        .map((r) => {
          const url = urlOf(r.card);
          const sim = url ? visual.get(url) : undefined;
          return sim == null ? r : { ...r, score: 0.7 * r.score + 0.3 * sim, visual: sim };
        })
        .sort((a, b) => b.score - a.score);
      bestVisual = (ranked[0] as any).visual ?? null;
    }
  }

  const best = ranked[0] ?? null;
  if (!best || best.score < MIN_MATCH_SCORE) return null;
  // a partial name hit ("LARA" -> Pokemon's "Klara") whose image looks
  // NOTHING like the candidate is a false positive, not a match
  if (bestVisual != null && bestVisual < 0.55 && best.score < 0.9) return null;
  // without visual confirmation, even an exact name match isn't certainty —
  // cap the score so the LLM arbitration downstream gets a look
  if (bestVisual == null) best.score = Math.min(best.score, 0.85);

  return buildFromCardId(best.card.id, best.ocrName, Math.min(best.score, 1), best.card);
}

/** Fetch a catalog card by id and shape it into our identification +
 *  valuation contract. Shared by the name-match path and the slab-label path. */
async function buildFromCardId(
  cardId: string,
  ocrName: string,
  matchScore: number,
  brief?: TcgdexBrief,
): Promise<{ identification: Identification; valuation: Valuation | null } | null> {
  const detail = (await fetchJson(`${TCGDEX}/cards/${cardId}`)) as {
    name?: string;
    set?: { id: string; name: string };
    rarity?: string;
    localId?: string | number;
    image?: string;
    pricing?: {
      cardmarket?: {
        updated?: string;
        unit?: string;
        low?: number;
        trend?: number;
        avg30?: number;
      };
      tcgplayer?: { unit?: string; updated?: string } & Record<string, unknown>;
    };
  } | null;

  const name = brief?.name ?? detail?.name;
  if (!name) return null;
  const identification: Identification = {
    cardId,
    name,
    setId: detail?.set?.id ?? cardId.split("-")[0],
    setName: detail?.set?.name ?? "",
    localId: String(detail?.localId ?? brief?.localId ?? ""),
    rarity: detail?.rarity ?? null,
    imageUrl: (detail?.image ?? brief?.image)
      ? `${detail?.image ?? brief?.image}/high.png`
      : null,
    matchScore,
    ocrName,
    game: "pokemon",
  };

  let valuation: Valuation | null = null;
  const pricing = detail?.pricing;
  if (pricing) {
    // tcgplayer nests prices per print variant; take the first present
    let tcgplayer: Valuation["tcgplayer"] = null;
    const tp = pricing.tcgplayer;
    if (tp) {
      for (const variant of ["holofoil", "normal", "reverseHolofoil", "1stEditionHolofoil"]) {
        const v = tp[variant] as
          | { lowPrice?: number; midPrice?: number; highPrice?: number; marketPrice?: number }
          | undefined;
        if (v) {
          tcgplayer = {
            unit: tp.unit ?? "USD",
            variant,
            low: v.lowPrice ?? null,
            mid: v.midPrice ?? null,
            high: v.highPrice ?? null,
            market: v.marketPrice ?? null,
          };
          break;
        }
      }
    }
    const cm = pricing.cardmarket;
    valuation = {
      source: "tcgdex",
      updatedAt: pricing.cardmarket?.updated ?? pricing.tcgplayer?.updated ?? null,
      tcgplayer,
      cardmarket: cm
        ? {
            unit: cm.unit ?? "EUR",
            low: cm.low ?? null,
            trend: cm.trend ?? null,
            avg30: cm.avg30 ?? null,
          }
        : null,
    };
  }

  return { identification, valuation };
}

// ---------------------------------------------------------------------------
// Slab-label identification
//
// A graded card ships with its own answer key: the label prints the year, the
// set, and the collector number. Set + number resolves to exactly one card, so
// this path skips name fuzzy-matching entirely — which is what previously let
// "Charizard Star" (EX Dragon Frontiers #100, a four-figure card) match
// "Charizard VSTAR" (Brilliant Stars #018, a $13 card).
// ---------------------------------------------------------------------------

type TcgdexSet = { id: string; name: string; cardCount?: { total?: number } };

let setsCache: { at: number; sets: TcgdexSet[] } | null = null;
const SETS_TTL_MS = 24 * 3600 * 1000;

async function allSets(): Promise<TcgdexSet[]> {
  if (setsCache && Date.now() - setsCache.at < SETS_TTL_MS) return setsCache.sets;
  const list = (await fetchJson(`${TCGDEX}/sets`)) as TcgdexSet[] | null;
  if (!list || list.length === 0) return setsCache?.sets ?? [];
  setsCache = { at: Date.now(), sets: list };
  return list;
}

// Grading companies name vintage sets their own way — PSA calls Base Set
// "POKEMON GAME". Only the ones no amount of fuzzy matching will reach.
const SET_ALIASES: Record<string, string> = {
  "pokemon game": "Base Set",
  game: "Base Set",
  "base set shadowless": "Base Set",
  "pokemon jungle": "Jungle",
  "pokemon fossil": "Fossil",
  "pokemon team rocket": "Team Rocket",
  "pokemon base set 2": "Base Set 2",
  "pokemon gym heroes": "Gym Heroes",
  "pokemon gym challenge": "Gym Challenge",
  "pokemon neo genesis": "Neo Genesis",
  "pokemon neo discovery": "Neo Discovery",
  "pokemon neo revelation": "Neo Revelation",
  "pokemon neo destiny": "Neo Destiny",
};

/** Label set text -> the variants worth matching against catalog set names.
 *  Grading labels prefix the game and the era ("POKEMON SWSH BRILLIANT
 *  STARS"); the catalog names just the set ("Brilliant Stars"). */
function setLineVariants(raw: string): string[] {
  const base = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s{2,}/g, " ").trim();
  const out = new Set<string>([base]);
  const alias = SET_ALIASES[base];
  if (alias) out.add(alias.toLowerCase());
  // peel leading era/game prefixes one at a time: "pokemon swsh brilliant
  // stars" -> "swsh brilliant stars" -> "brilliant stars"
  let cur = base;
  for (let i = 0; i < 3; i++) {
    // \s* not \s+: slab OCR routinely loses the spaces between label words
    // ("2006 EX DRAGON FRONTIERS" -> "EXOGONFRONTIERS"), and without peeling
    // the era prefix the set never clears the match threshold.
    const next = cur.replace(/^(pokemon|pkmn|tcg|swsh|sm|xy|bw|hgss|dp|ex|sv)\s*/, "");
    if (next === cur) break;
    cur = next;
    out.add(cur);
    if (SET_ALIASES[cur]) out.add(SET_ALIASES[cur].toLowerCase());
  }
  return [...out].filter((s) => s.length >= 3);
}

/** Identify a graded card from its slab label. Returns null unless the set is
 *  confidently resolved AND the collector number exists in it — a wrong card
 *  at four figures is far worse than no answer. */
export async function identifyFromSlabLabel(label: {
  setLine?: string | null;
  setCandidates?: string[] | null;
  cardNumber?: string | null;
  year?: string | null;
  name?: string | null;
}): Promise<{ identification: Identification; valuation: Valuation | null } | null> {
  // Which printed line carries the SET varies by label, so the reader hands us
  // every plausible one and we score them all against the real catalogue. On a
  // PSA label reading "2002 POKEMON / CHARIZARD-REV.FOIL / LEGENDARY
  // COLLECTION", the year-bearing line yields only "POKEMON" — matching that
  // alone put a Legendary Collection Charizard in Dragon Frontiers.
  const lines = [
    ...(label.setCandidates ?? []),
    ...(label.setLine ? [label.setLine] : []),
  ].filter(Boolean);
  if (lines.length === 0 || (!label.cardNumber && !label.name)) return null;
  const sets = await allSets();
  if (sets.length === 0) return null;

  let bestSet: TcgdexSet | null = null;
  let bestScore = 0;
  for (const line of lines) {
    for (const v of setLineVariants(line)) {
      for (const set of sets) {
        const s = similarity(v, set.name);
        if (s > bestScore) {
          bestScore = s;
          bestSet = set;
        }
      }
    }
  }
  if (!bestSet || bestScore < 0.72) return null;

  const detail = (await fetchJson(`${TCGDEX}/sets/${bestSet.id}`)) as {
    cards?: TcgdexBrief[];
  } | null;
  const cards = detail?.cards ?? [];
  let card: TcgdexBrief | undefined;
  if (label.cardNumber) {
    const wanted = String(Number(String(label.cardNumber).split("/")[0]));
    card = cards.find((c) => String(Number(String(c.localId).split("/")[0])) === wanted);
  } else if (label.name) {
    // no number on the label: the set still narrows the field from ~20,000
    // cards to a few hundred, where a name match is trustworthy
    let bestName = 0;
    for (const c of cards) {
      const sc = similarity(label.name, c.name);
      if (sc > bestName) {
        bestName = sc;
        card = c;
      }
    }
    if (bestName < 0.55) card = undefined;
  }
  if (!card) return null;

  // the label named a card too — if it disagrees flatly with the catalog entry,
  // the set match was probably wrong. Refuse rather than guess.
  //
  // But a collector number inside a confidently-matched set IS the answer key,
  // and grading labels print the name in a condensed font that OCR shreds
  // ("#100 CHARIZARD DS HOLO R" comes back as "#100CHAF" + "ARDDSHOLOR"). A
  // garbled name fragment must not veto an exact number hit — doing so dropped
  // a $58k Dragon Frontiers Gold Star back to fuzzy face-name matching, which
  // scores "Charizard Star δ" HIGHER against "Charizard VSTAR" (0.88) than
  // against the real card (0.80), and priced it at $15.
  if (label.name) {
    const nameScore = similarity(label.name, card.name);
    if (nameScore < 0.25) {
      const numberMatched = Boolean(label.cardNumber);
      if (!numberMatched || bestScore < 0.8) {
        console.warn(
          `[slab] ${bestSet.name} #${card.localId} is "${card.name}" but label reads "${label.name}" — rejecting`,
        );
        return null;
      }
      console.warn(
        `[slab] label name "${label.name}" is unreadable (${nameScore.toFixed(2)} vs "${card.name}"), ` +
          `but set "${bestSet.name}" matched ${bestScore.toFixed(2)} and #${card.localId} is exact — trusting the number`,
      );
    }
  }

  const built = await buildFromCardId(card.id, label.name ?? card.name, 0.97);
  if (built) {
    console.log(
      `[slab] ${lines.length} label line(s) -> set "${bestSet.name}" (${bestScore.toFixed(2)}), #${card.localId} -> ${card.id} (${card.name})`,
    );
  }
  return built;
}
