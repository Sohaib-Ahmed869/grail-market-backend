import { Controller, Get, Query } from "@nestjs/common";
import { fxRates } from "./fx.js";
import { scanBudget } from "./budget.js";
import { fetchListings } from "./ebaylistings.js";
import { quotaStatus } from "./gradedprices.js";
import { scanCounts } from "./ledger.js";
import { cardNews, marketPulse } from "./market.js";
import { searchCards } from "./search.js";
import { gradedPricesFor, priceForSlab } from "./pricing.js";
import { gradeIsInverted } from "./ladder.js";
import { readPrinting } from "./printing.js";

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
    return { ...status, scans: counts, budget };
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
    return (
      (await fetchListings({
        name,
        setName: set ?? null,
        number: number ?? null,
        grader: grader ?? null,
        grade: Number.isFinite(g) ? g : null,
        labelVariant: label === "black" || label === "gold" ? label : null,
        // the panel must narrow to the same printing the valuation used, or the
        // two disagree on screen for reasons no reader can see
        printingHint: printing ?? null,
        japanese: ja === "1" || ja === "true",
        language: lang === "en" || lang === "ja" || lang === "zh" ? lang : null,
      })) ?? empty
    );
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

  // Price a card chosen from search results.
  //
  // Deliberately the same chain a scan uses — sold comps for the exact grader
  // and grade first, live asks for the exact printing second — because a scan
  // and a search that land on the same card must not quote two prices for it.
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
  ) {
    if (!name) return { error: "name required" };
    const g = grade != null && grade !== "" ? Number(grade) : null;
    const grade_ = Number.isFinite(g) ? (g as number) : null;

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
    const raw = ppt.rawUsd ?? null;
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

    return {
      name,
      setName: setName ?? null,
      number: number ?? null,
      grader: grader ?? null,
      grade: grade_,
      rawUsd: raw,
      byGrader: ppt.byGrader ?? null,
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
