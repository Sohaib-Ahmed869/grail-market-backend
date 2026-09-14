// Seed Ayna's collection for the demo: a mix of PSA slabs and raw cards,
// each with what she "paid" so the gain figures have both sides.
//
// Idempotent by (user, catalog_id, grader, grade) — running it twice does not
// double the collection.
import pg from "pg";
import { randomUUID } from "node:crypto";

const AYNA = "u_ce-OEP_zR8gu";
const WANT = [
  { catalog_id: "base1-4",    grader: "PSA", grade: "10", paid: 14500 },
  { catalog_id: "sv10-231",   grader: "PSA", grade: "10", paid: 980 },
  { catalog_id: "base1-1",    grader: "PSA", grade: "9",  paid: 420 },
  { catalog_id: "sv07-143",   grader: null,  grade: null, paid: 120 },
  { catalog_id: "swsh7-218",  grader: "BGS", grade: "9.5", paid: 2100 },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

for (const w of WANT) {
  const c = (await pool.query(
    "select catalog_id, name, set_name, card_number from catalog_cards where catalog_id = $1",
    [w.catalog_id],
  )).rows[0];
  if (!c) { console.log(`skip ${w.catalog_id} — not in catalog_cards`); continue; }

  const dupe = await pool.query(
    `select entry_id from collection
      where user_id=$1 and catalog_id=$2
        and coalesce(grader,'')=coalesce($3,'') and coalesce(grade,'')=coalesce($4,'')`,
    [AYNA, w.catalog_id, w.grader, w.grade],
  );
  if (dupe.rowCount) { console.log(`already there: ${c.name} ${w.grader ?? "raw"} ${w.grade ?? ""}`); continue; }

  await pool.query(
    `insert into collection
       (entry_id, user_id, catalog_id, card_name, set_name, card_number,
        image_url, grader, grade, quantity, paid, currency)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'AUD')`,
    [`c_${randomUUID().slice(0, 12)}`, AYNA, c.catalog_id, c.name, c.set_name,
     c.card_number, null, w.grader, w.grade, w.paid],
  );
  console.log(`added: ${c.name} (${c.set_name}) ${w.grader ?? "raw"} ${w.grade ?? ""} — paid A$${w.paid}`);
}

const n = await pool.query("select count(*)::int n from collection where user_id=$1", [AYNA]);
console.log(`\nAyna now holds ${n.rows[0].n} cards.`);
await pool.end();
