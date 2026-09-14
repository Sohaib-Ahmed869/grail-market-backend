import type { FxRates } from "../scans/fx.js";
import type { Sale } from "./ledger.js";

// What to list a card for, from settled sales.
//
// The rule is Ahmed's, given on 11 September and recorded on GM001-59:
// settled sales, never asking prices; average the three most recent PROVIDED
// they fall close together in time; present a recommended range the seller may
// list above or below. And explicitly: do not average a sale from six months
// ago against a recent one.
//
// That last clause is the whole reason this is not a three-row average. Two
// sales last week and one from February are not a market — they are two facts
// and a memory, and meaning them together produces a number that was never
// true on any day. So the window is checked BEFORE the mean, and a set that
// fails it is reported as unusable with the reason attached rather than
// quietly averaged anyway.
//
// Invariant 6 names the shape: three points — quick sale, market, patient ask
// — with the last sale date attached. Invariant 1 names the key: this is only
// ever computed for one (card, grader, grade), never across graders.

/** How far apart the sales used may sit. Beyond this they are not describing
 *  the same market. Ahmed's example of what must NOT happen is six months;
 *  this is deliberately tighter, because a card can move a long way in a
 *  quarter and the seller is about to act on the number. */
export const MAX_SPREAD_DAYS = 60;

/** How many settled sales the rule asks for. */
export const WANTED = 3;

/** Discount for a fast sale, and premium for a patient one, either side of the
 *  settled mean. These are listing ADVICE, not claims about value: the mean is
 *  what the market paid, and the range is how long you are willing to wait. */
const QUICK = 0.88;
const PATIENT = 1.12;

export type Guidance = {
  quick: number;
  market: number;
  patient: number;
  currency: string;
  /** how many settled sales the figures are built from */
  sampleSize: number;
  /** the newest sale used, so the reader can judge how current this is */
  lastSaleAt: string;
  /** days between the oldest and newest sale used */
  spreadDays: number;
  confidence: "high" | "medium" | "low";
  sales: { price: number; soldAt: string; source: string }[];
};

export type NoGuidance = {
  reason: "no-sales" | "too-few" | "too-spread" | "no-rate";
  message: string;
  /** what we did have, so a screen can still say "one sale, in March" */
  sampleSize: number;
  lastSaleAt: string | null;
};

const DAY = 86_400_000;
const days = (a: string | Date, b: string | Date) =>
  Math.abs(new Date(a).getTime() - new Date(b).getTime()) / DAY;

/** Convert a sale into the target currency, or null when we cannot.
 *
 *  Mixed currencies are not hypothetical: the sold-comp feed writes AUD, USD
 *  and GBP rows into the same ledger for the same card. Averaging those as
 *  bare numbers would produce a figure in no currency at all. */
function inCurrency(s: Sale, to: string, fx: FxRates): number | null {
  const from = (s.currency || "USD").toUpperCase();
  if (from === to) return s.price;
  const a = fx.rates[to];
  const b = fx.rates[from];
  if (!a || !b) return null;
  return s.price * (a / b);
}

/** The three-point listing range for one exact (card, grader, grade).
 *
 *  `sales` must already be for that key and newest-first — `recentSales()`
 *  returns exactly that. Pure, so the window rule and the currency rule can be
 *  pinned by fixtures without a database. */
export function listingGuidance(
  sales: Sale[],
  fx: FxRates,
  currency = "AUD",
): Guidance | NoGuidance {
  const to = currency.toUpperCase();

  if (!sales.length) {
    return {
      reason: "no-sales",
      message: "No settled sale on record for this card at this grade.",
      sampleSize: 0,
      lastSaleAt: null,
    };
  }

  // Newest first, defensively — the caller's ordering is not something this
  // should depend on, because getting it backwards would silently build the
  // range out of the OLDEST three sales.
  const ordered = [...sales].sort(
    (a, b) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime(),
  );
  const newest = ordered[0]!.soldAt;

  const converted = ordered
    .map((s) => ({ s, price: inCurrency(s, to, fx) }))
    .filter((x): x is { s: Sale; price: number } => x.price != null && x.price > 0);

  if (!converted.length) {
    return {
      reason: "no-rate",
      message: `Sales are recorded in a currency we cannot convert to ${to} right now.`,
      sampleSize: 0,
      lastSaleAt: newest,
    };
  }

  const used = converted.slice(0, WANTED);

  if (used.length < WANTED) {
    return {
      reason: "too-few",
      message:
        `Only ${used.length} settled sale${used.length === 1 ? "" : "s"} on record. ` +
        `A recommended range needs ${WANTED}.`,
      sampleSize: used.length,
      lastSaleAt: newest,
    };
  }

  // The window rule, before the arithmetic.
  const spread = days(used[0]!.s.soldAt, used[used.length - 1]!.s.soldAt);
  if (spread > MAX_SPREAD_DAYS) {
    return {
      reason: "too-spread",
      message:
        `The last ${WANTED} sales span ${Math.round(spread)} days, which is too far apart ` +
        `to average — the oldest is not describing today's market.`,
      sampleSize: used.length,
      lastSaleAt: newest,
    };
  }

  const mean = used.reduce((n, x) => n + x.price, 0) / used.length;
  const round = (n: number) => Math.round(n * 100) / 100;

  // Confidence is about how tightly the sales agree, not how many there are —
  // three sales at 100, 102 and 101 is a price; three at 40, 100 and 260 is
  // three different cards wearing one grade.
  const lo = Math.min(...used.map((x) => x.price));
  const hi = Math.max(...used.map((x) => x.price));
  const dispersion = mean > 0 ? (hi - lo) / mean : 1;
  const confidence = dispersion <= 0.15 ? "high" : dispersion <= 0.4 ? "medium" : "low";

  return {
    quick: round(mean * QUICK),
    market: round(mean),
    patient: round(mean * PATIENT),
    currency: to,
    sampleSize: used.length,
    lastSaleAt: used[0]!.s.soldAt,
    spreadDays: Math.round(spread),
    confidence,
    sales: used.map((x) => ({
      price: round(x.price),
      soldAt: x.s.soldAt,
      source: x.s.source,
    })),
  };
}

export const hasGuidance = (g: Guidance | NoGuidance): g is Guidance =>
  !("reason" in g);
