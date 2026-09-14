import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
for (const t of ["grade_instances","grade_population"]) {
  const r = await pool.query("select count(*)::int n from information_schema.tables where table_name=$1",[t]);
  console.log(`  table ${t}: ${r.rows[0].n ? "created" : "MISSING"}`);
}
for (const t of ["catalog_cards","listings","collection"]) {
  const r = await pool.query(
    "select column_name from information_schema.columns where table_name=$1 and column_name in ('language','edition','finish') order by column_name",[t]);
  console.log(`  ${t}: ${r.rows.map(x=>x.column_name).join(", ") || "NONE"}`);
}
await pool.end();
