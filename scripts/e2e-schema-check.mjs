// Can we point the whole store at a throwaway schema? Read-only probe.
import pg from "pg";
// Neon's POOLED endpoint refuses the `options` startup parameter, which is
// the only way to pin a search_path. The direct endpoint accepts it, and the
// pooled host is the direct host with "-pooler" in it.
const base = process.env.DATABASE_URL.replace("-pooler.", ".");
const sep = base.includes("?") ? "&" : "?";
const url = `${base}${sep}options=${encodeURIComponent("-c search_path=e2e_scratch,public")}`;
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 15000 });
const r = await pool.query("select current_schema() cs, current_setting('search_path') sp");
console.log("current_schema:", r.rows[0].cs, "| search_path:", r.rows[0].sp);
await pool.end();
