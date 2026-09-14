import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const ME = "u_o6PNH59d3Mg1";
const held = await pool.query(
  "select catalog_id, card_name, grader, grade, quantity from collection where user_id=$1", [ME]);
for (const h of held.rows) {
  const gp = await pool.query(
    `select price, confidence, sample_size, fetched_at from grade_prices
      where catalog_id=$1 and grader=$2 and grade=$3`,
    [h.catalog_id, String(h.grader ?? "").toUpperCase(), h.grade]);
  const pp = await pool.query(
    `select count(*)::int n, max(day)::text last, max(price) p from price_points
      where catalog_id=$1 and grader=$2 and grade=$3`,
    [h.catalog_id, String(h.grader ?? "").toUpperCase(), h.grade]);
  console.log(`${h.card_name}  [${h.catalog_id}] ${h.grader ?? "raw"} ${h.grade ?? ""} x${h.quantity ?? 1}`);
  console.log(`   grade_prices rows: ${gp.rowCount}  ${gp.rows[0] ? `price=${gp.rows[0].price} conf=${gp.rows[0].confidence} n=${gp.rows[0].sample_size}` : "(none — header cannot value it)"}`);
  console.log(`   price_points: ${pp.rows[0].n} closes, last ${pp.rows[0].last ?? "-"}, latest price ${pp.rows[0].p ?? "-"}`);
}
await pool.end();
