import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
for (const t of ["catalog_cards", "collection"]) {
  const r = await pool.query(
    "select column_name from information_schema.columns where table_name=$1 order by ordinal_position", [t]);
  console.log(t + ":", r.rows.map(x => x.column_name).join(", "));
}
await pool.end();
