import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const n = await pool.query("select count(*)::int n, count(distinct game)::int g from printings");
console.log("printings rows:", n.rows[0].n, "| games:", n.rows[0].g);
const g = await pool.query("select game, count(*)::int n from printings group by 1 order by 2 desc");
console.log("by game:", g.rows.map(r=>`${r.game}=${r.n}`).join(" "));
const v = await pool.query(
  "select variant, count(*)::int n from printings where variant is not null group by 1 order by 2 desc limit 18");
console.log("\ntop variants:");
for (const r of v.rows) console.log(`  ${String(r.n).padStart(6)}  ${r.variant}`);
const s = await pool.query("select sub_type, count(*)::int n from printings where sub_type is not null group by 1 order by 2 desc limit 10");
console.log("\nsub_type:");
for (const r of s.rows) console.log(`  ${String(r.n).padStart(6)}  ${r.sub_type}`);
await pool.end();
