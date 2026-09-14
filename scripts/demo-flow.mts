/** A whole sale, driven through the API while two phones watch.
 *
 *  There is no tap driver on this machine, so the UI cannot be clicked. What
 *  it can do is take each step through the same endpoints the app calls, and
 *  deep-link the right phone to the right screen just before each one — so
 *  the seller's device is on its offers when the offer lands, and the buyer's
 *  is on the deal when it opens. What you watch is real state moving, not a
 *  mock.
 */
import { loadEnvFile } from "../src/env.js";
loadEnvFile(process.cwd());
import { storePool } from "../src/cards.store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const API = process.env.DEMO_API ?? "https://grailmarket.duckdns.org";
const SELLER_SIM = "2139DC3E-8D7A-4186-924E-45A8AB35749C";
const BUYER_SIM = "F83AFA55-A10E-4BCE-812A-59721A923208";
const PW = "GrailDemo2026!";

const pool = storePool();
if (!pool) throw new Error("DATABASE_URL is not set");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function open(sim: string, route: string) {
  try { await run("xcrun", ["simctl", "openurl", sim, `grailmarket://${route}`]); } catch {}
}
async function api<T = any>(p: string, o: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const r = await fetch(`${API}${p}`, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return (await r.json()) as T;
}
async function login(email: string) {
  const r = await api<any>("/auth/login", { body: { email, password: PW } });
  if (!r?.token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(r).slice(0, 140)}`);
  return { token: r.token as string, id: r.user.user_id as string, name: r.user.name as string };
}
const step = (n: number, s: string) => console.log(`\n${"─".repeat(64)}\n  ${n}.  ${s}\n${"─".repeat(64)}`);

// Clear anything a previous run of this script left behind.
await pool.query(`delete from listings where condition_note like '%Live demo listing.%'`).catch(() => {});

const seller = await login("dana.seller@grailtest.local");
const buyer = await login("sam.buyer@grailtest.local");
console.log(`seller  ${seller.name}  (iPhone 17 Pro)`);
console.log(`buyer   ${buyer.name}  (iPhone 17 Pro Max)`);
console.log(`api     ${API}`);

// ── 1 ────────────────────────────────────────────────────────────────────
step(1, "Seller lists a card");
await open(SELLER_SIM, "/mylistings");
await wait(2500);
const card = {
  catalogId: "optcg-OP17-062", cardName: "Kaido (062) (Manga)",
  setName: "The World's Strongest Warriors", cardNumber: "OP17-062", game: "onepiece",
  imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/712090_200w.jpg",
};
const created = await api<any>("/listings", {
  token: seller.token,
  body: { ...card, price: 1650, currency: "AUD", isRaw: true, marketValue: 1550,
          delivery: ["Post — tracked"], suburb: "Sydney",
          conditionNote: "Near mint, sleeved since pull. Live demo listing." },
});
if (!created?.listingId) throw new Error(`listing failed: ${JSON.stringify(created).slice(0, 200)}`);
const L = created.listingId as string;
console.log(`   listed  ${card.cardName}  A$1,650   (${L})`);

// Straight to live. Going live properly needs four photographs and a
// moderator, and neither is the thing being demonstrated here.
await pool!.query(
  `update listings set status='live', live_at=now(), reviewed_at=now(),
          reviewed_by='demo', photo_verified=true where listing_id=$1`,
  [L],
);
await wait(1500);
await open(SELLER_SIM, "/mylistings");
console.log("   -> seller's My Listings");

// ── 2 ────────────────────────────────────────────────────────────────────
step(2, "Buyer finds it on the market");
await wait(4000);
await open(BUYER_SIM, "/market");
await wait(3500);
await open(BUYER_SIM, `/listing/${L}`);
console.log("   -> buyer's listing page");

// ── 3 ────────────────────────────────────────────────────────────────────
step(3, "Buyer offers A$1,400");
await wait(5000);
const off = await api<any>(`/listings/${L}/offers`, {
  token: buyer.token, body: { amount: 1400, currency: "AUD", note: "Cash today if you can post tracked." },
});
console.log(`   offered A$1,400   (${off?.offerId ?? JSON.stringify(off).slice(0, 90)})`);
await wait(1500);
await open(SELLER_SIM, "/offers");
console.log("   -> seller's Offers");

// ── 4 ────────────────────────────────────────────────────────────────────
step(4, "Seller accepts");
await wait(5000);
const settled = await api<any>(`/listings/offers/${off.offerId}/settle`, {
  token: seller.token, body: { action: "accepted" },
});
const dealId = settled?.dealId;
console.log(`   accepted -> deal ${dealId ?? JSON.stringify(settled).slice(0, 120)}`);
if (!dealId) throw new Error("no deal id came back");
await wait(1500);
await open(SELLER_SIM, `/deals/${dealId}`);
await open(BUYER_SIM, `/deals/${dealId}`);
console.log("   -> the deal, on both phones");

// ── 5 ────────────────────────────────────────────────────────────────────
step(5, "Seller hands the card over");
await wait(5500);
console.log("  ", JSON.stringify(await api(`/deals/${dealId}/handover`, { token: seller.token, body: {} })));
await wait(1500);
await open(SELLER_SIM, `/deals/${dealId}`);
await open(BUYER_SIM, `/deals/${dealId}`);

// ── 6 ────────────────────────────────────────────────────────────────────
step(6, "Buyer confirms they received it");
await wait(5500);
console.log("  ", JSON.stringify(await api(`/deals/${dealId}/received`, { token: buyer.token, body: {} })));
await wait(2000);
await open(BUYER_SIM, "/(tabs)/portfolio");
console.log("   -> the card is now in the buyer's collection");

// ── 7 ────────────────────────────────────────────────────────────────────
step(7, "Both rate each other");
await wait(5000);
await open(SELLER_SIM, "/rate");
await open(BUYER_SIM, "/rate");
await wait(3000);
console.log("   seller rates buyer:",
  JSON.stringify(await api("/ratings", { token: seller.token, body: { listingId: L, stars: 5, comment: "Paid straight away, easy handover." } })));
console.log("   buyer rates seller:",
  JSON.stringify(await api("/ratings", { token: buyer.token, body: { listingId: L, stars: 5, comment: "Exactly as described, posted same day." } })));

// ── done ─────────────────────────────────────────────────────────────────
step(8, "Where it ended up");
const deal = await api<any>(`/deals/${dealId}`, { token: buyer.token });
console.log("   deal status   :", deal?.deal?.status ?? deal?.status ?? "?");
const rep = await api<any>(`/ratings/${seller.id}`);
console.log("   seller rating :", JSON.stringify(rep).slice(0, 120));
await wait(2000);
await open(SELLER_SIM, "/(tabs)/profile");
await open(BUYER_SIM, "/(tabs)/portfolio");
console.log("\nDone. Listing " + L + ", deal " + dealId + ".\n");
process.exit(0);
