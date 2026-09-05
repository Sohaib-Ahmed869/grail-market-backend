import { TtlCache } from "../scans/ttlcache.js";
import { PLANS, priceIdFor, type Plan } from "./plans.js";

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
// Resolution, per plan:
//   1. the product's default_price, if it is active and recurring
//   2. otherwise the single active recurring price on that product
//   3. otherwise nothing — and a plan we cannot price is not offered
//
// Step 3 is the rule this project applies everywhere else, arriving in
// billing: a missing answer is cheap and a confident wrong one is expensive.
// Two active prices and no default is genuinely ambiguous, and charging the
// one that sorts first is exactly how a customer is billed an amount nobody
// chose.

const API = "https://api.stripe.com/v1";

export type LivePrice = {
  priceId: string;
  amountCents: number;
  currency: string;
  /** Whether Stripe's figure differs from the constant in plans.ts. Surfaced
   *  so the mismatch is visible rather than silently papered over. */
  driftedFrom: number | null;
};

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

/** Every plan's live price, keyed by plan id. Plans Stripe cannot price are
 *  absent from the map rather than present with a guess. */
export async function livePrices(): Promise<Map<string, LivePrice>> {
  const hit = cache.get(KEY);
  if (hit) return hit;

  const out = new Map<string, LivePrice>();
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return out;

  let prices: StripePrice[] = [];
  try {
    // Expanding the product carries default_price back on the same call, so
    // three plans cost one request instead of nine. 100 covers every price
    // this account will ever hold for three products; if that stops being
    // true the map simply misses a plan, which fails closed.
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

  for (const plan of PLANS) {
    const pinned = priceIdFor(plan);
    if (!pinned) continue;
    // The pinned price may well be archived — that is the whole situation this
    // exists for. It is read only to learn which product it belongs to.
    const anchor = prices.find((p) => p.id === pinned);
    if (!anchor) continue;
    const productId = productOf(anchor);

    const live = prices.filter(
      (p) =>
        productOf(p) === productId &&
        p.active &&
        p.recurring != null &&
        typeof p.unit_amount === "number",
    );
    if (live.length === 0) continue;

    const preferred = defaultPriceOf(anchor);
    const chosen =
      live.find((p) => p.id === preferred) ??
      (live.length === 1 ? live[0] : null);
    // Several active prices and none of them the product default. Stripe has
    // not said which one is current and neither will we.
    if (!chosen) continue;

    out.set(plan.id, {
      priceId: chosen.id,
      amountCents: chosen.unit_amount as number,
      currency: chosen.currency.toUpperCase(),
      driftedFrom: chosen.unit_amount === plan.amountCents ? null : plan.amountCents,
    });
  }

  cache.set(KEY, out);
  return out;
}

/** One plan's live price, or null when Stripe cannot tell us. */
export async function livePriceFor(plan: Plan | string): Promise<LivePrice | null> {
  const id = typeof plan === "string" ? plan : plan.id;
  return (await livePrices()).get(id) ?? null;
}
