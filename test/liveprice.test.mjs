// Collector, as Stripe actually held it on 4 Sep 2026.
//
// The owner edited the price in the dashboard. Stripe prices are immutable, so
// that archived price_1UAlLq (A$10) and minted price_1UBsWZ (A$11); then they
// changed their mind, which archived THAT and minted price_1UBscD (A$10) and
// set it as the product default. Three prices, two of them dead.
//
// STRIPE_PRICE_COLLECTOR still named the first one. The app printed A$10 from
// the constant in plans.ts and checkout sent an archived id, which Stripe
// refuses: "The price specified is inactive. This field only accepts active
// prices." The plan was unbuyable and nothing in the app could tell.
//
// Starter and Dealer are in the fixture too, untouched and with no
// default_price on the product, because the resolver must not break the plans
// that were fine. Starter has since been retired (GM001-32): it is still in
// Stripe but no longer offered, so it is no longer resolved.
import { test } from "node:test";
import assert from "node:assert/strict";

const COLLECTOR = "prod_VB7b3qrk7SpzbT";
const DEALER = "prod_VB7b47rQBiqngR";
const STARTER = "prod_VB7bUv8aYN86gS";

const price = (id, product, cents, active, defaultPrice = null) => ({
  id, active, unit_amount: cents, currency: "aud", recurring: { interval: "month" },
  product: { id: product, default_price: defaultPrice },
});

const REAL = [
  price("price_1UAlLqETuJs3mqsF7f9jgdmw", COLLECTOR, 1000, false, "price_1UBscDETuJs3mqsF84AkvA1d"),
  price("price_1UBsWZETuJs3mqsFkubStoeO", COLLECTOR, 1100, false, "price_1UBscDETuJs3mqsF84AkvA1d"),
  price("price_1UBscDETuJs3mqsF84AkvA1d", COLLECTOR, 1000, true, "price_1UBscDETuJs3mqsF84AkvA1d"),
  price("price_1UAlLrETuJs3mqsFqxIAAxrD", DEALER, 2000, true, null),
  price("price_1UAlLoETuJs3mqsFrtbAOY8x", STARTER, 500, true, null),
];

/** Run livePrices() against a canned /v1/prices response. The module caches
 *  for five minutes, so each case re-imports it with a cache-busting query. */
async function resolve(data, env = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const saved = { ...process.env };
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_PRICE_STARTER: "price_1UAlLoETuJs3mqsFrtbAOY8x",
    STRIPE_PRICE_COLLECTOR: "price_1UAlLqETuJs3mqsF7f9jgdmw",
    STRIPE_PRICE_DEALER: "price_1UAlLrETuJs3mqsFqxIAAxrD",
    ...env,
  });
  try {
    const m = await import(`../src/billing/liveprice.js?t=${Math.random()}`);
    return { out: await m.livePrices(), calls };
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("an archived pinned price still finds its product's live price", async () => {
  const { out } = await resolve(REAL);
  const c = out.get("collector");
  // Not the archived id in the environment, and not the A$11 that was also
  // archived — the one Stripe would actually accept.
  assert.equal(c.priceId, "price_1UBscDETuJs3mqsF84AkvA1d");
  assert.equal(c.amountCents, 1000);
  assert.equal(c.currency, "AUD");
});

test("the plans that were never broken keep working", async () => {
  const { out } = await resolve(REAL);
  // No default_price on the product: exactly one active price is
  // unambiguous, so it is used.
  assert.equal(out.get("dealer").priceId, "price_1UAlLrETuJs3mqsFqxIAAxrD");
  assert.equal(out.get("dealer").amountCents, 2000);
  // Still the old A$20 Stripe holds, and reported as drifted from the A$69.99
  // the client confirmed — Stripe is the truth until its prices are recreated.
  assert.equal(out.get("dealer").driftedFrom, 6999);
  // Retired, so not offered even though Stripe still holds a price for it.
  assert.equal(out.has("starter"), false);
});

test("a real price change reaches the app", async () => {
  // The A$11 the owner set, this time left active and made the default.
  const raised = [
    price("price_1UAlLqETuJs3mqsF7f9jgdmw", COLLECTOR, 1000, false, "price_1UBsWZETuJs3mqsFkubStoeO"),
    price("price_1UBsWZETuJs3mqsFkubStoeO", COLLECTOR, 1100, true, "price_1UBsWZETuJs3mqsFkubStoeO"),
  ];
  const { out } = await resolve(raised);
  assert.equal(out.get("collector").amountCents, 1100);
  // plans.ts says the confirmed 1999, and the difference is reported rather
  // than lost.
  assert.equal(out.get("collector").driftedFrom, 1999);
});

test("two active prices and no default is not guessed at", async () => {
  const ambiguous = [
    price("price_1UAlLqETuJs3mqsF7f9jgdmw", COLLECTOR, 1000, true, null),
    price("price_1UBscDETuJs3mqsF84AkvA1d", COLLECTOR, 1500, true, null),
  ];
  const { out } = await resolve(ambiguous);
  // Stripe has not said which is current. Charging the one that sorts first is
  // how somebody is billed an amount nobody chose.
  assert.equal(out.has("collector"), false);
});

test("a product with nothing active is not offered", async () => {
  const dead = [price("price_1UAlLqETuJs3mqsF7f9jgdmw", COLLECTOR, 1000, false, null)];
  const { out } = await resolve(dead);
  assert.equal(out.has("collector"), false);
});

test("Stripe unreachable invents nothing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  const saved = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
  try {
    const m = await import(`../src/billing/liveprice.js?t=${Math.random()}`);
    assert.equal((await m.livePrices()).size, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved;
  }
});

test("one Stripe request serves every plan", async () => {
  const { calls } = await resolve(REAL);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("expand[]=data.product"));
});

// ---- monthly and yearly on one product (GM001-32) -----------------------------

const yearly = (id, product, cents, active, defaultPrice = null) => ({
  id, active, unit_amount: cents, currency: "aud", recurring: { interval: "year" },
  product: { id: product, default_price: defaultPrice },
});

test("a product with a monthly and a yearly price offers both, not neither", async () => {
  // What `npm run stripe:setup` leaves behind: the old A$10 still active, the
  // new A$19.99 monthly as the product default, and one A$199.99 yearly.
  const both = [
    price("price_old10", COLLECTOR, 1000, true, "price_new1999"),
    price("price_new1999", COLLECTOR, 1999, true, "price_new1999"),
    yearly("price_year19999", COLLECTOR, 19999, true, "price_new1999"),
  ];
  const { out } = await resolve(both, {
    STRIPE_PRICE_COLLECTOR: "price_old10",
    STRIPE_PRICE_COLLECTOR_ANNUAL: "price_year19999",
  });
  const c = out.get("collector");
  assert.equal(c.priceId, "price_new1999");
  assert.equal(c.amountCents, 1999);
  assert.equal(c.driftedFrom, null);
  assert.equal(c.annual.priceId, "price_year19999");
  assert.equal(c.annual.amountCents, 19999);
  assert.equal(c.annual.driftedFrom, null);
});

test("a yearly price with no pin is used when it is the only one", async () => {
  const both = [
    price("price_new1999", COLLECTOR, 1999, true, "price_new1999"),
    yearly("price_year19999", COLLECTOR, 19999, true, "price_new1999"),
  ];
  const { out } = await resolve(both, { STRIPE_PRICE_COLLECTOR: "price_new1999" });
  assert.equal(out.get("collector").annual.priceId, "price_year19999");
});

test("two yearly prices and nothing saying which leaves monthly on sale and yearly off", async () => {
  const messy = [
    price("price_new1999", COLLECTOR, 1999, true, "price_new1999"),
    yearly("price_year_a", COLLECTOR, 19999, true, "price_new1999"),
    yearly("price_year_b", COLLECTOR, 18999, true, "price_new1999"),
  ];
  const { out } = await resolve(messy, { STRIPE_PRICE_COLLECTOR: "price_new1999" });
  assert.equal(out.get("collector").amountCents, 1999);
  assert.equal(out.get("collector").annual, null);
});

test("no yearly price yet is no yearly offer, and monthly is untouched", async () => {
  const { out } = await resolve(REAL);
  assert.equal(out.get("collector").annual, null);
});
