// The buy/sell flow over HTTP, as the two demo accounts.
//
// `scripts/e2e-trade.mts` calls the service functions directly against a
// throwaway schema. That proves the state machine and leaves the controllers,
// the session tokens and the quota middleware untested — which is most of
// what stands between a person tapping a button and the state machine.
//
// This runs the real thing: two sign-ins, an offer, a counter, an acceptance,
// a handover and a receipt, through the same endpoints the app calls. It
// writes to the real database on purpose, because that is what the demo is.
const API = process.env.API ?? "http://localhost:8180";
const PW = process.env.DEMO_PW;
const SELLER_EMAIL = "ayna@yopmail.com";
const BUYER_EMAIL = "sohaibahmedsapra@yopmail.com";

let pass = 0, fail = 0;
const broken = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; broken.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function call(path, { token, method = "GET", body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* some routes answer empty */ }
  return { status: r.status, body: j };
}

const login = async (email) => {
  const r = await call("/auth/login", { method: "POST", body: { email, password: PW } });
  return r.body?.token ?? null;
};

console.log(`\nLIVE BUY/SELL against ${API}\n`);

const seller = await login(SELLER_EMAIL);
const buyer = await login(BUYER_EMAIL);
ok("seller signs in", Boolean(seller));
ok("buyer signs in", Boolean(buyer));
if (!seller || !buyer) { console.log("\ncannot continue without both sessions"); process.exit(1); }

// A live listing of the seller's to negotiate over.
const mine = await call("/listings/mine", { token: seller });
const live = (mine.body?.listings ?? mine.body ?? []).filter((l) => l.status === "live");
ok("seller has a live listing to sell", live.length > 0, `found ${live.length}`);
if (!live.length) { console.log("\nno live listing"); process.exit(1); }

const listing = live[0];
console.log(`\n  listing: ${listing.card_name} ${listing.grader ?? "raw"} ${listing.grade ?? ""} at ${listing.currency} ${listing.price} (${listing.listing_id})\n`);

// ── the buyer makes an offer
const ask = Number(listing.price);
const offerAmount = Math.round(ask * 0.8);
const made = await call(`/listings/${listing.listing_id}/offers`, {
  token: buyer, method: "POST", body: { amount: offerAmount, note: "Keen on this one." },
});
ok("buyer can offer", Boolean(made.body?.offerId), JSON.stringify(made.body));
const offerId = made.body?.offerId;
if (!offerId) { console.log("\nno offer id"); process.exit(1); }

// ── negative: the seller cannot bid on their own card
const selfBid = await call(`/listings/${listing.listing_id}/offers`, {
  token: seller, method: "POST", body: { amount: offerAmount },
});
ok("seller cannot offer on their own listing", selfBid.body?.error === "own-listing", JSON.stringify(selfBid.body));

// ── negative: a zero offer
const zero = await call(`/listings/${listing.listing_id}/offers`, {
  token: buyer, method: "POST", body: { amount: 0 },
});
ok("a zero offer is refused", zero.body?.error === "invalid", JSON.stringify(zero.body));

// ── negative: an unauthenticated offer
const anon = await call(`/listings/${listing.listing_id}/offers`, {
  method: "POST", body: { amount: offerAmount },
});
ok("an unauthenticated offer is refused", anon.body?.error === "unauthenticated", JSON.stringify(anon.body));

// ── negative: the BUYER cannot settle their own offer
const buyerSettles = await call(`/listings/offers/${offerId}/settle`, {
  token: buyer, method: "POST", body: { action: "accepted" },
});
ok("the buyer cannot accept their own offer", buyerSettles.body?.error === "not-yours", JSON.stringify(buyerSettles.body));

// ── the seller counters
const counterAmount = Math.round(ask * 0.92);
const countered = await call(`/listings/offers/${offerId}/settle`, {
  token: seller, method: "POST", body: { action: "countered", amount: counterAmount },
});
ok("seller can counter", countered.body?.status === "countered", JSON.stringify(countered.body));

// ── the buyer accepts the counter
const acceptedCounter = await call(`/listings/offers/${offerId}/reply`, {
  token: buyer, method: "POST", body: { action: "accepted" },
});
ok("buyer accepts the counter", acceptedCounter.body?.status === "accepted", JSON.stringify(acceptedCounter.body));
const dealId = acceptedCounter.body?.dealId;
ok("a deal opened", Boolean(dealId), JSON.stringify(acceptedCounter.body));
if (!dealId) { console.log("\nno deal id"); process.exit(1); }

// ── the card comes off the market
const after = await call(`/listings/${listing.listing_id}`, { token: buyer });
ok("listing is reserved", (after.body?.listing ?? after.body)?.status === "reserved",
  JSON.stringify((after.body?.listing ?? after.body)?.status));

// ── negative: somebody else cannot now offer on it
const lateOffer = await call(`/listings/${listing.listing_id}/offers`, {
  token: buyer, method: "POST", body: { amount: ask },
});
ok("a reserved card takes no more offers", lateOffer.body?.error === "reserved", JSON.stringify(lateOffer.body));

// ── negative: the buyer cannot mark it handed over
const buyerHandover = await call(`/deals/${dealId}/handover`, { token: buyer, method: "POST" });
ok("the buyer cannot mark handover", Boolean(buyerHandover.body?.error), JSON.stringify(buyerHandover.body));

// ── the seller hands it over
const handover = await call(`/deals/${dealId}/handover`, { token: seller, method: "POST" });
ok("seller marks handed over", handover.body?.state === "handed_over", JSON.stringify(handover.body));

// ── negative: the seller cannot confirm receipt
const sellerReceives = await call(`/deals/${dealId}/received`, { token: seller, method: "POST" });
ok("the seller cannot confirm receipt", Boolean(sellerReceives.body?.error), JSON.stringify(sellerReceives.body));

// ── the buyer confirms
const received = await call(`/deals/${dealId}/received`, { token: buyer, method: "POST" });
ok("buyer confirms receipt", received.body?.state === "complete", JSON.stringify(received.body));

// ── and the consequences
const sold = await call(`/listings/${listing.listing_id}`, { token: buyer });
ok("listing is sold", (sold.body?.listing ?? sold.body)?.status === "sold",
  JSON.stringify((sold.body?.listing ?? sold.body)?.status));

const coll = await call("/collection", { token: buyer });
const entries = coll.body?.entries ?? coll.body?.cards ?? [];
const got = entries.find((e) => e.catalogId === listing.catalog_id || e.catalog_id === listing.catalog_id);
ok("the card is in the buyer's collection", Boolean(got), `${entries.length} entries`);
ok("it records what they actually paid", got && Number(got.paid) === counterAmount,
  `paid=${got?.paid} expected=${counterAmount}`);

const sales = await call(`/market/sales?cardId=${encodeURIComponent(listing.catalog_id)}&grader=${listing.grader ?? ""}&grade=${listing.grade ?? ""}`, { token: buyer });
const newest = sales.body?.sales?.[0];
ok("a comp was written at the agreed price", newest && Number(newest.price) === counterAmount,
  `newest=${newest?.price} expected=${counterAmount}`);

console.log(`\n${"=".repeat(60)}\nPASS ${pass}   FAIL ${fail}`);
if (broken.length) { console.log("\nBROKEN:"); for (const b of broken) console.log("  - " + b); }
console.log(`\nDeal ${dealId} completed at ${listing.currency} ${counterAmount}.`);
process.exit(fail ? 1 : 0);
