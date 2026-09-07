// Daily closes, aggregated into bars.
//
// A candle needs an open, a high, a low and a close. No feed we have gives
// those per day — JustTCG returns one price per day and nothing else. What it
// does give, and what our own price_points accumulates, is a series of daily
// closes, and a bar over a WEEK made of seven daily closes is genuinely
// OHLC: the open is the first day, the close is the last, and the high and
// low are the extremes in between.
//
// That is the honest way to get candles out of this data, and it is the
// ordinary way charts are built from closes. What is NOT honest is a daily
// candle from one daily price, where three of the four values would be
// invented — so a bar is never shorter than the data underneath it.

export type Close = { day: string; price: number };

export type Candle = {
  /** First day in the bar, YYYY-MM-DD. */
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** How many daily readings went into it. A bar built from two days is not
   *  the same claim as one built from seven, and the caller should be able to
   *  say so. */
  readings: number;
};

export type Bucket = "day" | "week" | "month";

/** Which bucket a day belongs to. Weeks start Monday, the way a trading week
 *  is quoted. */
export function bucketOf(day: string, bucket: Bucket): string {
  if (bucket === "day") return day;
  const d = new Date(`${day}T00:00:00Z`);
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  // Monday of this week: getUTCDay is 0 for Sunday, so Sunday goes back six.
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

/** Closes to candles.
 *
 *  Input must be oldest first; anything else is sorted rather than trusted,
 *  because a series assembled from two sources is a series in no order at
 *  all and the open and close depend entirely on it.
 */
export function candles(closes: Close[], bucket: Bucket): Candle[] {
  const clean = [...closes]
    .filter((c) => c && Number.isFinite(c.price) && c.price > 0 && /^\d{4}-\d{2}-\d{2}$/.test(c.day))
    .sort((a, b) => a.day.localeCompare(b.day));
  if (!clean.length) return [];

  const out: Candle[] = [];
  let current: Candle | null = null;
  let key = "";

  for (const c of clean) {
    const k = bucketOf(c.day, bucket);
    if (k !== key) {
      if (current) out.push(current);
      key = k;
      current = {
        day: k, open: c.price, high: c.price, low: c.price, close: c.price, readings: 1,
      };
      continue;
    }
    current!.high = Math.max(current!.high, c.price);
    current!.low = Math.min(current!.low, c.price);
    current!.close = c.price;
    current!.readings += 1;
  }
  if (current) out.push(current);
  return out;
}

/** The ranges a chart can offer, and whether there is data behind each.
 *
 *  A picker whose buttons all redraw the same six points is worse than no
 *  picker — it claims a year of history that does not exist. A range is
 *  offered only when the series actually reaches back into it.
 */
// The options name the BAR, not the window.
//
// They used to say 1W / 1M / 6M / 1Y, which is a claim about how far back the
// data goes — and a "1Y" button over a fortnight of history draws a fortnight
// under a label saying a year. Worse, it hid the candles: the only range a new
// history could offer was the daily one, and a daily bar is a single reading,
// so the chart was dashes even though the weekly bars underneath were real.
//
// Naming the bar makes every option honest the moment it has two bars to draw,
// and "Weekly" over three weeks of data is exactly what it says it is.
export const RANGES = [
  { id: "D", label: "Daily", days: 60, bucket: "day" as Bucket },
  { id: "W", label: "Weekly", days: 400, bucket: "week" as Bucket },
  { id: "M", label: "Monthly", days: 1200, bucket: "month" as Bucket },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];

/** Which bar sizes this series can actually draw.
 *
 *  Two bars is the floor. One bar is not a chart — it is a single rectangle,
 *  and offering a button that draws one is offering a button that does
 *  nothing. */
export function availableRanges(closes: Close[]): RangeId[] {
  if (closes.length < 2) return [];
  return RANGES.filter((r) => {
    const buckets = new Set(closes.map((c) => bucketOf(c.day, r.bucket)));
    return buckets.size >= 2;
  }).map((r) => r.id);
}
