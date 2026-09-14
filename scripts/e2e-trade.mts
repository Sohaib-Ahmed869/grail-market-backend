/** The whole trade, end to end, against a THROWAWAY SCHEMA.
 *
 *  Not against the real database, and that is not squeamishness: completing a
 *  deal calls `recordSale()`, which writes an append-only comp that our own
 *  valuations then read back. A test that closes ten fake deals teaches the
 *  pricing chain ten fake prices, and invariant 5 means they cannot be
 *  deleted afterwards.
 *
 *  Neon's POOLED endpoint refuses the `options` startup parameter, so the
 *  scratch schema only works on the direct host — the pooled name with
 *  "-pooler" removed.
 *
 *  Run: node --env-file=.env --import tsx scripts/e2e-trade.mts
 */
const SCHEMA = "e2e_scratch";
const direct = process.env.DATABASE_URL!.replace("-pooler.", ".");
const sep = direct.includes("?") ? "&" : "?";
process.env.DATABASE_URL = `${direct}${sep}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

const pgmod = await import("pg");
const admin = new pgmod.default.Pool({ connectionString: direct, connectionTimeoutMillis: 15000 });
await admin.query(`drop schema if exists ${SCHEMA} cascade`);
await admin.query(`create schema ${SCHEMA}`);

const { initStore, storePool } = await import("../src/cards.store.js");
const { initListings, createListing, moveListing, getListing, canMove } = await import("../src/listings/store.js");
const { initDeals, startDeal, markHandedOver, markReceived, cancelDeal, marketStatusForOwner } = await import("../src/listings/deals.js");
const { makeOffer, settleOffer, replyToCounter } = await import("../src/listings/offers.js");
const { initSales } = await import("../src/sales/ledger.js");
const { initAuth } = await import("../src/auth/store.js");
const { initNotifications } = await import("../src/notifications/store.js");
const { initMessages } = await import("../src/messages/store.js");

let pass = 0, fail = 0;
const results: string[] = [];
function check(name: string, cond: unknown, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; results.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const step = (s: string) => console.log(`\n${s}`);

await initStore();
await initListings(); await initDeals(); await initSales();
await initAuth(); await initNotifications(); await initMessages();
const pool = storePool()!;

// Collection is created by the collection store; make sure it exists here.
await pool.query(`CREATE TABLE IF NOT EXISTS collection (
  entry_id text PRIMARY KEY, user_id text NOT NULL, catalog_id text,
  card_name text NOT NULL, set_name text, card_number text, image_url text,
  grader text, grade text, variant text, quantity int NOT NULL DEFAULT 1,
  paid numeric, currency text DEFAULT 'AUD', added_at timestamptz DEFAULT now())`);

const SELLER = "u_e2e_seller", BUYER = "u_e2e_buyer", STRANGER = "u_e2e_stranger";
for (const [id, name] of [[SELLER, "Ayna Test"], [BUYER, "Sohaib Test"], [STRANGER, "Nosy Parker"]]) {
  await pool.query(
    `insert into users (user_id, name, email) values ($1,$2,$3) on conflict (user_id) do nothing`,
    [id, name, `${id}@e2e.local`],
  ).catch(async (e) => { console.log("   (users insert:", e.message, ")"); });
}

// ─────────────────────────────────────────────── the state machine, offline
step("STATE MACHINE");
check("a draft cannot publish itself", canMove("draft", "live") === false);
check("review can publish", canMove("in_review", "live") === true);
check("live can reserve", canMove("live", "reserved") === true);
check("reserved can sell", canMove("reserved", "sold") === true);
check("a fallen-through deal returns the card", canMove("reserved", "live") === true);
check("sold is final", canMove("sold", "live") === false);

// ─────────────────────────────────────────────────────────── the happy path
step("HAPPY PATH — list, offer, counter, accept, hand over, receive");
const listingId = await createListing({
  sellerId: SELLER, catalogId: "base1-4", cardName: "Charizard",
  setName: "Base Set", cardNumber: "4", game: "pokemon",
  grader: "PSA", grade: "9", price: 25000, currency: "AUD", marketValue: 24000,
});
check("listing created", Boolean(listingId), String(listingId));

await moveListing(listingId!, "in_review", { sellerId: SELLER });
await moveListing(listingId!, "live", { sellerId: SELLER });
check("listing is live", (await getListing(listingId!))?.status === "live");

const offerId = await makeOffer({ listingId: listingId!, buyerId: BUYER, sellerId: SELLER, amount: 21000 });
check("offer made", Boolean(offerId));

const countered = await settleOffer(offerId!, SELLER, "countered", 24500);
check("seller can counter", countered.ok === true, JSON.stringify(countered));

const accepted = await replyToCounter(offerId!, BUYER, "accepted");
check("buyer accepts the counter", (accepted as any).ok === true, JSON.stringify(accepted));

const afterAccept = await getListing(listingId!);
check("listing is reserved once agreed", afterAccept?.status === "reserved", `status=${afterAccept?.status}`);

const dealRow = await pool.query("select * from deals where listing_id = $1", [listingId]);
const deal = dealRow.rows[0];
check("a deal exists", Boolean(deal));
check("the deal carries the COUNTER amount, not the ask", Number(deal?.amount) === 24500, `amount=${deal?.amount}`);

const ho = await markHandedOver(deal.deal_id, SELLER);
check("seller hands over", (ho as any).ok === true, JSON.stringify(ho));

const rec = await markReceived(deal.deal_id, BUYER);
check("buyer confirms receipt", (rec as any).ok === true, JSON.stringify(rec));

const afterComplete = await getListing(listingId!);
check("listing is sold", afterComplete?.status === "sold", `status=${afterComplete?.status}`);

const coll = await pool.query("select * from collection where user_id = $1", [BUYER]);
check("card landed in the BUYER's collection", coll.rowCount === 1, `rows=${coll.rowCount}`);
check("collection records what they actually paid", Number(coll.rows[0]?.paid) === 24500, `paid=${coll.rows[0]?.paid}`);
check("collection keeps the grade key", coll.rows[0]?.grader === "PSA" && coll.rows[0]?.grade === "9",
  `${coll.rows[0]?.grader} ${coll.rows[0]?.grade}`);

const led = await pool.query("select * from sales_ledger where catalog_id = 'base1-4'");
check("a comp was written", led.rowCount === 1, `rows=${led.rowCount}`);
check("the comp is the agreed price", Number(led.rows[0]?.price) === 24500, `price=${led.rows[0]?.price}`);
check("the comp is keyed on grader+grade", led.rows[0]?.grader === "PSA" && led.rows[0]?.grade === "9");

const owner = await marketStatusForOwner(SELLER);
check("seller sees it as sold", owner[0]?.status === "sold", JSON.stringify(owner[0] ?? null));
check("seller sees who bought it", Boolean(owner[0]?.buyerName), JSON.stringify(owner[0]?.buyerName));
check("seller sees the REALISED price, not the ask", Number(owner[0]?.price) === 24500, `price=${owner[0]?.price}`);

// ────────────────────────────────────────────────────────── negative flows
step("NEGATIVE FLOWS");

const doubleCancel = await cancelDeal(deal.deal_id, SELLER, "changed my mind");
check("a completed deal cannot be cancelled", (doubleCancel as any).ok === false, JSON.stringify(doubleCancel));

const reHandover = await markHandedOver(deal.deal_id, SELLER);
check("a completed deal cannot be handed over again", (reHandover as any).ok === false, JSON.stringify(reHandover));

// a second listing to exercise the refusals
const l2 = await createListing({
  sellerId: SELLER, catalogId: "base1-4", cardName: "Blastoise", setName: "Base Set",
  cardNumber: "2", game: "pokemon", grader: "PSA", grade: "8", price: 5000, currency: "AUD",
});
await moveListing(l2!, "in_review", { sellerId: SELLER });
await moveListing(l2!, "live", { sellerId: SELLER });

const o2 = await makeOffer({ listingId: l2!, buyerId: BUYER, sellerId: SELLER, amount: 4000 });
const bySomeoneElse = await settleOffer(o2!, STRANGER, "accepted");
check("only the seller may settle an offer", bySomeoneElse.ok === false && bySomeoneElse.why === "not-yours",
  JSON.stringify(bySomeoneElse));

const okAccept = await settleOffer(o2!, SELLER, "accepted");
check("seller accepts", okAccept.ok === true, JSON.stringify(okAccept));
const twice = await settleOffer(o2!, SELLER, "accepted");
check("an offer cannot be settled twice", twice.ok === false && twice.why === "already-settled", JSON.stringify(twice));

const d2 = (await pool.query("select * from deals where listing_id = $1", [l2])).rows[0];
const wrongReceiver = await markReceived(d2.deal_id, SELLER);
check("the SELLER cannot confirm receipt", (wrongReceiver as any).ok === false, JSON.stringify(wrongReceiver));
const wrongHandover = await markHandedOver(d2.deal_id, BUYER);
check("the BUYER cannot mark handed over", (wrongHandover as any).ok === false, JSON.stringify(wrongHandover));
const strangerCancel = await cancelDeal(d2.deal_id, STRANGER, "nosy");
check("a stranger cannot cancel somebody's deal", (strangerCancel as any).ok === false, JSON.stringify(strangerCancel));

// third listing: offers on a reserved card, and the one-deal-per-listing rule
const o3 = await makeOffer({ listingId: l2!, buyerId: STRANGER, sellerId: SELLER, amount: 4500 });
const onReserved = await settleOffer(o3!, SELLER, "accepted");
check("a second offer on a RESERVED card cannot be accepted",
  onReserved.ok === false, JSON.stringify(onReserved));

const dup = await startDeal({
  listingId: l2!, offerId: o3!, buyerId: STRANGER, sellerId: SELLER, amount: 4500, currency: "AUD",
}).catch((e: any) => ({ error: e.message }));
check("one live deal per listing is enforced", !(dup && (dup as any).dealId), JSON.stringify(dup));

// cancellation returns the card
const cancelled = await cancelDeal(d2.deal_id, BUYER, "changed my mind");
check("a buyer can cancel before completion", (cancelled as any).ok === true, JSON.stringify(cancelled));
const l2after = await getListing(l2!);
check("a cancelled deal puts the card back on the market", l2after?.status === "live", `status=${l2after?.status}`);

// value integrity
const negative = await makeOffer({ listingId: l2!, buyerId: BUYER, sellerId: SELLER, amount: -100 });
const negRow = (await pool.query("select amount from offers where offer_id = $1", [negative])).rows[0];
check("a negative offer is refused", negative === null || Number(negRow?.amount) > 0,
  `stored amount=${negRow?.amount}`);

const selfOffer = await makeOffer({ listingId: l2!, buyerId: SELLER, sellerId: SELLER, amount: 4000 });
check("a seller cannot bid on their own card", selfOffer === null, `offerId=${selfOffer}`);

console.log(`\n${"=".repeat(62)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (results.length) { console.log("\nBROKEN:"); for (const r of results) console.log("  - " + r); }

await admin.query(`drop schema if exists ${SCHEMA} cascade`);
await admin.end();
await pool.end().catch(() => {});
process.exit(fail ? 1 : 0);
