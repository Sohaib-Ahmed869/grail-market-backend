import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const r = await pool.query(`
  select c.catalog_id, c.game, c.name, c.card_number, p.number_key, p.sub_type, p.variant
    from catalog_cards c
    join printings p on p.game = c.game and p.number_key = c.card_number
   limit 8`);
console.log("sample join (game + number_key = card_number):");
for (const x of r.rows) console.log("  ", JSON.stringify(x));
const n = await pool.query(`
  select count(*)::int n from catalog_cards c
   where exists (select 1 from printings p where p.game=c.game and p.number_key=c.card_number)`);
const t = await pool.query("select count(*)::int n from catalog_cards");
console.log(`\njoinable: ${n.rows[0].n} of ${t.rows[0].n} catalog_cards`);
await pool.end();
