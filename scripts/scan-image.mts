/** Scan a card photograph against eBay's own image recognition.
 *
 *  An INDEPENDENT check on what we say a card is. Our identifier reads the
 *  card and our feed prices it; both are ours. eBay's `search_by_image`
 *  answers "what does the rest of the market think this photograph is", with
 *  live asking prices attached, using an engine we did not write and cannot
 *  accidentally agree with. Where it names the same printing as us, that is
 *  corroboration. Where it does not, that is the finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { loadEnvFile } from "../src/env.js";
loadEnvFile(process.cwd());

const EBAY = "https://api.ebay.com";

async function token(): Promise<string | null> {
  const id = process.env.EBAY_APP_ID;
  const secret = process.env.EBAY_CERT_ID;
  if (!id || !secret) return null;
  const r = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=" +
      encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const b = (await r.json()) as any;
  if (!b.access_token) { console.error("token:", JSON.stringify(b).slice(0, 200)); return null; }
  return b.access_token as string;
}

async function scan(tok: string, file: string) {
  const b64 = readFileSync(file).toString("base64");
  const r = await fetch(`${EBAY}/buy/browse/v1/item_summary/search_by_image?limit=8`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    body: JSON.stringify({ image: b64 }),
  });
  if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 240)}` };
  return (await r.json()) as any;
}

const dir = process.argv[2];
if (!dir) { console.error("usage: scan-image.mts <folder-or-file>"); process.exit(1); }
const files = statSync(dir).isDirectory()
  ? readdirSync(dir).filter((f) => /\.(jpg|png)$/i.test(f)).map((f) => join(dir, f))
  : [dir];

const tok = await token();
if (!tok) { console.error("no eBay credentials"); process.exit(1); }

for (const f of files) {
  const r: any = await scan(tok, f);
  console.log(`\n── ${basename(f)}`);
  if (r.error) { console.log(`   ${r.error}`); continue; }
  const items = r.itemSummaries ?? [];
  if (!items.length) { console.log("   no matches"); continue; }
  for (const it of items.slice(0, 5)) {
    const p = it.price?.value ? `${it.price.currency} ${Number(it.price.value).toLocaleString()}` : "—";
    console.log(`   ${p.padStart(14)}  ${String(it.title).slice(0, 68)}`);
  }
}
process.exit(0);
