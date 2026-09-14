/**
 * Two accounts, two collections and a live market, for testing buy, sell and
 * scan on a pair of simulators.
 *
 * Everything here goes through the real API wherever the real API allows it,
 * so what the testers exercise is the same path a user walks. It reaches into
 * the database for exactly two things the API deliberately will not do: grant
 * a paid plan without Stripe, and move a listing to `live` without a human
 * moderator. Both are recorded below rather than hidden.
 *
 * The cards are chosen, not random. The set is built to contain every case
 * that has broken in front of a client:
 *
 *   - OP13-118, five printings behind one catalogue id, from US$13 to four
 *     figures. This is the card that priced at A$197 in a meeting.
 *   - a graded slab, a raw single, and a sealed box, so the three product
 *     shapes are all present.
 *   - sports, which our catalogue cannot price at all, so the "no price yet"
 *     state is on screen rather than theoretical.
 */
import { loadEnvFile } from "../src/env.js";
loadEnvFile(process.cwd());

import { storePool } from "../src/cards.store.js";

const API = process.env.SEED_API ?? "http://localhost:8180";
const PW = "GrailDemo2026!";

type User = { token: string; id: string; email: string; name: string };

async function api<T = any>(path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return (await r.json()) as T;
}

async function account(email: string, name: string): Promise<User> {
  const reg = await api<any>("/auth/register", { body: { email, name, password: PW } });
  if (reg?.token) return { token: reg.token, id: reg.user.user_id, email, name };
  const login = await api<any>("/auth/login", { body: { email, password: PW } });
  if (!login?.token) throw new Error(`cannot sign in as ${email}: ${JSON.stringify(login).slice(0, 160)}`);
  return { token: login.token, id: login.user.user_id, email, name };
}

/** A paid plan, written directly. Stripe is the only other way in and a test
 *  account cannot have a real subscription. */
async function grantPlan(userId: string, planId: string) {
  const pool = storePool()!;
  await pool.query(
    `insert into subscriptions (user_id, plan_id, status, stripe_sub_id, current_period_end, updated_at)
     values ($1,$2,'active',$3, now() + interval '1 year', now())
     on conflict (user_id) do update set plan_id = excluded.plan_id, status = 'active',
       current_period_end = excluded.current_period_end, updated_at = now()`,
    [userId, planId, `sub_demo_${userId}`],
  );
}

/** Straight to live. The review endpoint exists but a moderator does not, and
 *  a market with nothing in it cannot be tested. */
async function publish(listingId: string) {
  const pool = storePool()!;
  await pool.query(
    `update listings set status = 'live', live_at = now(), reviewed_at = now(),
            reviewed_by = 'seed', photo_verified = true
      where listing_id = $1`,
    [listingId],
  );
}

// ---------------------------------------------------------------- the cards
const CARDS = {
  /** The one that broke the demo: five printings, one id. */
  luffyRed: {
    catalogId: "optcg-OP13-118", cardName: "Monkey.D.Luffy (118) (Red Super Alternate Art)",
    setName: "Carrying On His Will", cardNumber: "OP13-118", game: "onepiece",
    imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/657401_200w.jpg",
  },
  luffyBase: {
    catalogId: "optcg-OP13-118", cardName: "Monkey.D.Luffy (118)",
    setName: "Carrying On His Will", cardNumber: "OP13-118", game: "onepiece",
    imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/657400_200w.jpg",
  },
  charcadet: {
    catalogId: "me05-011", cardName: "Charcadet", setName: "Pitch Black",
    cardNumber: "011", game: "pokemon",
    imageUrl: "https://assets.tcgdex.net/en/me/me05/11/high.png",
  },
  tropius: {
    catalogId: "me05-001", cardName: "Tropius", setName: "Pitch Black",
    cardNumber: "001", game: "pokemon",
    imageUrl: "https://assets.tcgdex.net/en/me/me05/1/high.png",
  },
  lurantis: {
    catalogId: "me05-004", cardName: "Lurantis ex", setName: "Pitch Black",
    cardNumber: "004", game: "pokemon",
    imageUrl: "https://assets.tcgdex.net/en/me/me05/4/high.png",
  },
  law: {
    catalogId: "optcg-OP17-031", cardName: "Trafalgar Law",
    setName: "The World's Strongest Warriors", cardNumber: "OP17-031", game: "onepiece",
    imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/657401_200w.jpg",
  },
  /** Sealed. Our catalogue holds singles only, so this has no catalogue id —
   *  which is itself worth having on screen. */
  sealedOP: {
    catalogId: null, cardName: "One Piece OP-13 Carrying On His Will — Sealed Booster Box",
    setName: "Carrying On His Will", cardNumber: null, game: "onepiece",
    imageUrl: null,
  },
  sealedPkm: {
    catalogId: null, cardName: "Pokémon Pitch Black — Sealed Elite Trainer Box",
    setName: "Pitch Black", cardNumber: null, game: "pokemon", imageUrl: null,
  },
  /** Sports. Not in any catalogue we read, so it can never be priced — the
   *  honest "no price yet" state, on a real row. */
  sportsJordan: {
    catalogId: null, cardName: "Michael Jordan 1986 Fleer #57",
    setName: "1986 Fleer Basketball", cardNumber: "57", game: null, imageUrl: null,
  },
  sportsBrady: {
    catalogId: null, cardName: "Tom Brady 2000 Bowman #236",
    setName: "2000 Bowman Football", cardNumber: "236", game: null, imageUrl: null,
  },
};

async function addToCollection(u: User, c: any, extra: Record<string, unknown> = {}) {
  const r = await api<any>("/collection", {
    token: u.token,
    body: {
      catalogId: c.catalogId, cardName: c.cardName, setName: c.setName,
      cardNumber: c.cardNumber, imageUrl: c.imageUrl, quantity: 1, currency: "AUD", ...extra,
    },
  });
  if (!r?.entryId) console.warn(`  ! collection add failed for ${c.cardName}: ${JSON.stringify(r).slice(0, 120)}`);
  return r?.entryId ?? null;
}

async function listCard(u: User, c: any, price: number, extra: Record<string, unknown> = {}) {
  const r = await api<any>("/listings", {
    token: u.token,
    body: {
      catalogId: c.catalogId, cardName: c.cardName, setName: c.setName,
      cardNumber: c.cardNumber, game: c.game, imageUrl: c.imageUrl,
      price, currency: "AUD", isRaw: true,
      delivery: ["Post — tracked"], suburb: "Sydney",
      conditionNote: "Demo listing seeded for testing.",
      ...extra,
    },
  });
  if (!r?.listingId) {
    console.warn(`  ! listing failed for ${c.cardName}: ${JSON.stringify(r).slice(0, 160)}`);
    return null;
  }
  await publish(r.listingId);
  return r.listingId as string;
}

// ------------------------------------------------------------------- run it
const pool = storePool();
if (!pool) throw new Error("DATABASE_URL is not set — nothing to seed into");

console.log(`seeding against ${API}\n`);

const seller = await account("dana.seller@grailtest.local", "Dana Okafor");
const buyer = await account("sam.buyer@grailtest.local", "Sam Whitfield");
console.log(`seller  ${seller.email}  ${seller.id}`);
console.log(`buyer   ${buyer.email}  ${buyer.id}\n`);

await grantPlan(seller.id, "dealer");
await grantPlan(buyer.id, "collector");
console.log("plans granted (seller: dealer, buyer: collector)\n");

// Clear anything a previous run left, so the state is the same every time.
await pool.query(`delete from collection where user_id = any($1)`, [[seller.id, buyer.id]]);
await pool.query(`delete from listings where seller_id = any($1)`, [[seller.id, buyer.id]]);

console.log("seller collection:");
for (const [k, extra] of [
  ["luffyRed", { grader: "PSA", grade: "10", variant: "Red Super Alternate Art", paid: 6500 }],
  ["luffyBase", { variant: "Normal", paid: 12 }],
  ["charcadet", { paid: 0.4 }],
  ["sealedOP", { paid: 190, quantity: 2 }],
  ["sportsJordan", { grader: "PSA", grade: "8", paid: 4200 }],
] as const) {
  await addToCollection(seller, (CARDS as any)[k], extra as any);
  console.log(`  + ${(CARDS as any)[k].cardName}`);
}

console.log("\nbuyer collection:");
for (const [k, extra] of [
  ["tropius", { paid: 0.3 }],
  ["lurantis", { grader: "CGC", grade: "9.5", paid: 3 }],
  ["sealedPkm", { paid: 79 }],
  ["sportsBrady", { paid: 900 }],
] as const) {
  await addToCollection(buyer, (CARDS as any)[k], extra as any);
  console.log(`  + ${(CARDS as any)[k].cardName}`);
}

console.log("\nlive listings from the seller:");
const listings = [
  await listCard(seller, CARDS.luffyRed, 11800, { grader: "PSA", grade: "10", isRaw: false, variant: "Red Super Alternate Art", marketValue: 12500 }),
  await listCard(seller, CARDS.luffyBase, 22, { variant: "Normal", marketValue: 20 }),
  await listCard(seller, CARDS.lurantis, 4.5, { marketValue: 4 }),
  await listCard(seller, CARDS.law, 38, { marketValue: 42 }),
  await listCard(seller, CARDS.sealedOP, 210, { marketValue: 205 }),
  await listCard(seller, CARDS.sportsJordan, 5200, { grader: "PSA", grade: "8", isRaw: false, marketValue: 5000 }),
].filter(Boolean);
for (const id of listings) console.log(`  live  ${id}`);

console.log(`\n${listings.length} live listings.\n`);
console.log("sign in on either simulator with:");
console.log(`  SELLER  ${seller.email}   ${PW}`);
console.log(`  BUYER   ${buyer.email}   ${PW}`);
process.exit(0);
