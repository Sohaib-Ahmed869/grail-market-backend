// Create the Stripe products and prices this app expects.
//
//   npm run stripe:setup
//
// Written as a script rather than done by hand so the three plans are
// reproducible: a second Stripe account (live, when test is done with) gets an
// identical set from one command instead of three careful form-fills.
//
// Safe to re-run. It looks for a product carrying the same `grailmarket_plan`
// metadata before creating one, so running it twice does not leave six
// products behind. Prices are immutable in Stripe — changing an amount means
// a new price, which is why the lookup is on the product and the price is
// matched on amount and interval.
import { loadEnvFile } from "../env.js";
loadEnvFile();

import { PLANS } from "./plans.js";

const API = "https://api.stripe.com/v1";
const KEY = process.env.STRIPE_SECRET_KEY;

if (!KEY) {
  console.error("STRIPE_SECRET_KEY is not set — nothing to do.");
  process.exit(1);
}

const form = (o: Record<string, string | number>) =>
  Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

async function stripe<T>(path: string, body?: Record<string, string | number>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: form(body) } : {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

type Product = { id: string; name: string; metadata?: Record<string, string> };
type Price = { id: string; unit_amount: number; currency: string; recurring?: { interval: string } };

const live = KEY.startsWith("sk_live");
console.log(`[stripe] ${live ? "LIVE" : "test"} mode\n`);

const existing = await stripe<{ data: Product[] }>("/products?limit=100&active=true");
const out: Record<string, string> = {};

for (const plan of PLANS) {
  // find by our own marker, not by name — names are for humans and get edited
  let product = existing.data.find((p) => p.metadata?.grailmarket_plan === plan.id);

  if (product) {
    console.log(`  ${plan.name.padEnd(10)} product exists  ${product.id}`);
  } else {
    product = await stripe<Product>("/products", {
      name: `GrailMarket ${plan.name}`,
      description: plan.blurb,
      "metadata[grailmarket_plan]": plan.id,
    });
    console.log(`  ${plan.name.padEnd(10)} product created ${product.id}`);
  }

  const prices = await stripe<{ data: Price[] }>(
    `/prices?product=${product.id}&active=true&limit=100`,
  );
  let price = prices.data.find(
    (p) =>
      p.unit_amount === plan.amountCents &&
      p.currency === "aud" &&
      p.recurring?.interval === "month",
  );

  if (price) {
    console.log(`  ${" ".repeat(10)} price exists    ${price.id}`);
  } else {
    price = await stripe<Price>("/prices", {
      product: product.id,
      unit_amount: plan.amountCents,
      currency: "aud",
      "recurring[interval]": "month",
      "metadata[grailmarket_plan]": plan.id,
    });
    console.log(`  ${" ".repeat(10)} price created   ${price.id}`);
  }

  out[plan.priceEnv] = price.id;
}

console.log("\nPut these in .env and in Render:\n");
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
process.exit(0);
