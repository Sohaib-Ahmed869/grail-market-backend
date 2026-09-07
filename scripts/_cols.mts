import { loadEnvFile } from "../src/env.js";
loadEnvFile();
const { storePool } = await import("../src/cards.store.js");
const pool = storePool()!;
for (const t of ["subscriptions", "identity_status", "billing_events", "disputes", "listings"]) {
  const r = await pool.query(
    "select column_name from information_schema.columns where table_name=$1 order by ordinal_position", [t]);
  console.log(t + ": " + r.rows.map((x:any)=>x.column_name).join(", "));
}
const s = await pool.query("select status, count(*)::int n from subscriptions group by 1");
console.log("subs by status:", JSON.stringify(s.rows));
const i = await pool.query("select status, count(*)::int n from identity_status group by 1");
console.log("identity by status:", JSON.stringify(i.rows));
const b = await pool.query("select type, count(*)::int n from billing_events group by 1 order by 2 desc limit 8");
console.log("billing events:", JSON.stringify(b.rows));
await pool.end();
