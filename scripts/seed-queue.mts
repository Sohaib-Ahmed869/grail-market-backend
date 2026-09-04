/**
 * A review queue worth working, for the admin console.
 *
 *   npx tsx scripts/seed-queue.mts
 *
 * Five land in "needs a decision" and one in "waiting on seller". They span
 * the three price tiers and, deliberately, both sides of the 24-hour review
 * target: one is well over it, so the overdue badge, the breach notice at the
 * top of the queue and the bell all have something real to report. A queue
 * where every row is comfortably inside its target does not show whether any
 * of that works.
 *
 * All of them go in through `createListing` and `moveListing` rather than as
 * raw INSERTs, so
 * they arrive the way a real submission does: created as a draft, submitted,
 * and — for the second — parked with a reason. A row hand-written straight
 * into `in_review` skips `submitted_at`, which is what the review clock reads,
 * and shows up in the console as overdue on arrival.
 *
 * Re-running it adds another pair rather than editing the first. Nothing here
 * touches a listing that already exists.
 */
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { createListing, initListings, moveListing } = await import("../src/listings/store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initListings();
const pool = storePool()!;

/** Ten prescribed angles, or the first `n` of them. Under ten the console's
 *  photo-set check fails, which is the point of seeding one short. */
function angles(catalog: string, n: number) {
  const [set, num] = catalog.split(/-(?=\d+$)/);
  const base = `https://assets.tcgdex.net/en/${set.startsWith("swsh") ? "swsh" : "base"}/${set}/${num}`;
  const names = [
    "front", "back", "front-tl", "front-tr", "front-bl",
    "front-br", "back-tl", "back-tr", "back-bl", "back-br",
  ];
  return names
    .slice(0, n)
    .map((angle, i) => ({ angle, url: `${base}/${i === 0 ? "high" : "low"}.png` }));
}

const image = (catalog: string) => angles(catalog, 1)[0].url;

/** A seller who already exists. The console reads their name and rating, so a
 *  made-up id would render a listing with no seller behind it. */
async function sellerByEmail(email: string): Promise<string> {
  const r = await pool.query("select user_id from users where lower(email) = $1", [email]);
  const id = r.rows[0]?.user_id;
  if (!id) throw new Error(`No account for ${email} — seed the members first.`);
  return id;
}

async function seed(l: {
  email: string;
  catalogId: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  variant: string;
  grader: string;
  grade: string;
  cert: string;
  price: number;
  marketValue: number;
  suburb: string;
  photos: number;
  /** Hours ago it was submitted, for the review clock. */
  submittedHoursAgo: number;
  /** Set to park it back with the seller instead of leaving it for us. */
  askedFor?: string;
}) {
  const sellerId = await sellerByEmail(l.email);

  const id = await createListing({
    sellerId,
    catalogId: l.catalogId,
    cardName: l.cardName,
    setName: l.setName,
    cardNumber: l.cardNumber,
    game: "pokemon",
    variant: l.variant,
    imageUrl: image(l.catalogId),
    grader: l.grader,
    grade: l.grade,
    certNumber: l.cert,
    price: l.price,
    currency: "AUD",
    marketValue: l.marketValue,
    delivery: ["pickup", "insured"],
    suburb: l.suburb,
  });
  if (!id) throw new Error("createListing returned nothing — is the store up?");

  const shots = angles(l.catalogId, l.photos);
  await pool.query(
    "update listings set photos = $1, photo_verified = $2 where listing_id = $3",
    [JSON.stringify(shots), shots.length >= 10, id],
  );

  const submitted = await moveListing(id, "in_review", { sellerId });
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.why}`);

  // The clock starts at submission, and `moveListing` stamps it as now. Wind
  // it back so the seeded row has a believable position in the queue.
  await pool.query(
    "update listings set submitted_at = now() - ($1 || ' hours')::interval where listing_id = $2",
    [String(l.submittedHoursAgo), id],
  );

  if (l.askedFor) {
    const parked = await moveListing(id, "info_requested", { reason: l.askedFor });
    if (!parked.ok) throw new Error(`park failed: ${parked.why}`);
  }

  const r = await pool.query("select status, price, submitted_at from listings where listing_id = $1", [id]);
  const row = r.rows[0];
  console.log(
    `  ${id}  ${l.cardName} ${l.grader} ${l.grade}  A$${Number(row.price).toLocaleString()}  → ${row.status}`,
  );
  return id;
}

console.log("Seeding the review queue…");

// 1 — waiting on us. Grail tier, four angles short of the ten required, so the
//     automatic checks have something real to fail on.
await seed({
  email: "jules@grailmarket.test",
  catalogId: "base1-15",
  cardName: "Venusaur",
  setName: "Base Set",
  cardNumber: "15",
  variant: "holo",
  grader: "PSA",
  grade: "10",
  cert: "94120773",
  price: 12400,
  marketValue: 11350,
  suburb: "Fitzroy VIC",
  photos: 6,
  submittedHoursAgo: 20,
});

// 2 — waiting on the seller. A complete photo set, parked because the label
//     could not be read against the register.
await seed({
  email: "dev@grailmarket.test",
  catalogId: "swsh7-215",
  cardName: "Umbreon VMAX",
  setName: "Evolving Skies",
  cardNumber: "215",
  variant: "alt",
  grader: "PSA",
  grade: "9",
  cert: "88410265",
  price: 2800,
  marketValue: 2640,
  suburb: "Newtown NSW",
  photos: 10,
  submittedHoursAgo: 31,
  askedFor:
    "The certificate number on the slab label is not legible in any of the angles supplied. Send one straight-on photograph of the label, close enough to read the cert.",
});

// 3 — overdue. Past the 24-hour target, so the breach notice, the red badge
//     on the row and the bell all have something to point at.
await seed({
  email: "azka@yopmail.com",
  catalogId: "base1-4",
  cardName: "Charizard",
  setName: "Base Set",
  cardNumber: "4",
  variant: "holo",
  grader: "PSA",
  grade: "9",
  cert: "72104488",
  price: 18500,
  marketValue: 17250,
  suburb: "Carlton VIC",
  photos: 10,
  submittedHoursAgo: 39,
});

// 4 — high-value tier, everything in order. The queue needs a row that gives
//     a moderator nothing to object to, or "approve" is never the obvious
//     answer to anything.
await seed({
  email: "mia@grailmarket.test",
  catalogId: "base1-2",
  cardName: "Blastoise",
  setName: "Base Set",
  cardNumber: "2",
  variant: "holo",
  grader: "BGS",
  grade: "9.5",
  cert: "0014882301",
  price: 4200,
  marketValue: 4180,
  suburb: "Bondi NSW",
  photos: 10,
  submittedHoursAgo: 6,
});

// 5 — standard tier and priced well over the market, which is the overpricing
//     check the feature set asks the queue to surface.
await seed({
  email: "sohaib@grailmarket.test",
  catalogId: "swsh7-215",
  cardName: "Umbreon VMAX",
  setName: "Evolving Skies",
  cardNumber: "215",
  variant: "alt",
  grader: "CGC",
  grade: "8.5",
  cert: "4172885003",
  price: 1650,
  marketValue: 940,
  suburb: "Parramatta NSW",
  photos: 9,
  submittedHoursAgo: 11,
});

// 6 — just arrived, and short of the required angles.
await seed({
  email: "jules@grailmarket.test",
  catalogId: "base1-15",
  cardName: "Venusaur",
  setName: "Base Set",
  cardNumber: "15",
  variant: "holo",
  grader: "SGC",
  grade: "8",
  cert: "3910447",
  price: 880,
  marketValue: 910,
  suburb: "Fitzroy VIC",
  photos: 4,
  submittedHoursAgo: 2,
});

console.log("Done.");
await pool.end();
