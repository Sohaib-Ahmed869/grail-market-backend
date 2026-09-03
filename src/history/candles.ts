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
export const RANGES = [
  // 1W is daily, and daily is one reading a bar — so it draws as dashes, not
  // candles. That is correct and it is also the only range a brand-new
  // history can offer, which is why 1M buckets by WEEK rather than by day:
  // a month of daily dashes is thirty marks saying one thing each, where a
  // month of weekly bars is four real candles. It is both the better chart
  // and the first one that can exist.
  { id: "1W", days: 7, bucket: "day" as Bucket },
  { id: "1M", days: 30, bucket: "week" as Bucket },
  { id: "6M", days: 182, bucket: "week" as Bucket },
  { id: "1Y", days: 365, bucket: "month" as Bucket },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];

/** Which ranges this series can honestly draw.
 *
 *  A range needs enough span to be a different picture from the one below it;
 *  offering 1Y over eight days of data draws the same eight days under a
 *  label that says a year. */
export function availableRanges(closes: Close[], now = new Date()): RangeId[] {
  if (closes.length < 2) return [];
  const oldest = closes.reduce((a, b) => (a.day < b.day ? a : b)).day;
  const spanDays =
    (now.getTime() - new Date(`${oldest}T00:00:00Z`).getTime()) / 86_400_000;
  // Half the window is enough to be worth showing — a "1M" over eighteen days
  // is still a month's worth of shape, where three days is not.
  return RANGES.filter((r) => spanDays >= r.days / 2).map((r) => r.id);
}
