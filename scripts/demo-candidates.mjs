import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const r = await pool.query(`
  select c.catalog_id, c.name, c.set_name, c.card_number, c.game, c.raw_usd,
         (select count(*)::int from grade_prices g where g.catalog_id = c.catalog_id) graded
    from catalog_cards c
   where c.raw_usd is not null and c.raw_usd > 5
   order by (select count(*)::int from grade_prices g where g.catalog_id = c.catalog_id) desc,
            c.raw_usd desc
   limit 14`);
for (const x of r.rows) console.log(JSON.stringify(x));
await pool.end();
