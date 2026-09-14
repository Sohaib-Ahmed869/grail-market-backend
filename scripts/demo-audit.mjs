// Read-only survey of the demo accounts and the state of the trade tables.
// Nothing here writes. Run: node --env-file=.env scripts/demo-audit.mjs
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
});

const show = async (label, sql, params = []) => {
  try {
    const r = await pool.query(sql, params);
    console.log(`\n== ${label} (${r.rowCount})`);
    for (const row of r.rows) console.log("   ", JSON.stringify(row));
  } catch (e) {
    console.log(`\n== ${label}\n    ERROR: ${e.message}`);
  }
};

await show("users", "select user_id, name, email, role from users order by created_at limit 20");
await show("collection per user", "select user_id, count(*)::int n from collection group by 1");
await show("listings by status", "select status, count(*)::int n from listings group by 1");
await show("deals by state", "select state, count(*)::int n from deals group by 1");
await show("offers by status", "select status, count(*)::int n from offers group by 1");
await show("catalog_cards", "select count(*)::int n from catalog_cards");
await show("sales_ledger by source", "select source, count(*)::int n from sales_ledger group by 1");
await pool.end();
