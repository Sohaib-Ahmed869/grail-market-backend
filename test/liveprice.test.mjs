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
// that were fine.
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
  // No default_price on either product: exactly one active price is
  // unambiguous, so it is used.
  assert.equal(out.get("starter").priceId, "price_1UAlLoETuJs3mqsFrtbAOY8x");
  assert.equal(out.get("starter").amountCents, 500);
  assert.equal(out.get("dealer").priceId, "price_1UAlLrETuJs3mqsFqxIAAxrD");
  assert.equal(out.get("dealer").amountCents, 2000);
});

test("a real price change reaches the app", async () => {
  // The A$11 the owner set, this time left active and made the default.
  const raised = [
    price("price_1UAlLqETuJs3mqsF7f9jgdmw", COLLECTOR, 1000, false, "price_1UBsWZETuJs3mqsFkubStoeO"),
    price("price_1UBsWZETuJs3mqsFkubStoeO", COLLECTOR, 1100, true, "price_1UBsWZETuJs3mqsFkubStoeO"),
  ];
  const { out } = await resolve(raised);
  assert.equal(out.get("collector").amountCents, 1100);
  // plans.ts still says 1000, and the difference is reported rather than lost.
  assert.equal(out.get("collector").driftedFrom, 1000);
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
