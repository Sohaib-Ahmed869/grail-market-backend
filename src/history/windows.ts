import type { FxRates } from "../scans/fx.js";
import type { Sale } from "../sales/ledger.js";
import { inCurrency, medianOf, setAsideOutliers } from "../sales/guidance.js";

// What one exact card has done lately, from OUR OWN records.
//
// GM001-28 asks for last sale, 7-day and 30-day figures per variant and grade.
// The card page used to take every percentage from the JustTCG feed — one line
// per card, blind to grade, so a PSA 10 and a raw copy moved together on
// screen whatever the market did. Here the key is the full (card, grader,
// grade), per invariant 1, and the evidence is ours:
//
//   - `sales_ledger`: itemised settled sales. The 7 and 30-day windows are
//     built from these, because a sale is what somebody actually paid.
//   - `price_points`: the stored daily price for the same key. Close-to-close
//     movement from those is returned as `daily7`/`daily30`, labelled as
//     such — it is our own record of a provider figure, not a sale.
//
// THE RULES, so they are written down rather than rediscovered:
//
//   - Headline figures are MEDIANS, not means: one sale at twice the price
//     moves a mean and barely touches a median. The mean is returned too.
//   - Outliers are set aside first, by the same rule listing guidance uses
//     (three times, or a third of, the window's median) — see guidance.ts.
//   - A window needs MIN_WINDOW_SALES sales to carry a figure. Below that it
//     reports how many sales it has and nothing else: one sale is a fact about
//     one transaction, not a price for the week.
//   - A change % needs MIN_WINDOW_SALES in BOTH the window and the equal
//     window before it. Otherwise it is null, never a guess.
//   - Every sale is converted to the target currency before any arithmetic;
//     the ledger holds AUD, USD and GBP rows for the same card. A currency we
//     hold no rate for is left out and counted in `unconvertible`.

export const MIN_WINDOW_SALES = 2;
const DAY = 86_400_000;

export type WindowStat = {
  days: number;
  /** sales used, after outliers were set aside */
  count: number;
  excluded: number;
  median: number | null;
  mean: number | null;
  low: number | null;
  high: number | null;
  /** median vs the median of the equal window before this one */
  changePct: number | null;
  previousCount: number;
  confidence: "high" | "medium" | "low" | "none";
};

export type DailyMove = {
  days: number;
  changePct: number | null;
  /** daily prices recorded within the period */
  observed: number;
  from: string | null;
  to: string | null;
};

export type SalesWindows = {
  currency: string;
  lastSale: {
    aud: number | null; usd: number | null; price: number; currency: string;
    soldAt: string; source: string;
  } | null;
  window7: WindowStat;
  window30: WindowStat;
  daily7: DailyMove;
  daily30: DailyMove;
  /** sales we could not convert and so did not count */
  unconvertible: number;
  /** newest evidence of either kind: last sale time, or last daily price day */
  asOf: string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function confidenceOf(count: number, median: number | null, low: number | null, high: number | null): WindowStat["confidence"] {
  if (count < MIN_WINDOW_SALES || median == null || low == null || high == null || median <= 0) return "none";
  const spread = (high - low) / median;
  if (count >= 5 && spread <= 0.25) return "high";
  if (count >= 3 && spread <= 0.5) return "medium";
  return "low";
}

function statFor(prices: number[]): Omit<WindowStat, "days" | "changePct" | "previousCount"> {
  const { kept, excluded } = setAsideOutliers(prices, (p) => p);
  const count = kept.length;
  if (count < MIN_WINDOW_SALES) {
    return { count, excluded, median: null, mean: null, low: null, high: null, confidence: "none" };
  }
  const median = round2(medianOf(kept));
  const mean = round2(kept.reduce((n, p) => n + p, 0) / count);
  const low = round2(Math.min(...kept));
  const high = round2(Math.max(...kept));
  return { count, excluded, median, mean, low, high, confidence: confidenceOf(count, median, low, high) };
}

function windowOf(
  priced: { t: number; price: number }[], days: number, now: number,
): WindowStat {
  const span = days * DAY;
  const current = priced.filter((x) => x.t > now - span && x.t <= now).map((x) => x.price);
  const previous = priced.filter((x) => x.t > now - 2 * span && x.t <= now - span).map((x) => x.price);
  const cur = statFor(current);
  const prev = statFor(previous);
  const changePct =
    cur.median != null && prev.median != null && prev.median > 0
      ? round1(((cur.median - prev.median) / prev.median) * 100)
      : null;
  return { days, ...cur, changePct, previousCount: prev.count };
}

function dailyMove(points: { day: string; price: number }[], days: number): DailyMove {
  const ordered = points
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
  const last = ordered[ordered.length - 1];
  if (!last) return { days, changePct: null, observed: 0, from: null, to: null };
  const cutoff = new Date(Date.parse(`${last.day}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
  // The close on or before the start of the period. Without one, the history
  // does not reach back that far and there is no honest change to report.
  const base = [...ordered].reverse().find((p) => p.day <= cutoff) ?? null;
  const observed = ordered.filter((p) => p.day >= cutoff).length;
  if (!base) return { days, changePct: null, observed, from: null, to: last.day };
  return {
    days,
    changePct: round1(((last.price - base.price) / base.price) * 100),
    observed,
    from: base.day,
    to: last.day,
  };
}

/** Last sale, 7 and 30-day windows, and daily-price movement for ONE key.
 *
 *  `sales` must already be for exactly one (card, grader, grade) and
 *  `points` the daily prices for that same key. Pure, so every rule above is
 *  pinned by fixtures in test/saleswindows.test.mjs. */
export function salesWindows(
  sales: Sale[],
  points: { day: string; price: number }[],
  fx: FxRates,
  now = Date.now(),
  currency = "AUD",
): SalesWindows {
  const to = currency.toUpperCase();
  const ordered = [...sales].sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt));

  let unconvertible = 0;
  const priced: { t: number; price: number }[] = [];
  for (const s of ordered) {
    const p = inCurrency(s, to, fx);
    if (p == null || !(p > 0)) { unconvertible += 1; continue; }
    priced.push({ t: Date.parse(s.soldAt), price: p });
  }

  const newest = ordered[0] ?? null;
  const lastSale = newest
    ? {
        aud: (() => { const v = inCurrency(newest, "AUD", fx); return v == null ? null : round2(v); })(),
        usd: (() => { const v = inCurrency(newest, "USD", fx); return v == null ? null : round2(v); })(),
        price: newest.price,
        currency: (newest.currency || "USD").toUpperCase(),
        soldAt: newest.soldAt,
        source: newest.source,
      }
    : null;

  const lastPointDay = [...points].sort((a, b) => b.day.localeCompare(a.day))[0]?.day ?? null;
  const asOf = [newest?.soldAt ?? null, lastPointDay]
    .filter((x): x is string => x != null)
    .sort((a, b) => Date.parse(b.length === 10 ? `${b}T23:59:59Z` : b) - Date.parse(a.length === 10 ? `${a}T23:59:59Z` : a))[0] ?? null;

  return {
    currency: to,
    lastSale,
    window7: windowOf(priced, 7, now),
    window30: windowOf(priced, 30, now),
    daily7: dailyMove(points, 7),
    daily30: dailyMove(points, 30),
    unconvertible,
    asOf,
  };
}
