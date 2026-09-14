import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const r = await pool.query(
  `select entry_id, card_name, grader, grade, pg_typeof(grade)::text gt
     from collection where user_id='u_o6PNH59d3Mg1'`);
for (const x of r.rows) console.log(JSON.stringify(x));
const g = await pool.query(
  `select catalog_id, grader, grade, pg_typeof(grade)::text gt, price, confidence, sample_size
     from grade_prices where catalog_id='ex15-100'`);
console.log("--- grade_prices for ex15-100:");
for (const x of g.rows) console.log(JSON.stringify(x));
await pool.end();
