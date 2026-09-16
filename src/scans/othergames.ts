import type { Identification, Valuation } from "@grailcard/shared";
import { bestAgainst, similarity } from "./similarity.js";
import { pickPrinting } from "./printingpicker.js";
import {
  readLorcanaPrinting, readMtgPrinting, readYgoSetCodes, ygoPrintingFor, ygoSetPrice,
} from "./printingproof.js";

const MIN_SCORE = 0.6;

export type CatalogMatch = {
  identification: Identification;
  valuation: Valuation | null;
};

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "grailcard/0.1" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Magic: The Gathering via Scryfall (free, no key).
 *
 *  The name search returns ONE default printing per card (unique=cards), and
 *  its price is that printing's. Orcish Bowmasters has six, from US$48 to
 *  US$193. So the printing comes from the set code and collector number read
 *  off the card, looked up exactly; without them the card is named and not
 *  priced. */
export async function identifyScryfall(
  names: string[],
  texts: readonly string[] = [],
): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const q = encodeURIComponent(names[0]);
  const body = (await fetchJson(
    `https://api.scryfall.com/cards/search?q=${q}&unique=cards&order=relevance`,
  )) as { data?: Record<string, any>[] } | null;
  const cards = body?.data ?? [];
  let best: { card: Record<string, any>; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const m = bestAgainst(names, card.name as string);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;

  // A set and number read off the card only count when a real card sits at
  // that address AND carries this name — card text is full of stray numbers.
  const proof = readMtgPrinting(texts);
  let printed: Record<string, any> | null = null;
  for (const set of proof.sets.slice(0, 2)) {
    for (const num of proof.numbers.slice(0, 3)) {
      const hit = (await fetchJson(
        `https://api.scryfall.com/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(num)}`,
      )) as Record<string, any> | null;
      if (hit?.name && similarity(String(hit.name), String(best.card.name)) >= 0.85) {
        printed = hit;
        break;
      }
    }
    if (printed) break;
  }
  if (!printed) {
    const c0 = best.card;
    return {
      identification: {
        cardId: `scryfall-${c0.id}`,
        name: c0.name,
        setId: "",
        setName: "",
        localId: "",
        rarity: null,
        imageUrl: null,
        matchScore: Math.min(best.score, 0.9),
        ocrName: best.name,
        game: "mtg",
        printingConfirmed: false,
        unconfirmedReason: "printing-not-read",
      },
      valuation: null,
    };
  }

  const c = printed;
  const identification: Identification = {
    cardId: `scryfall-${c.id}`,
    name: c.name,
    setId: c.set ?? "",
    setName: c.set_name ?? "",
    localId: String(c.collector_number ?? ""),
    rarity: c.rarity ?? null,
    imageUrl: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
    matchScore: Math.min(best.score, 1),
    ocrName: best.name,
    game: "mtg",
    printingConfirmed: true,
  };
  const usd = c.prices?.usd ? Number(c.prices.usd) : null;
  const eur = c.prices?.eur ? Number(c.prices.eur) : null;
  const valuation: Valuation | null =
    usd != null || eur != null
      ? {
          source: "scryfall",
          updatedAt: null,
          tcgplayer:
            usd != null
              ? { unit: "USD", variant: "normal", low: null, mid: null, high: null, market: usd }
              : null,
          cardmarket: eur != null ? { unit: "EUR", low: null, trend: eur, avg30: null } : null,
        }
      : null;
  return { identification, valuation };
}

/** Disney Lorcana via Lorcast (free, no key, includes USD prices).
 *
 *  Enchanted and promo printings share a name with the common one, so the
 *  printing comes from the collector line ("103/204 • EN • 5"); without it the
 *  card is named and not priced. */
export async function identifyLorcana(
  names: string[],
  texts: readonly string[] = [],
): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const body = (await fetchJson(
    `https://api.lorcast.com/v0/cards/search?q=${encodeURIComponent(names[0])}`,
  )) as any;
  const cards = (body?.results ?? []) as any[];
  let best: { card: any; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const full = [card.name, card.version].filter(Boolean).join(" ");
    const m = bestAgainst(names, full);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;
  const proof = readLorcanaPrinting(texts);
  const printed = proof
    ? cards.find((card) =>
        String(Number(card.collector_number)) === proof.number &&
        String(card.set?.code ?? "") === proof.setCode &&
        bestAgainst(names, [card.name, card.version].filter(Boolean).join(" ")).score >= MIN_SCORE)
    : null;
  if (!printed) {
    const c0 = best.card;
    return {
      identification: {
        cardId: `lorcana-${c0.id}`,
        name: [c0.name, c0.version].filter(Boolean).join(" — "),
        setId: "",
        setName: "",
        localId: "",
        rarity: null,
        imageUrl: null,
        matchScore: Math.min(best.score, 0.9),
        ocrName: best.name,
        game: "lorcana",
        printingConfirmed: false,
        unconfirmedReason: "printing-not-read",
      },
      valuation: null,
    };
  }
  const c = printed;
  const usd = c.prices?.usd ? Number(c.prices.usd) : null;
  return {
    identification: {
      cardId: `lorcana-${c.id}`,
      name: [c.name, c.version].filter(Boolean).join(" — "),
      setId: c.set?.code ?? "",
      setName: c.set?.name ?? "",
      localId: String(c.collector_number ?? ""),
      rarity: c.rarity ?? null,
      imageUrl: c.image_uris?.digital?.normal ?? c.image_uris?.digital?.small ?? null,
      matchScore: Math.min(best.score, 1),
      ocrName: best.name,
      game: "lorcana",
      printingConfirmed: true,
    },
    valuation:
      usd != null
        ? {
            source: "lorcast",
            updatedAt: null,
            tcgplayer: { unit: "USD", variant: "normal", low: null, mid: null, high: null, market: usd },
            cardmarket: null,
          }
        : null,
  };
}

/** Digimon Card Game via digimoncard.io (free, no key, no prices). The card
 *  code (BT1-001) is printed on the card; the printing counts as confirmed
 *  only when that code was read. */
export async function identifyDigimon(
  names: string[],
  texts: readonly string[] = [],
): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const body = await fetchJson(
    `https://digimoncard.io/api-public/search.php?n=${encodeURIComponent(names[0])}`,
  );
  const cards = (Array.isArray(body) ? body : []) as any[];
  let best: { card: any; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const m = bestAgainst(names, card.name as string);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;
  const c = best.card;
  return {
    identification: {
      cardId: `digimon-${c.id}`,
      name: c.name,
      setId: String(c.id ?? "").split("-")[0],
      setName: String(c.id ?? "").split("-")[0],
      localId: String(c.id ?? ""),
      rarity: c.rarity ?? null,
      imageUrl: c.id ? `https://images.digimoncard.io/images/cards/${c.id}.jpg` : null,
      matchScore: Math.min(best.score, 1),
      ocrName: best.name,
      game: "digimon",
      printingConfirmed: Boolean(c.id) &&
        texts.some((t) => String(t).toUpperCase().replace(/\s+/g, "").includes(String(c.id).toUpperCase())),
    },
    valuation: null,
  };
}

/** Star Wars: Unlimited via swu-db (free, no key, includes market prices). */
export async function identifySwu(names: string[]): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const body = (await fetchJson(
    `https://api.swu-db.com/cards/search?q=${encodeURIComponent(names[0])}`,
  )) as any;
  const cards = (body?.data ?? []) as any[];
  let best: { card: any; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const full = [card.Name, card.Subtitle].filter(Boolean).join(" ");
    const m = bestAgainst(names, full);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;
  const c = best.card;
  const market = c.MarketPrice != null ? Number(c.MarketPrice) : null;
  return {
    identification: {
      cardId: `swu-${c.Set}-${c.Number}`,
      name: [c.Name, c.Subtitle].filter(Boolean).join(" — "),
      setId: c.Set ?? "",
      setName: c.Set ?? "",
      localId: String(c.Number ?? ""),
      rarity: c.Rarity ?? null,
      imageUrl: c.FrontArt ?? null,
      matchScore: Math.min(best.score, 0.9),
      ocrName: best.name,
      game: "starwars",
      // Hyperspace and Showcase printings share the name and differ by
      // multiples in price, and nothing here reads which one this is.
      printingConfirmed: false,
      unconfirmedReason: "printing-not-read",
    },
    valuation: market != null && Number.isFinite(market) ? null : null,
  };
}

/** One Piece TCG via optcgapi (free, no key). Looked up by the set code
 *  printed on the card (e.g. OP07-109), which works even on Japanese
 *  printings where the name can't be OCR'd. */
export async function identifyOnePiece(
  setCode: string | null | undefined,
  warpedImageB64?: string | null,
  /** The printing image recognition matched (a card_image_id such as
   *  "OP07-085_p2"), when it was sure of it. Taken over the pairwise picker:
   *  recognition compared the card against every printing in the catalogue at
   *  once, where the picker only guesses between thumbnails. */
  pictured?: { imageId: string; lead: number | null } | null,
): Promise<CatalogMatch | null> {
  if (!setCode || !/^(OP|ST|EB|PRB)\d{2}-\d{3}$/i.test(setCode)) return null;
  const list = (await fetchJson(
    `https://optcgapi.com/api/sets/card/${encodeURIComponent(setCode.toUpperCase())}/`,
  )) as Record<string, any>[] | null;
  const printings = (list ?? []).filter((x) => x?.card_name);
  if (printings.length === 0) return null;

  // The number is shared; the artwork is not. This used to take printings[0]
  // unconditionally, so a Koby whose catalogue entry offers both the base art
  // and the Alternate Art resolved to whichever the API happened to list first
  // — the base, at $1.81, against about $10 for the card actually photographed.
  type OpPrinting = Record<string, any> & { imageUrl: string | null; label: string };
  const candidates: OpPrinting[] = printings.map((x) => ({
    ...x,
    imageUrl: (x.card_image as string | undefined) ?? null,
    label: String(x.card_name ?? ""),
  }));
  const picturedPick = pictured
    ? candidates.find((x) => String(x.card_image_id ?? x.card_set_id).toUpperCase() === pictured.imageId.toUpperCase())
    : undefined;
  const choice = picturedPick
    ? {
        pick: picturedPick,
        ranked: [picturedPick, ...candidates.filter((x) => x !== picturedPick)].map((x) => ({
          candidate: x, score: x === picturedPick ? 1 : null, imageUrl: x.imageUrl,
        })),
        method: "visual" as const,
        margin: pictured?.lead ?? null,
      }
    : await pickPrinting<OpPrinting>(candidates, warpedImageB64);
  const c: Record<string, any> = choice?.pick ?? printings[0];

  /* The ranking, carried rather than dropped.
   *
   * This used to keep `pick` and discard `ranked`, `method` and `margin`, so
   * everything downstream saw a name and nothing else. On a low-confidence
   * result that name is the BASE card's — the picker falls back to catalogue
   * order — and the app, re-deriving the printing by looking for a variant
   * word inside it, found none and asked the member. The system knew which
   * card it was and could not say so. */
  const printingChoice = choice
    ? {
        method: choice.method,
        margin: choice.margin ?? null,
        label: String(c.card_name ?? "") || null,
        ranked: choice.ranked.map((r) => ({
          label: String(r.candidate.card_name ?? r.candidate.label ?? ""),
          imageUrl: r.imageUrl ?? null,
          score: r.score ?? null,
        })),
      }
    : null;

  const identification: Identification = {
    // The printing has to be part of the id. Both printings of OP11-119 carry
    // the same card_set_id, so keying on that alone made them one card to every
    // cache and every price lookup downstream.
    // card_image_id distinguishes every printing; card_set_id does not.
    //
    // This used to append a bare "-p" when the image looked like a parallel,
    // which separated parallels from base prints and then lumped all FOUR
    // parallels of a card together — a $433 Wanted Poster and a $4,420 Red
    // Super Alternate Art under one id. Their own image id already says which
    // is which: OP13-119, _p1, _p2, _p3, _p4.
    cardId: `optcg-${c.card_image_id ?? c.card_set_id}`,
    name: String(c.card_name).replace(/\s*\((\d+)\)\s*/g, " ").replace(/\s{2,}/g, " ").trim(),
    setId: c.set_id ?? "",
    setName: c.set_name ?? "",
    localId: c.card_set_id ?? setCode,
    rarity: c.rarity ?? null,
    imageUrl: c.card_image ?? null,
    matchScore: 1, // exact set-code match
    ocrName: setCode.toUpperCase(),
    game: "onepiece",
    printingChoice,
  };
  const market = c.market_price != null ? Number(c.market_price) : null;

  // A printing we did not actually choose must not be priced as if we had.
  //
  // `pickPrinting` is honest when the picture does not settle it: it reports
  // `method: "fallback"` and keeps the catalogue's order. But the catalogue's
  // order is the BASE printing first, so the fallback pick is systematically
  // the cheapest one — and pricing it produced a US$0.87 figure for the
  // photographed Kaido OP17-062 Super Alternate Art, which is US$235. A 270x
  // understatement, delivered with no hint that anything was uncertain.
  //
  // That is the house rule exactly backwards: a missing answer is cheap, a
  // confident wrong answer is expensive. The ranked list is already carried
  // for this — the app can show the alternatives and let the member say which
  // one they are holding.
  //
  // Only flagged when it would MATTER. Printings whose prices sit close
  // together make the ambiguity worth nothing to resolve, and flagging those
  // would put a warning on cards where either answer is right.
  const prices = printings
    .map((p: Record<string, any>) => (p.market_price != null ? Number(p.market_price) : null))
    .filter((n): n is number => Number.isFinite(n) && (n as number) > 0);
  const dearest = prices.length ? Math.max(...prices) : null;
  const undecided = choice?.method === "fallback" && printings.length > 1;
  const spread = undecided && dearest != null && market != null && market > 0
    ? dearest / market
    : 1;
  const AMBIGUOUS_SPREAD = 2;

  const identificationSuspect =
    undecided && market != null && dearest != null && spread >= AMBIGUOUS_SPREAD
      ? `The photograph did not settle which printing this is. ${printings.length} share ` +
        `this number and they range from US$${market.toFixed(2)} to US$${dearest.toFixed(2)} — ` +
        `pick the artwork that matches your card.`
      : null;

  // The number settles the card; the picture has to settle the printing, and
  // an undecided pick among printings that differ in price is one we did not
  // make. Close prices make the choice not matter, so those stay priced.
  identification.printingConfirmed = !identificationSuspect;
  if (identificationSuspect) identification.unconfirmedReason = "printing-not-read";

  const valuation: Valuation | null =
    market != null
      ? {
          source: "optcgapi",
          updatedAt: c.date_scraped ?? null,
          // Means: do not lead with the figure. Null when we are confident,
          // so the common case is unchanged.
          identificationSuspect,
          tcgplayer: {
            unit: "USD",
            variant: "normal",
            low: c.inventory_price != null ? Number(c.inventory_price) : null,
            mid: null,
            // The top of the range this card could be, so a screen that must
            // show something can show what is at stake rather than the floor.
            high: identificationSuspect ? dearest : null,
            market,
          },
          cardmarket: null,
        }
      : null;
  return { identification, valuation };
}

/** Yu-Gi-Oh! via YGOPRODeck (free, no key).
 *
 *  A YGOPRODeck card is every printing of that card at once: Blue-Eyes White
 *  Dragon is one entry with 78 sets. This used to take the first set in the
 *  list as the printing and `card_prices` as its price — which is the CHEAPEST
 *  printing's price. LOB-001 (US$62.15) came back as a 2016 tin at US$0.13,
 *  with a match score of 1.0 because the NAME matched perfectly.
 *
 *  Now the printing is the set code read off the card (under the artwork), the
 *  price is that printing's own `set_price`, and with no code read the card is
 *  named, no set is claimed and nothing is priced. */
export async function identifyYgo(
  names: string[],
  texts: readonly string[] = [],
): Promise<CatalogMatch | null> {
  if (names.length === 0) return null;
  const q = encodeURIComponent(names[0]);
  const body = (await fetchJson(
    `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${q}`,
  )) as { data?: Record<string, any>[] } | null;
  const cards = body?.data ?? [];
  let best: { card: Record<string, any>; score: number; name: string } | null = null;
  for (const card of cards.slice(0, 30)) {
    const m = bestAgainst(names, card.name as string);
    if (!best || m.score > best.score) best = { card, score: m.score, name: m.name };
  }
  if (!best || best.score < MIN_SCORE) return null;

  const c = best.card;
  const printing = ygoPrintingFor(c.card_sets as any[] | undefined, readYgoSetCodes(texts));
  const price = ygoSetPrice(printing);
  const identification: Identification = {
    cardId: `ygo-${c.id}`,
    name: c.name,
    setId: printing?.set_code ?? "",
    setName: printing?.set_name ?? "",
    localId: printing?.set_code ?? "",
    rarity: printing?.set_rarity ?? null,
    imageUrl: c.card_images?.[0]?.image_url ?? null,
    // A perfect name match is not a perfect printing match; below 0.93 the
    // vision model gets a second look before anything is asserted.
    matchScore: printing ? Math.min(best.score, 1) : Math.min(best.score, 0.9),
    ocrName: best.name,
    game: "yugioh",
    printingConfirmed: Boolean(printing),
    unconfirmedReason: printing ? null : "printing-not-read",
  };
  const valuation: Valuation | null =
    printing && price != null
      ? {
          source: "ygoprodeck",
          updatedAt: null,
          tcgplayer: {
            unit: "USD", variant: printing.set_rarity ?? "normal",
            low: null, mid: null, high: null, market: price,
          },
          cardmarket: null,
        }
      : null;
  return { identification, valuation };
}
