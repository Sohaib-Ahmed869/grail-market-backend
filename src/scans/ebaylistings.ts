import { recordUsage } from "./usage.js";
import { comparePrinting, describePrinting, readPrinting, type Printing } from "./printing.js";
import { listingMatchesLabel } from "./labeltokens.js";
import { TtlCache } from "./ttlcache.js";

// Live eBay listings for a card, shown in-product rather than as a link out.
//
// These are ASKS, not sales. That distinction matters and is carried through to
// the response so the interface can say it: a card listed at $30,000 for eight
// months is not a $30,000 card. The sold medians elsewhere in the valuation are
// the authority; this is here so a seller can see what the market is currently
// being offered at, and sanity-check our figure against real inventory.

const EBAY = "https://api.ebay.com";
const TTL_MS = 30 * 60 * 1000; // asks move slowly; half an hour is plenty

export type Listing = {
  title: string;
  price: number | null;
  currency: string;
  condition: string | null;
  imageUrl: string | null;
  url: string;
  seller: string | null;
  /** grader + grade parsed out of the title, where present */
  grader: string | null;
  grade: number | null;
  /** Beckett label variant read from the title: black | gold. A Black Label 10
   *  and a gold-label Pristine 10 are different goods at very different money,
   *  and this is the only place we can tell them apart. */
  labelVariant: "black" | "gold" | null;
  /** printing named in the title, e.g. "Manga Art · Alt Art · Japanese" */
  printing: string | null;
  /** days this listing has been up unsold. The single most useful number on a
   *  listing: one that has sat for months is priced above market by proof. */
  ageDays: number | null;
  /** how that printing compares to the card we scanned */
  printingMatch: "match" | "conflict" | "unknown";
};

export type ListingResult = {
  listings: Listing[];
  total: number;
  query: string;
  /** true when we filtered to the card's own grader and grade */
  filteredToGrade: boolean;
  /** true when the asks were narrowed to the slab's own label variant */
  filteredToLabel: boolean;
  /** true when the asks were narrowed to the printing the label names */
  filteredToLabelText: boolean;
  /** listings that survived every filter, of which `listings` shows the first few */
  matched: number;
  /** how many extreme listings were trimmed before taking the median */
  trimmed: number;
  /** Cheapest ask that has gone unsold long enough to be evidence. Nobody has
   *  bought the card at this price in months, so the market sits below it. */
  staleCeiling: number | null;
  staleCeilingDays: number | null;
  /** true when the ceiling forced the headline figure down */
  cappedByStale: boolean;
  /** median asking price of what survived filtering — a figure, not just a list.
   *  Median rather than mean: one aspirational listing should not move it. */
  medianAsk: number | null;
  askLow: number | null;
  askHigh: number | null;
  /** the printing these figures are for, where we could pin one down */
  printing: string | null;
  /** true when the listings were narrowed to that printing */
  filteredToPrinting: boolean;
  /** other printings of the same card number we saw and excluded, with the
   *  asking range for each — the card number alone does not identify a product
   *  and the interface should be able to say so */
  otherPrintings: { name: string; count: number; low: number; high: number }[];
};

/** Titles that are not a single copy of the card being priced. A bundle, a
 *  break slot, or a damaged slab all trade at prices that say nothing about
 *  what this card is worth, and they sit at both ends of the range where they
 *  do the most damage to a median. */
const NOT_ONE_CARD =
  /\b(lot|lots|bundle|bulk|collection|joblot|job lot|break|breaks|random|mystery|repack|custom|proxy|proxies|reprint|orica|digital|read desc|damaged|cracked|scratched|reholder|empty|case only|sleeve|toploader|binder|playset|\d{2,}\s*cards?)\b|\b(art|complete|full|master|sequential)\s+set\b|\bsequential\b/i;

/** How long an ask must stand before its failure to sell is evidence.
 *  eBay fixed-price listings renew automatically, so two full months is a
 *  listing that has been seen by the whole market and refused by it. */
const STALE_DAYS = 60;

const cache = new TtlCache<ListingResult>(TTL_MS, Number(process.env.LISTINGS_CACHE_MAX ?? 2000));
let token: { value: string; expires: number } | null = null;

async function getToken(): Promise<string | null> {
  const id = process.env.EBAY_APP_ID;
  const secret = process.env.EBAY_CERT_ID;
  if (!id || !secret) return null;
  if (token && Date.now() < token.expires) return token.value;
  try {
    const res = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=client_credentials&scope=" +
        encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!b.access_token) return null;
    // refresh a minute early rather than racing the expiry
    token = { value: b.access_token, expires: Date.now() + (b.expires_in ?? 7200) * 1000 - 60_000 };
    return token.value;
  } catch {
    return null;
  }
}

/** Pull the grading company and grade out of a listing title.
 *  Sellers write "BGS 8.5", "PSA 10 GEM MINT", "CGC 9.5" — enough to tell a
 *  listing for this exact slab from one for a different grade of the same card. */
function gradeFromTitle(title: string): { grader: string | null; grade: number | null } {
  const m = /\b(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|BVG|BCCG)\s*(\d{1,2}(?:\.5)?)\b/i.exec(title);
  if (!m) return { grader: null, grade: null };
  const grader = m[1].toUpperCase() === "BECKETT" ? "BGS" : m[1].toUpperCase();
  const grade = Number(m[2]);
  return { grader, grade: Number.isFinite(grade) && grade >= 1 && grade <= 10 ? grade : null };
}

/** Which Beckett label a listing is for: black | gold | null.
 *
 *  Beckett's 10 is two products — a Black Label needs all four subgrades at
 *  exactly 10 — and our sold-comp source publishes a single `bgs10` key that
 *  blends them. So the only place we can see the difference is in what sellers
 *  write, and the gap is worth about ten times the price: a Destined Rivals
 *  Mewtwo blends to $1,364 while Black Label copies sell above $12,700.
 *
 *  "BLACK" is a minefield in Pokemon and almost none of it is Beckett. Black
 *  Star Promos are an entire promo line, Black Bolt is a set, Black & White is
 *  an era, and MBA Black Diamond is somebody else's product entirely — there
 *  is one in the live listings for the card that prompted this. Each of those
 *  is guarded explicitly rather than hoped about, in the same spirit as the
 *  negative guards that stop a grade token meaning a card is graded.
 *
 *  And a black label only exists at 10. A title claiming one at 9.5 is a
 *  seller being loose with words, not a label. */
export function labelFromTitle(title: string): "black" | "gold" | null {
  const U = title.toUpperCase();

  // not a Beckett label, whatever the word "black" is doing here
  const DECOYS = [
    /\bBLACK\s*STAR\b/,        // Black Star Promos — a promo line
    /\bBLACK\s*BOLT\b/,        // a set
    /\bBLACK\s*(?:&|AND)\s*WHITE\b/, // an era
    /\bBLACK\s*DIAMOND\b/,     // MBA's product, not Beckett's label
  ];
  const decoyed = DECOYS.some((re) => re.test(U));

  const { grader, grade } = gradeFromTitle(title);
  if (grader !== "BGS") return null;

  if (!decoyed && /\bBLACK\s*LABEL\b/.test(U)) {
    // Beckett issues a black label at 10 and nowhere else
    return grade === 10 ? "black" : null;
  }
  if (/\bPRISTINE\b/.test(U) && grade === 10) return "gold";
  return null;
}

export async function fetchListings(opts: {
  name: string;
  setName?: string | null;
  number?: string | null;
  grader?: string | null;
  grade?: number | null;
  /** the slab's Beckett label variant, so asks can be narrowed to it */
  labelVariant?: "black" | "gold" | null;
  /** distinctive words the grading label printed. Used to find listings for
   *  THIS printing when we cannot name the printing — see labeltokens.ts */
  labelTokens?: string[] | null;
  /** internal: stops the label re-search from recursing */
  labelSearchDone?: boolean;
  limit?: number;
  /** everything we know in words about THIS copy — slab label lines, the card's
   *  own OCR, the vision model's printing call. Read for a printing, not
   *  searched on: adding "manga" to the query would hide untitled listings. */
  printingHint?: string | null;
  /** true when the card carries Japanese text */
  japanese?: boolean;
  /** the printing's language, where we could read it off the card. English is
   *  as much a fact as Japanese here: without it a 252-day-old CHINESE listing
   *  at $51 set the ceiling for an English card worth about $130. */
  language?: "en" | "ja" | "zh" | null;
  /** printed identifiers that narrow the search harder than a name does: a set
   *  code ("M2"), a rarity suffix ("SAR"), a treatment ("SP"), a sealed pack's
   *  artwork ("Scyther"). These are what sellers type into their titles. */
  extraTokens?: (string | null | undefined)[];
}): Promise<ListingResult | null> {
  const show = Math.min(opts.limit ?? 12, 24);
  // Fetch wide, show narrow. Printing and grade filtering discard most of what
  // comes back — on OP13-119 only 9 of 100 results are the printing we want —
  // so asking for 12 and filtering leaves nothing to compute a median from.
  const limit = 100;
  // strip glyphs that break eBay's text search the same way they break ours
  const clean = (s: string) => s.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  // The card NUMBER is the single most valuable token in the query. Without it
  // "Portgas.D.Ace Carrying On His Will BGS 9.5" returned a $28 Leader card
  // from the same set; with "OP13-119" the same search returns the actual card
  // at $900-$1,700, which is where its market really is.
  const number = opts.number ? clean(opts.number) : null;
  // A name is one signal among several and not always the best one. On a
  // Japanese card the catalog name is Japanese and the label name comes back
  // from OCR with the spaces gone, while "M2 110/080 SAR" identifies the card
  // exactly and is what every seller writes.
  // A name still carrying an OCR run-on ("MEGA CHARIZARDX eX") searches for a
  // string no seller has ever typed and quietly narrows the pool to the wrong
  // listings. With two or more printed identifiers in hand we are better off
  // without it: "M2 110/080 SAR PSA 10" finds the card exactly.
  const identifiers = (opts.extraTokens ?? []).filter(Boolean).length;
  const gluedRun = /[A-Z]{9,}/.test(opts.name);
  const usableName =
    /[^\u0000-\u007F]/.test(opts.name) || (gluedRun && identifiers >= 2)
      ? ""
      : clean(opts.name);
  const parts = [usableName];
  if (number) parts.push(number);
  else if (opts.setName && !/[^\u0000-\u007F]/.test(opts.setName)) parts.push(clean(opts.setName));
  for (const t of opts.extraTokens ?? []) {
    const c = t ? clean(String(t)) : "";
    // keep the query tight: skip anything already present
    if (c && !parts.some((p) => p.toLowerCase().includes(c.toLowerCase()))) parts.push(c);
  }
  if (opts.grader && opts.grade != null) parts.push(`${opts.grader} ${opts.grade}`);
  const query = parts.filter(Boolean).join(" ").trim();
  if (!query) return null;

  const cardPrinting: Printing = readPrinting(opts.printingHint);
  if (opts.japanese) cardPrinting.language = "ja";
  else if (opts.language && !cardPrinting.language) cardPrinting.language = opts.language;
  const key = `${query}|${show}|${cardPrinting.family ?? ""}|${cardPrinting.language ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tok = await getToken();
  if (!tok) return null;

  try {
    recordUsage("ebay");
    const url =
      `${EBAY}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}` +
      // EXTENDED carries itemCreationDate, which is how long the ask has stood
      `&limit=${limit}&fieldgroups=EXTENDED`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[ebay] listings ${res.status} for "${query}"`);
      return null;
    }
    const body = (await res.json()) as any;
    const items: any[] = body.itemSummaries ?? [];

    const listings: Listing[] = items.map((it) => {
      const rawTitle = String(it.title ?? "");
      const { grader, grade } = gradeFromTitle(rawTitle);
      const labelVariant = labelFromTitle(rawTitle);
      const p = readPrinting(rawTitle);
      return {
        title: rawTitle.slice(0, 140),
        price: it.price?.value != null ? Number(it.price.value) : null,
        currency: String(it.price?.currency ?? "USD"),
        condition: it.condition ?? null,
        imageUrl: it.thumbnailImages?.[0]?.imageUrl ?? it.image?.imageUrl ?? null,
        url: String(it.itemWebUrl ?? ""),
        seller: it.seller?.username ?? null,
        grader,
        grade,
        labelVariant,
        printing: describePrinting(p),
        printingMatch: comparePrinting(cardPrinting, p),
        ageDays: it.itemCreationDate
          ? Math.max(0, Math.round((Date.now() - Date.parse(it.itemCreationDate)) / 86_400_000))
          : null,
      };
    });

    // Drop what is not a single copy of this card before anything else. On the
    // Charizard these were a $165 "read description" listing and an $11,250
    // bundle, sitting at opposite ends and both pulling the middle.
    let filtered = listings.filter((l) => !NOT_ONE_CARD.test(l.title));
    if (filtered.length < 3) filtered = listings;

    // Drop listings whose title carries a DIFFERENT card number. Sellers put the
    // number in the title, so this is a cheap and reliable way to reject the
    // wrong card from the right set — which is most of the noise.
    if (number) {
      const wanted = number.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const sameCard = listings.filter((l) => {
        const t = l.title.toUpperCase().replace(/[^A-Z0-9]/g, "");
        return t.includes(wanted);
      });
      if (sameCard.length >= 2) filtered = sameCard;
    }

    // When we know the card's grade, surface listings for THAT grade —
    // a PSA 10 asking price tells the owner of a PSA 5 very little.
    let filteredToGrade = false;
    let filteredToLabel = false;
    if (opts.grader && opts.grade != null) {
      const exact = filtered.filter(
        (l) => l.grader === opts.grader && l.grade === opts.grade,
      );
      if (exact.length >= 2) {
        filtered = exact;
        filteredToGrade = true;
      }
    }

    // Narrow to the printing the LABEL names, whether or not we can name it.
    //
    // This runs before the variant and printing filters because it is the
    // most authoritative signal available: a grading company examined the card
    // and wrote down what it is. A PSA MAGAZINE EXCLUSIVE Luffy and the
    // OP05-060 Leader share a collector number and nothing else — $615 against
    // $0.65 raw — and no allowlist of printing names was ever going to keep up
    // with the promo lines that produce that gap.
    let filteredToLabelText = false;
    if (opts.labelTokens && opts.labelTokens.length) {
      const sameProduct = filtered.filter((l) =>
        listingMatchesLabel(l.title, opts.labelTokens!),
      );
      // two or more, or we are narrowing on one listing rather than on evidence
      if (sameProduct.length >= 2) {
        filtered = sameProduct;
        filteredToLabelText = true;
      } else if (!opts.labelSearchDone) {
        // Nothing in these results is the printing on the label — and no
        // amount of filtering rescues a search that never fetched it. The
        // query was built from the card we IDENTIFIED, and if that
        // identification landed on the base card sharing the number, the
        // promo's listings are not in this result set at all.
        //
        // So ask again with the label's own words in the query. Deliberately
        // a SECOND search rather than a narrower first one: adding a printing
        // to every query hides the listings that do not mention it, which is
        // why the query is kept broad by default. This runs only when the
        // broad result demonstrably contains the wrong product.
        const narrowed = await fetchListings({
          ...opts,
          extraTokens: [...(opts.extraTokens ?? []), ...opts.labelTokens],
          labelSearchDone: true,
        });
        if (narrowed && narrowed.matched >= 2) {
          console.log(
            `[listings] broad search found no "${opts.labelTokens[0]}" listings; ` +
              `re-searched with the label's own words and found ${narrowed.matched}`,
          );
          return narrowed;
        }
      }
    }

    // Narrow again to the LABEL VARIANT where we know it.
    //
    // "BGS 10" is not one price. A Black Label — all four subgrades exactly 10
    // — and a gold-label Pristine share that string, and on the card that
    // prompted this the gap is roughly ten times: blended sold comps put BGS 10
    // near $1,364 while Black Label copies ask and sell above $12,700. Leaving
    // them mixed produces a median that describes neither.
    //
    // Same bar as the grade filter: at least two, or we are not narrowing on
    // evidence, we are narrowing on one listing.
    if (opts.labelVariant) {
      const sameLabel = filtered.filter((l) => l.labelVariant === opts.labelVariant);
      if (sameLabel.length >= 2) {
        filtered = sameLabel;
        filteredToLabel = true;
      }
    }
    // Narrow to OUR printing. This is the difference between pricing a card and
    // pricing a card number: the four printings of OP13-119 that share a number
    // ask $82 and $8,200 for the same three digits.
    //
    // Only listings that positively declare our printing are kept, and only
    // when enough of them exist to stand on their own. Silent listings are not
    // evidence against us, but they are not evidence for us either, and a
    // median built mostly on silence is the mixed figure we set out to remove.
    let filteredToPrinting = false;
    const otherPrintings: ListingResult["otherPrintings"] = [];
    if (cardPrinting.family || cardPrinting.language) {
      const matched = filtered.filter((l) => l.printingMatch === "match");
      const conflicting = filtered.filter((l) => l.printingMatch === "conflict");
      if (matched.length >= 3) {
        // report what we set aside, so the interface can name the alternatives
        const byName = new Map<string, number[]>();
        for (const l of conflicting) {
          if (l.price == null) continue;
          const n = l.printing ?? "other printing";
          byName.set(n, [...(byName.get(n) ?? []), l.price]);
        }
        for (const [name, ps] of byName) {
          ps.sort((a, b) => a - b);
          otherPrintings.push({ name, count: ps.length, low: ps[0], high: ps[ps.length - 1] });
        }
        otherPrintings.sort((a, b) => b.count - a.count);
        filtered = matched;
        filteredToPrinting = true;
      }
    }

    filtered.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

    // One listing relisted three times is one data point, not three. The 1999
    // Jungle pack search returned the same $4,750 multi-pack set three times
    // over, which on six results moved the median from $1,400 to $3,125.
    const seenListing = new Set<string>();
    const deduped = filtered.filter((l) => {
      const k = `${l.title.toLowerCase().replace(/\s+/g, " ").trim()}|${l.price ?? ""}`;
      if (seenListing.has(k)) return false;
      seenListing.add(k);
      return true;
    });

    const priced = deduped.filter((l) => l.price != null && l.url);
    const all = priced.map((l) => l.price as number).sort((a, b) => a - b);

    // Trim the extremes before taking the middle. Marketplace asks have a long
    // right tail — a seller who lists at ten times market loses nothing by
    // leaving it up — and a thin left tail of bait and misdescribed listings.
    // Neither end carries information about what the card trades at, so with
    // enough samples to afford it we cut a tenth off each end first.
    const cut = all.length >= 8 ? Math.floor(all.length * 0.1) : 0;
    const values = cut > 0 ? all.slice(cut, all.length - cut) : all;
    const rawMedian =
      values.length === 0
        ? null
        : values.length % 2
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;

    // What a listing FAILS to do is information too.
    //
    // The pool of live asks is survivorship-biased upward: a copy priced at
    // market sells and leaves, while one priced above market stays, renews, and
    // accumulates. Read naively the pool therefore drifts above the real price
    // — on a One Piece Ace the median ask was a listing that had sat unsold for
    // 199 days, quoted as the card's value against a A$1,000 sale.
    //
    // But an ask that has stood for two months without a buyer is proof the
    // market is below it. The cheapest such ask is the tightest upper bound the
    // live pool can give us, and it is a fact about this card rather than a
    // discount applied to one.
    const stale = priced
      .filter((l) => (l.ageDays ?? 0) >= STALE_DAYS && l.price != null)
      .sort((a, b) => (a.price as number) - (b.price as number));
    const ceilingListing = stale[0] ?? null;
    const staleCeiling = ceilingListing?.price ?? null;
    const cappedByStale = rawMedian != null && staleCeiling != null && staleCeiling < rawMedian;
    const median = cappedByStale ? staleCeiling : rawMedian;

    const v: ListingResult = {
      listings: priced.slice(0, show),
      total: Number(body.total ?? priced.length),
      matched: priced.length,
      query,
      filteredToGrade,
      filteredToLabel,
      filteredToLabelText,
      medianAsk: median,
      askLow: values[0] ?? null,
      askHigh: values[values.length - 1] ?? null,
      trimmed: cut > 0 ? cut * 2 : 0,
      staleCeiling,
      staleCeilingDays: ceilingListing?.ageDays ?? null,
      cappedByStale,
      printing: describePrinting(cardPrinting),
      filteredToPrinting,
      otherPrintings,
    };
    cache.set(key, v);
    return v;
  } catch (err) {
    console.warn(`[ebay] listings failed for "${query}": ${(err as Error).message}`);
    return null;
  }
}
