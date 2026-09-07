import { TtlCache } from "./ttlcache.js";

// Where a card can actually be bought, and for how much.
//
// The card page already answers "what is this worth". This answers the
// question people ask straight after it, which is "where do I get one" — the
// thing Collectr shows and we did not.
//
// Two kinds of row, and the difference is not cosmetic:
//
//   live     real listings we can see and link to individually. eBay only,
//            because eBay is the only marketplace whose inventory we have an
//            API for. A live row means somebody is selling this card right now
//            at that price.
//
//   market   the marketplace's OWN published price for the product, with a
//            link to its page. TCGplayer and Cardmarket both publish this and
//            neither lets us read their sellers' inventory: TCGplayer stopped
//            granting API access years ago, and Cardmarket's API is gated
//            behind a professional-seller account. A market row is a real
//            number from that shop, but it is a summary of their market, not a
//            copy that is definitely in stock.
//
// The two are labelled separately all the way to the screen, because "12
// sellers have this at A$115" and "TCGplayer says this card runs about A$115"
// are different claims and only one of them is a promise you can click.

const TCGDEX = process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en";

export type ShopQuote = {
  /** Stable id, so the client can pick an icon without string-matching a name. */
  id: "tcgplayer" | "cardmarket" | "ebay" | "grailmarket";
  name: string;
  kind: "live" | "market";
  /** The headline figure, in `currency`. Never converted here — the app owns
   *  conversion so the rate and the date can be shown next to the number. */
  price: number;
  currency: string;
  /** What that figure IS. "market price", "trend", "lowest ask" — the label is
   *  part of the number, and dropping it is how four sources become one wrong
   *  average. */
  basis: string;
  low: number | null;
  high: number | null;
  /** How many real listings stand behind it, where that is a meaningful
   *  question. Null on a market row: a published market price has no count. */
  count: number | null;
  url: string | null;
  updated: string | null;
};

type Pricing = {
  cardmarket?: {
    updated?: string; unit?: string; idProduct?: number;
    low?: number; trend?: number; avg?: number; avg30?: number;
  } | null;
  tcgplayer?: ({ unit?: string; updated?: string } & Record<string, unknown>) | null;
} | null;

// tcgdex publishes prices once a day, so an hour is already far finer than the
// data changes. This exists to stop one card page costing four identical
// fetches, not to keep a figure fresh.
const cache = new TtlCache<ShopQuote[]>(60 * 60 * 1000, 500);

/** The print variants tcgdex nests TCGplayer prices under, best first.
 *
 *  A card is normally listed under exactly one of these. Holofoil leads
 *  because for the modern ex and illustration rares that people actually look
 *  up, the holo IS the card — there is no non-holo printing to confuse it
 *  with. */
const TP_VARIANTS = [
  "holofoil", "normal", "reverseHolofoil",
  "1stEditionHolofoil", "1stEdition", "unlimitedHolofoil", "unlimited",
] as const;

const pos = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;

/** Every shop that publishes a price for this card, by catalogue id.
 *
 *  Keyed on the catalogue id and nothing else, which is the whole reason this
 *  function is safe: tcgdex is asked for ONE card by its own id, so there is
 *  no name to match, no set to guess, and none of the wrong-printing failure
 *  that every other price path here has to defend against. `me02.5-010` and
 *  `me02.5-272` are the same Pokemon in the same set and differ by ninety
 *  dollars; asking by id is what keeps them apart.
 */
export async function shopsFor(catalogId: string | null | undefined): Promise<ShopQuote[]> {
  if (!catalogId) return [];
  const hit = cache.get(catalogId);
  if (hit) return hit;

  let pricing: Pricing = null;
  try {
    const res = await fetch(`${TCGDEX}/cards/${encodeURIComponent(catalogId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    pricing = ((await res.json()) as { pricing?: Pricing })?.pricing ?? null;
  } catch {
    // A shop we could not reach is a shop we say nothing about.
    return [];
  }
  if (!pricing) return [];

  const out: ShopQuote[] = [];

  const tp = pricing.tcgplayer;
  if (tp) {
    for (const variant of TP_VARIANTS) {
      const v = tp[variant] as Record<string, unknown> | undefined;
      if (!v) continue;
      // Market price is what TCGplayer says the card actually trades at, and
      // it is the only one of the four worth leading with. lowPrice is the
      // cheapest copy in any condition — routinely a damaged one — and
      // highPrice is somebody's fantasy: 950 against a market of 83 on the
      // card that prompted this.
      const market = pos(v.marketPrice) ?? pos(v.midPrice);
      if (market == null) continue;
      const productId = pos(v.productId);
      out.push({
        id: "tcgplayer",
        name: "TCGplayer",
        kind: "market",
        price: market,
        currency: String(tp.unit ?? "USD"),
        basis: pos(v.marketPrice) != null ? "market price" : "mid price",
        low: pos(v.lowPrice),
        high: pos(v.highPrice),
        count: null,
        // Verified to resolve. Without a product id there is no page to send
        // anyone to, and a search URL that lands on the wrong printing is
        // worse than no link.
        url: productId != null ? `https://www.tcgplayer.com/product/${productId}` : null,
        updated: tp.updated ? String(tp.updated) : null,
      });
      break;
    }
  }

  const cm = pricing.cardmarket;
  if (cm) {
    // Trend is Cardmarket's own read of where the price is going and is what
    // their product page leads with; avg is the plain 30-day mean. Prefer the
    // one their users see, so a number checked against the site matches.
    const price = pos(cm.trend) ?? pos(cm.avg) ?? pos(cm.avg30);
    if (price != null) {
      out.push({
        id: "cardmarket",
        name: "Cardmarket",
        kind: "market",
        price,
        currency: String(cm.unit ?? "EUR"),
        basis: pos(cm.trend) != null ? "price trend" : "30-day average",
        low: pos(cm.low),
        high: null,
        count: null,
        url:
          cm.idProduct != null
            ? `https://www.cardmarket.com/en/Pokemon/Products/Singles?idProduct=${cm.idProduct}`
            : null,
        updated: cm.updated ? String(cm.updated) : null,
      });
    }
  }

  cache.set(catalogId, out);
  return out;
}

/** The eBay row, built from asks the price endpoint has already fetched.
 *
 *  Separate from `shopsFor` because it must not trigger a second eBay search:
 *  the caller has the filtered pool in hand, and re-fetching it here would
 *  double the cost of a card page to buy the same answer twice.
 *
 *  Takes the ALREADY-FILTERED result. Everything that makes an eBay pool
 *  trustworthy — the wrong-card guard, the grade cascade, slabs kept out of a
 *  raw median — happens upstream, and a shop row built from the raw pool would
 *  quietly undo all of it. */
export function ebayShop(live: {
  medianAsk: number | null;
  askLow: number | null;
  askHigh: number | null;
  listings: { url?: string | null; price?: number | null }[];
  query?: string | null;
} | null): ShopQuote | null {
  if (!live || live.medianAsk == null || live.listings.length === 0) return null;
  // The cheapest listing that has somewhere to go. `listings` arrives in the
  // provider's order, not price order, so taking the first would link to an
  // arbitrary copy while the row above it quoted the median.
  const cheapest = live.listings
    .filter((l) => l.url && typeof l.price === "number")
    .sort((a, b) => (a.price as number) - (b.price as number))[0];
  return {
    id: "ebay",
    name: "eBay",
    kind: "live",
    price: live.medianAsk,
    currency: "USD",
    basis: live.listings.length === 1 ? "the only ask" : "median ask",
    low: live.askLow,
    high: live.askHigh,
    count: live.listings.length,
    // A real listing, not a search page: the point of a live row is that it
    // goes to a copy somebody can actually buy.
    url: cheapest?.url ?? null,
    updated: null,
  };
}
