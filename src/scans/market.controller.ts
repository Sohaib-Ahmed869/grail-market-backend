import { Controller, Get, Param, Query } from "@nestjs/common";
import { fxRates } from "./fx.js";
import { scanBudget } from "./budget.js";
import { fetchListings } from "./ebaylistings.js";
import { quotaStatus } from "./gradedprices.js";
import { scanCounts } from "./ledger.js";
import { cardNews, cardTrend, marketPulse } from "./market.js";
import { searchCards } from "./search.js";
import { cardMeta } from "./demand.js";
import { cardHedgerStatus } from "./cardhedger.js";
import { getSet, listSets } from "./sets.js";
import { sealedPage } from "./sealed.js";
import { gameOfCard, gamesWithPreviews, setDetailForGame, setIdOfCard, setsForGame } from "./games.js";
import { interestIn } from "./interest.js";
import { gradedPricesFor, priceForSlab } from "./pricing.js";
import { ebayShop, shopsFor, type ShopQuote } from "./shops.js";
import { gradeIsInverted } from "./ladder.js";
import { readPrinting } from "./printing.js";
import { printingsFor, priceIsAmbiguous } from "../printings/store.js";
import { certLinks, certUrl, parseCode } from "./lookupcode.js";
import { identifyBySetCode } from "./setcode.js";
import { MAX_ART_IDS, isSportCard, isSportGame, noFigure, sportArt, sportAsks, sportCardMeta } from "./sports.js";
import { catalogueFigure, indexedCard, isCatalogueOnlyCard, listingPolicy } from "./editions.js";

/** A card's price as its own catalogue lists it, found by card id.
 *
 *  From the index filled whenever a set is read; if the index has forgotten
 *  (a restart) and the caller says which set the card came from, that set is
 *  read again — it is cached for a day, so this is almost always free.
 *
 *  Yu-Gi-Oh is excluded on purpose: YGOPRODeck's figure belongs to the card
 *  NAME across every set it was printed in, not to this printing, and a
 *  Starlight Rare priced at its common reprint is the defect this file exists
 *  to prevent. */
async function catalogueRawFor(cardId?: string | null, setId?: string | null): Promise<number | null> {
  if (!cardId || cardId.startsWith("ygo-")) return null;
  const held = indexedCard(cardId);
  if (held) return held.rawUsd;
  const from = (setId ?? "").trim();
  if (!from) return null;
  try {
    const other = await setDetailForGame(from);
    const set = other !== undefined ? other : await getSet(from);
    const c = set?.cards.find((x: { cardId: string }) => x.cardId === cardId);
    return c?.rawUsd ?? null;
  } catch {
    return null;
  }
}

@Controller("market")
export class MarketController {
  @Get("pulse")
  pulse() {
    return marketPulse();
  }

  @Get("news")
  news() {
    return cardNews();
  }

  // price-provider budget, so the UI can explain a missing price instead of
  // rendering a silent blank
  @Get("quota")
  async quota() {
    // Two different questions, answered separately because conflating them is
    // what made this number untrustworthy. `scans` is what has actually
    // happened, counted from an append-only ledger in the shared store.
    // `budget` is what the metered providers will still allow, which is an
    // estimate and moves for reasons a user did not cause.
    const [status, counts, budget] = await Promise.all([
      quotaStatus(),
      scanCounts(),
      scanBudget(),
    ]);
    return {
      ...status, scans: counts, budget,
      // Whether the bought catalogue is on, and how much of today it has
      // spent. Reported as two separate facts on purpose: a key present with
      // the cap left at zero looks exactly like no key at all from outside,
      // and that costs an afternoon every time.
      providers: { cardhedger: cardHedgerStatus() },
    };
  }

  // Live listings for one card. Kept off the scan response deliberately: a
  // scan already waits on vision plus pricing, and asks are useful but not
  // worth adding latency to the number people are waiting for.
  @Get("listings")
  async listings(
    @Query("name") name?: string,
    @Query("set") set?: string,
    @Query("number") number?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
    @Query("label") label?: string,
    @Query("printing") printing?: string,
    @Query("ja") ja?: string,
    @Query("lang") lang?: string,
    @Query("game") game?: string,
    @Query("cardId") cardId?: string,
  ) {
    const empty = {
      listings: [], total: 0, matched: 0, trimmed: 0, query: name ?? "",
      filteredToGrade: false, filteredToGrader: false, filteredToLabel: false, filteredToLabelText: false,
      medianAsk: null, askLow: null, askHigh: null,
      printing: null, filteredToPrinting: false, otherPrintings: [],
      staleCeiling: null, staleCeilingDays: null, cappedByStale: false,
    };
    if (!name) return empty;
    const g = grade != null && grade !== "" ? Number(grade) : null;
    // A catalogue-only card (editions.ts): narrowed to its language where eBay
    // titles can say it, and with no median where they cannot or where there
    // is no card number to tell one product from another.
    const policy = listingPolicy(cardId, number);
    if (policy?.language) { lang = policy.language; if (policy.language === "ja") ja = "1"; }
    const result =
      (await fetchListings({
        name,
        setName: set ?? null,
        game: game ?? null,
        number: number ?? null,
        grader: grader ?? null,
        grade: Number.isFinite(g) ? g : null,
        labelVariant: label === "black" || label === "gold" ? label : null,
        // the panel must narrow to the same printing the valuation used, or the
        // two disagree on screen for reasons no reader can see
        printingHint: printing ?? null,
        japanese: ja === "1" || ja === "true",
        language: lang === "en" || lang === "ja" || lang === "zh" ? lang : null,
      })) ?? empty;
    // The rows are real asks and worth showing. The summary over them is not,
    // for a sports entry: a median across a player's base cards, parallels and
    // 1/1s is a number that describes none of them.
    if (isSportGame(game) || isSportCard(cardId)) {
      return { ...result, medianAsk: null, askLow: null, askHigh: null, unpriceable: "player-in-set" };
    }
    if (policy?.blankMedian) {
      return { ...result, medianAsk: null, askLow: null, askHigh: null, unpriceable: "catalogue-price-only" };
    }
    return result;
  }

  /** Every set, newest first.
   *
   *  The default view of search, because a search box only helps someone who
   *  already knows the name. Browsing to the set and finding the card in it is
   *  how someone holding an unfamiliar card gets to its page at all. */
  /** The games we can browse, for the first level of the set picker. */
  @Get("games")
  async games() {
    return { games: await gamesWithPreviews() };
  }

  /** Sets for one game. Without a game this stays what it always was —
   *  Pokemon — so nothing that already calls it changes behaviour. */
  @Get("sets")
  async sets(@Query("game") game?: string) {
    // No game keeps the old behaviour — Pokemon — so anything already calling
    // this is unaffected.
    return { sets: game ? await setsForGame(game) : await listSets() };
  }

  /** One card's identity, by catalogue id.
   *
   *  The phone used to work this out itself, by cutting the id at its last
   *  hyphen and asking for the front half as a set. That is correct for
   *  Pokemon (`swsh7-215` -> `swsh7`) and for nothing else: One Piece ids look
   *  like `optcg-OP13-119` and the cut gives `optcg-OP13`, while the set
   *  endpoint wants `optcg:OP13` — so every One Piece card opened onto a page
   *  with no name, which meant no price either. Magic ids are `mtg-<uuid>`,
   *  where the set is not in the string at all.
   *
   *  So the answer comes from what we already store rather than from parsing.
   *  A card the market can show has been listed, watched, held or scanned, and
   *  all four of those tables carry its name.
   *
   *  Falls back to the set for a card we hold nothing about — a deep link into
   *  a set nobody here has touched still resolves. */
  @Get("card")
  async card(@Query("catalogId") catalogId?: string, @Query("setId") setId?: string) {
    const id = (catalogId ?? "").trim();
    if (!id) return { error: "no-id", message: "A catalogue id is required." };

    // A sports id is its own record: sport, set and player are inside it.
    if (isSportCard(id)) {
      const meta = sportCardMeta(id);
      if (!meta) return { error: "not-found", cardId: id };
      // A card page opened straight from a deep link or a search has no set
      // detail behind it, so the picture is asked for here: one call at most,
      // and none when the art cache already knows.
      const imageUrl = meta.imageUrl ?? (await sportArt([id]))[id] ?? null;
      return { ...meta, imageUrl, source: "id" };
    }

    // A card read from a set listing is named by that listing, which was
    // indexed when the set was read — no set needed, no store read.
    if (isCatalogueOnlyCard(id)) {
      const c = indexedCard(id);
      if (c) {
        return {
          cardId: id, name: c.name, setName: c.setName, number: c.number,
          game: c.game, imageUrl: c.imageUrl, source: "catalogue",
        };
      }
    }

    const held = await cardMeta(id);
    if (held) {
      return {
        cardId: held.catalogId,
        name: held.name,
        setName: held.setName,
        number: held.number ?? null,
        game: held.game,
        imageUrl: held.imageUrl,
        source: "store",
      };
    }

    // Nothing stored. Read the set it belongs to.
    //
    // The set is TOLD to us when the caller knows it, which the card page
    // always does — it was opened from a set. Deriving it from the card id
    // only ever worked for two catalogues: Pokemon, where a card id really is
    // `<set>-<number>`, and One Piece once its hyphen was handled. Every other
    // source keys cards on an opaque provider id with no set inside it, so
    // seven of the nine games answered "Card Not Found" on every card in
    // every set. Asking the caller is the fix; deriving is the fallback.
    const from = (setId ?? "").trim() || setIdOfCard(id);
    if (!from) return { error: "not-found", cardId: id };
    const other = await setDetailForGame(from);
    const set = other !== undefined ? other : await getSet(from);
    const c = set?.cards.find((x: any) => x.cardId === id);
    if (!set || !c) return { error: "not-found", cardId: id };
    return {
      cardId: id,
      name: c.name,
      setName: set.name,
      number: c.localId ?? null,
      game: null,
      imageUrl: c.imageUrl ?? null,
      source: "set",
    };
  }

  /** Pictures for sports cards, for the ones on screen.
   *
   *  A sports set lists every player tagged in it, and the set's own call can
   *  picture about one in fifteen. The page asks for the rest as they scroll
   *  into view, up to twelve ids a request; anything past twelve is ignored
   *  rather than refused, so a client that over-asks still gets its first
   *  screenful. A null is either "eBay has no picture of this player in this
   *  set" or "not asked right now" — the page draws a blank for both and may
   *  ask again later. */
  @Get("sports/art")
  async sportsArt(@Query("ids") ids?: string) {
    const list = String(ids ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, MAX_ART_IDS);
    // The same per-player lookup learns the cheapest copy listed, so asks
    // ride along with the pictures at no extra eBay call.
    const found = await sportArt(list);
    return { art: found, asks: sportAsks(list) };
  }

  /** A game's sealed product — boxes, tins, collections — newest set first,
   *  a few sets a page. `supported: false` means this game (or language
   *  edition) has no sealed catalogue, which the app says rather than showing
   *  an empty grid. */
  @Get("sealed")
  async sealed(@Query("game") game?: string, @Query("cursor") cursor?: string) {
    const g = (game ?? "").trim();
    if (!g) return { groups: [], next: null, supported: false };
    const c = Number(cursor);
    return sealedPage(g, Number.isFinite(c) && c >= 0 ? Math.floor(c) : 0);
  }

  /** One set and the cards in it. */
  @Get("sets/:setId")
  async set(@Param("setId") setId: string) {
    // A prefixed id belongs to one of the catalogues TCGdex does not cover.
    // `undefined` means "not one of mine", which is the Pokemon path.
    const other = await setDetailForGame(setId);
    if (other !== undefined) {
      return other ?? { error: "not-found", message: "That set couldn't be loaded." };
    }
    const s = await getSet(setId);
    return s ?? { error: "not-found", setId };
  }

  // Search by name, for when the card is not in front of you.
  @Get("search")
  async search(@Query("q") q?: string, @Query("limit") limit?: string) {
    if (!q || q.trim().length < 2) return { query: q ?? "", results: [] };
    const n = Number(limit);
    return {
      query: q,
      results: await searchCards(q, Number.isFinite(n) ? Math.min(n, 40) : 24),
    };
  }

  /** Find a card from what is printed on it, without a photograph.
   *
   *  A set code and a number pin a card exactly, which is more than a name
   *  ever does — "Charizard" is forty cards and four orders of magnitude. It
   *  is also the way out for a card the camera keeps failing on.
   *
   *  A certificate number is handed to the grading company's own register
   *  rather than answered here. We hold no grading company data and are not
   *  going to pretend to; their register is the only authority on whether a
   *  slab is real. */
  @Get("lookup")
  async lookup(@Query("q") q?: string) {
    const parsed = parseCode(q ?? "");

    if (parsed.kind === "cert") {
      return {
        kind: "cert",
        cert: parsed.cert,
        grader: parsed.grader || null,
        // With no company named we offer every register rather than guessing.
        // A PSA URL with a BGS number in it is a confident wrong answer.
        links: parsed.grader
          ? [{ grader: parsed.grader, url: certUrl(parsed.grader, parsed.cert) }].filter(
              (l) => l.url,
            )
          : certLinks(parsed.cert),
      };
    }

    if (parsed.kind === "code") {
      const card = await identifyBySetCode(
        { code: parsed.code, locale: "ja", number: parsed.number,
          printedNumber: parsed.printedNumber, rarity: null },
        parsed.number,
        null,
      ).catch(() => null);
      // A code we cannot resolve is not an error — plenty of sets are not in
      // the catalogue. Falling back to the text search is more use than a 404.
      return card
        ? { kind: "card", card }
        : { kind: "search", query: q, results: await searchCards(q!, 24) };
    }

    if (parsed.kind === "number") {
      return {
        kind: "search",
        query: parsed.printedNumber ?? parsed.number,
        results: await searchCards(parsed.printedNumber ?? parsed.number, 24),
        note: "A number on its own matches across sets — add the set code to pin it.",
      };
    }

    return {
      kind: "search",
      query: parsed.text,
      results: parsed.text.length >= 2 ? await searchCards(parsed.text, 24) : [],
    };
  }

  // Price a card chosen from search results.
  //
  // Deliberately the same chain a scan uses — sold comps for the exact grader
  // and grade first, live asks for the exact printing second — because a scan
  // and a search that land on the same card must not quote two prices for it.
  /** How many people here follow, hold or have looked at a card.
   *
   *  Counted, never estimated. A card nobody has touched says so. */
  @Get("interest")
  async interest(@Query("catalogId") catalogId?: string) {
    if (!catalogId) return { following: 0, holding: 0, views: 0, faces: [] };
    return interestIn(catalogId);
  }

  /** One card's price history and period returns, for its own page. */
  @Get("trend")
  async trend(
    @Query("cardId") cardId?: string,
    @Query("name") name?: string,
    @Query("game") game?: string,
    @Query("set") setName?: string,
  ) {
    if (!cardId || !name) return { trend: null };
    return {
      trend: await cardTrend({
        catalogId: cardId, name, game: game ?? null, setName: setName ?? null,
      }),
    };
  }

  /** Every printing of one collector number, and whether they disagree.
   *
   *  Split out from `/market/price` because the scan result needs the same
   *  answer without paying for the whole price chain — and because a scan
   *  already knows which printing it saw, so it can name one rather than ask.
   *  Both screens reading one source is what stops them disagreeing. */
  @Get("printings")
  async printings(
    @Query("cardId") cardId?: string,
    @Query("number") number?: string,
    @Query("set") setName?: string,
    @Query("game") game?: string,
  ) {
    const variants = await printingsFor({
      game: game ?? gameOfCard(cardId ?? null),
      number: number ?? null,
      setName: setName ?? null,
    });
    return { variants, ambiguous: priceIsAmbiguous(variants) };
  }

  @Get("price")
  async price(
    @Query("name") name?: string,
    // the catalogue id, when the caller has one. Search results carry it, and
    // with it the answer comes from our own store instead of a paid lookup.
    @Query("cardId") cardId?: string,
    @Query("set") setName?: string,
    @Query("number") number?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
    @Query("printing") printing?: string,
    @Query("lang") lang?: string,
    // which game, so the franchise stays out of the eBay search terms
    @Query("game") game?: string,
    // The set the card page was opened from. Only used to read that set's
    // own price for this exact card id when nothing else priced it.
    @Query("setId") setId?: string,
  ) {
    if (!name) return { error: "name required" };
    const g = grade != null && grade !== "" ? Number(grade) : null;
    const grade_ = Number.isFinite(g) ? (g as number) : null;

    // Before anything is fetched: no store read, no provider, no eBay. A
    // sports entry is a player within a set and has no single figure — see
    // sports.ts — so this answers every price field null, in the normal shape.
    if (isSportCard(cardId) || isSportGame(game)) {
      return noFigure({ name, setName, number, grader, grade: grade_ });
    }

    // Same refusal for a catalogue-only card, with one difference: the
    // catalogue's own figure for that exact product is allowed through.
    if (isCatalogueOnlyCard(cardId)) {
      return catalogueFigure({ name, setName, number, grader, grade: grade_ }, cardId!);
    }

    // Same lookup the scan path uses — our store first, the provider only on a
    // miss. Calling the provider directly here is how a search came to quote a
    // freshly-bought figure for a card a scan was pricing from the store.
    const ppt = await gradedPricesFor({
      catalogId: cardId ?? null,
      name,
      number: number ?? null,
      setName: setName ?? null,
    });
    const sold =
      grader && grade_ != null
        ? ppt.byGrader?.[grader.toUpperCase()]?.[String(grade_).replace(/\.0$/, "")] ?? null
        : null;


    // Asks fill a gap; they never displace a real figure. For a GRADED card
    // that gap is "no completed sale at this grade". For an ungraded one the
    // raw market price already answers the question, and asks are only right
    // when the copy is a printing that price does not cover — the same rule
    // the scan path follows, so the two agree.
    // The set list showed a price for this card and the card page showed a
    // dash: the chain here asks the feeds by name and number, and for most
    // games none of them answered, while the catalogue that drew the set had
    // the figure for this exact card id all along. Read by ID, never by name,
    // so it cannot be another card's price.
    const catalogueRaw = ppt.rawUsd == null ? await catalogueRawFor(cardId, setId) : null;
    const raw = ppt.rawUsd ?? catalogueRaw;
    const specialPrinting = Boolean(printing && readPrinting(printing).family);
    // A recorded sale normally means we do not need the asking market. It is
    // not enough when that sale contradicts its own grade ladder — a BGS 8.5
    // priced below the BGS 8 beneath it — because then the asks are the only
    // thing that can correct it, and not fetching them leaves the broken
    // figure standing unopposed.
    const soldIsSuspect = Boolean(
      grader &&
        grade_ != null &&
        ppt.byGrader &&
        gradeIsInverted(ppt.byGrader[grader.toUpperCase()] ?? {}, grade_),
    );
    const wantAsks =
      grader && grade_ != null
        ? sold?.price == null || soldIsSuspect
        : raw == null || specialPrinting;

    const live =
      wantAsks
        ? await fetchListings({
            name,
            setName: setName ?? null,
            game: game ?? null,
            number: number ?? null,
            grader: grader ?? null,
            grade: grade_,
            printingHint: printing ?? null,
            language: lang === "en" || lang === "ja" || lang === "zh" ? lang : null,
            japanese: lang === "ja",
          })
        : null;

    // The same ladder the scan path uses, and decided AFTER the listings for
    // the same reason: the asking market is the only thing that can overrule a
    // recorded sale which contradicts its own grade ladder, and it is not
    // known until here. A search and a scan must not answer differently.
    const slabPrice = await priceForSlab(
      ppt.byGrader,
      grader ?? null,
      grade_,
      live
        ? {
            median: live.medianAsk,
            count: live.listings.length,
            filteredToGrade: Boolean(live.filteredToGrade),
          }
        : null,
    );

    // Every printing this collector number has, from TCGplayer's own
    // catalogue — see src/printings. This is the answer to the defect that
    // priced a Red Super Alternate Art Luffy at A$197: five printings share
    // one catalogue id here, so the expensive one had no address and the
    // figure came from a text search of eBay instead.
    const variants = await printingsFor({
      // Told, or read off the id. The card page has never sent a game and
      // adding it there would only fix the card page — a lookup that silently
      // returns nothing when a caller omits an argument is the shape of a bug
      // that comes back.
      game: game ?? gameOfCard(cardId ?? null),
      number: number ?? null,
      setName: setName ?? null,
    });
    // When the printings disagree beyond a ratio, ONE number for all of them
    // is a claim we cannot stand behind. Say so rather than pick one: the
    // client is told which versions exist and asked which they hold.
    const ambiguous = priceIsAmbiguous(variants);

    return {
      name,
      setName: setName ?? null,
      number: number ?? null,
      grader: grader ?? null,
      grade: grade_,
      rawUsd: ambiguous ? null : raw,
      rawSource: ambiguous || raw == null ? null : ppt.rawUsd != null ? "market" : "catalogue",
      variants,
      variantsAmbiguous: ambiguous,
      byGrader: ppt.byGrader ?? null,
      // Which printing this is and how often it trades. Both have been in the
      // provider payload the whole time and neither ever reached a screen, so
      // a holo and a reverse holo — different markets, sometimes by 3x — were
      // shown as one card with one price.
      printings: ppt.printings ?? null,
      velocity: ppt.velocity ?? null,
      sold,
      slabPrice,
      liveAsk:
        live?.medianAsk != null
          ? {
              median: live.medianAsk,
              low: live.askLow,
              high: live.askHigh,
              count: live.listings.length,
              printing: live.filteredToPrinting ? live.printing : null,
              staleCeilingDays: live.cappedByStale ? live.staleCeilingDays : null,
            }
          : null,
      listings: live?.listings ?? [],
      // Where to actually buy one. The eBay row is built from the pool above
      // rather than a second search, so this costs one tcgdex fetch and
      // nothing else. Live rows first: a listing somebody can click beats a
      // marketplace's summary of its own market, however good the summary.
      shops: [ebayShop(live), ...(await shopsFor(cardId ?? null))]
        .filter((s): s is ShopQuote => s != null)
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "live" ? -1 : 1)),
      printingRead: printing ? readPrinting(printing) : null,
    };
  }

  @Get("fx")
  async fx() {
    const fx = await fxRates();
    // usdToAud kept alongside the full table so an older cached client bundle
    // keeps working through a deploy
    return { ...fx, usdToAud: fx.rates.AUD };
  }
}
