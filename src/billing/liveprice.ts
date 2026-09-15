import { TtlCache } from "../scans/ttlcache.js";
import { PAID_PLANS, priceIdFor, type Plan } from "./plans.js";

// What each plan actually costs, according to Stripe.
//
// `amountCents` in plans.ts is a display figure typed by hand, and the price
// charged is whatever Stripe holds. Nothing read Stripe at runtime, so the two
// could only ever agree by luck, and on 4 Sep they stopped: Collector was
// edited in the dashboard, which does not mutate a price — Stripe prices are
// immutable, so an edit ARCHIVES the old one and creates a new id. The app
// went on printing A$10 from the constant, and checkout went on pointing
// STRIPE_PRICE_COLLECTOR at the archived price, which Stripe refuses outright:
// "The price specified is inactive." The plan was not merely mispriced, it was
// unbuyable, and nothing in the app could tell.
//
// So the price id in the environment is treated as a pointer to a PRODUCT
// rather than to a price. An archived price still resolves and still names its
// product, which is what makes this work without new configuration: the env
// var that broke is the same env var that repairs it.
//
// Resolution is per plan and per interval — a product holds a monthly and a
// yearly price — and is spelled out on `resolvePlanPrices` below.
//
// Nothing resolvable means the plan (or that interval) is not offered. This
// is the rule this project applies everywhere else, arriving in billing: a
// missing answer is cheap and a confident wrong one is expensive.

const API = "https://api.stripe.com/v1";

export type PriceOption = {
  priceId: string;
  amountCents: number;
  currency: string;
  /** Whether Stripe's figure differs from the configured one in plans.ts.
   *  Surfaced so the mismatch is visible rather than silently papered over. */
  driftedFrom: number | null;
};

/** A plan's live prices. The top-level fields are the MONTHLY price, as they
 *  always were; `annual` is the yearly price where Stripe holds exactly one.
 *  A plan appears in the map only when its monthly price resolves. */
export type LivePrice = PriceOption & { annual: PriceOption | null };

type StripePrice = {
  id: string;
  active: boolean;
  unit_amount: number | null;
  currency: string;
  recurring?: { interval?: string } | null;
  product: string | { id: string; default_price?: string | null };
};

// One Stripe call serves every plan, and prices change by hand at human pace.
// Five minutes is short enough that a dashboard edit shows up while the person
// who made it is still looking, and long enough that the plans screen is not a
// Stripe request per open.
const cache = new TtlCache<Map<string, LivePrice>>(5 * 60 * 1000, 4);
const KEY = "all";

const productOf = (p: StripePrice): string =>
  typeof p.product === "string" ? p.product : p.product.id;

const defaultPriceOf = (p: StripePrice): string | null =>
  typeof p.product === "string" ? null : p.product.default_price ?? null;

const option = (chosen: StripePrice, configured: number | null): PriceOption => ({
  priceId: chosen.id,
  amountCents: chosen.unit_amount as number,
  currency: chosen.currency.toUpperCase(),
  driftedFrom: configured == null || chosen.unit_amount === configured ? null : configured,
});

/** One plan's prices out of the account's price list, per interval.
 *
 *  A product now carries a monthly AND a yearly price, so "the single active
 *  recurring price" is two prices and would read as ambiguous — hiding a plan
 *  that is perfectly sellable. Each interval is resolved on its own:
 *
 *    month  the product's default_price if it is an active monthly price,
 *           else the single active monthly price, else nothing
 *    year   the pinned yearly price if active, else the default_price if it
 *           is an active yearly price, else the single active yearly price,
 *           else nothing
 *
 *  Several candidates and nothing saying which is current is still refused:
 *  charging the one that sorts first is how somebody is billed an amount
 *  nobody chose. Exported for the tests. */
export function resolvePlanPrices(
  plan: Plan, prices: StripePrice[], pinnedMonth: string, pinnedYear: string,
): LivePrice | null {
  const anchor = prices.find((p) => p.id === pinnedMonth) ?? prices.find((p) => p.id === pinnedYear);
  if (!anchor) return null;
  const productId = productOf(anchor);
  const live = prices.filter(
    (p) => productOf(p) === productId && p.active && p.recurring != null && typeof p.unit_amount === "number",
  );
  const preferred = defaultPriceOf(anchor);
  const pick = (interval: "month" | "year", pinned: string): StripePrice | null => {
    const inInterval = live.filter((p) => (p.recurring?.interval ?? "month") === interval);
    if (!inInterval.length) return null;
    // Monthly never trusts the pinned id to choose: it is the env var that
    // goes stale when the console edits a price, and an old price can stay
    // active beside the new one. The product default is what the console
    // moves. Yearly has no console edit, so the pin is still a fair tiebreak.
    const named = interval === "month" ? [preferred] : [pinned, preferred];
    for (const id of named) {
      const hit = id ? inInterval.find((p) => p.id === id) : undefined;
      if (hit) return hit;
    }
    return inInterval.length === 1 ? inInterval[0]! : null;
  };
  const month = pick("month", pinnedMonth);
  if (!month) return null;
  const year = pick("year", pinnedYear);
  return { ...option(month, plan.amountCents), annual: year ? option(year, plan.annualCents) : null };
}

/** Every paid plan's live prices, keyed by plan id. Plans Stripe cannot price
 *  are absent from the map rather than present with a guess. */
export async function livePrices(): Promise<Map<string, LivePrice>> {
  const hit = cache.get(KEY);
  if (hit) return hit;

  const out = new Map<string, LivePrice>();
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return out;

  let prices: StripePrice[] = [];
  try {
    // Expanding the product carries default_price back on the same call, so
    // every plan costs one request. 100 covers every price this account will
    // hold for these products; if that stops being true the map simply
    // misses a plan, which fails closed.
    const res = await fetch(
      `${API}/prices?limit=100&expand[]=data.product`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return out;
    prices = ((await res.json()) as { data?: StripePrice[] })?.data ?? [];
  } catch {
    // Stripe unreachable is not a licence to invent a price.
    return out;
  }

  for (const plan of PAID_PLANS) {
    const pinnedMonth = priceIdFor(plan, "month");
    const pinnedYear = priceIdFor(plan, "year");
    if (!pinnedMonth && !pinnedYear) continue;
    // The pinned price may well be archived — that is the situation this
    // exists for. It is read only to learn which product it belongs to.
    const resolved = resolvePlanPrices(plan, prices, pinnedMonth, pinnedYear);
    if (resolved) out.set(plan.id, resolved);
  }

  cache.set(KEY, out);
  return out;
}

/** One plan's live prices, or null when Stripe cannot tell us. */
export async function livePriceFor(plan: Plan | string): Promise<LivePrice | null> {
  const id = typeof plan === "string" ? plan : plan.id;
  return (await livePrices()).get(id) ?? null;
}
