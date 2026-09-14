import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const a = await pool.query("select game, count(*)::int n from catalog_cards group by 1 order by 2 desc");
console.log("catalog_cards by game:", a.rows.map(r=>`${r.game}=${r.n}`).join(" "));
const b = await pool.query("select game, count(*)::int n from printings group by 1 order by 2 desc");
console.log("printings by game  :", b.rows.map(r=>`${r.game}=${r.n}`).join(" "));
await pool.end();
