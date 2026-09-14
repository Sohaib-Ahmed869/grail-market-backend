import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const SOHAIB = "u_o6PNH59d3Mg1", AYNA = "u_ce-OEP_zR8gu";
const q = async (label, sql, p = []) => {
  try { const r = await pool.query(sql, p); console.log(label + ":", JSON.stringify(r.rows)); }
  catch (e) { console.log(label + ": ERR " + e.message); }
};
await q("live listings", "select listing_id, card_name, seller_id from listings where status='live' limit 4");
await q("sohaib deals", "select deal_id, state from deals where buyer_id=$1 or seller_id=$1 limit 3", [SOHAIB]);
await q("sohaib offers", "select offer_id, status from offers where buyer_id=$1 or seller_id=$1 limit 3", [SOHAIB]);
await q("sohaib threads", "select thread_id from threads where buyer_id=$1 or seller_id=$1 limit 3", [SOHAIB]).catch(()=>{});
await q("community posts", "select post_id from community_posts limit 2");
await q("sohaib collection", "select entry_id, card_name, catalog_id from collection where user_id=$1", [SOHAIB]);
await q("ayna collection", "select entry_id, card_name, catalog_id, grader, grade from collection where user_id=$1", [AYNA]);
await q("share token", "select token, user_id from collection_shares limit 3");
await q("support", "select id from support_tickets limit 2");
await pool.end();
