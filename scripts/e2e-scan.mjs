// End-to-end scan sweep over the demo cards.
//
// The filenames carry the ground truth — "4-super-alternate-art-USD2116.jpg"
// says which printing it is and what it should be worth — so this checks the
// two things a scan has to get right, separately:
//
//   IDENTITY   did it name the right card
//   PRINTING   did it pick the right printing of that card
//
// Printing is the one that matters commercially. Every image in a One Piece
// folder is the same card number; only the artwork differs, and the spread
// inside one folder is up to 140x. A scan that gets the card right and the
// printing wrong is the expensive failure.
//
// Run: node --env-file=.env scripts/e2e-scan.mjs [api-base]
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";

const API = process.argv[2] ?? "http://localhost:8180";
const ROOT = new URL("../../demo-cards", import.meta.url).pathname;

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(jpe?g|png)$/i.test(p) ? [p] : [];
});

/** "4-super-alternate-art-USD2116.jpg" -> {printing, usd} */
function expected(file) {
  const b = basename(file).replace(/\.(jpe?g|png)$/i, "");
  const m = /^(\d+)-(.+?)-USD([\d.]+)$/.exec(b);
  if (!m) return { printing: null, usd: null, label: b };
  return { printing: m[2].replace(/-/g, " "), usd: Number(m[3]), label: b };
}

/** Does the chosen printing label mean the same thing as the filename's? */
function printingAgrees(want, gotLabel) {
  if (!want) return null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const w = norm(want);
  const g = norm(gotLabel ?? "");
  // A base card's label carries the collector number and nothing else:
  // "Monkey.D.Luffy (118)". The qualifier, when there is one, is a SECOND
  // parenthetical — "(118) (Parallel)" — so the number group has to come off
  // before asking whether anything qualifies the printing.
  const qualifier = (gotLabel ?? "").replace(/\(\s*\d+\s*\)/, "");
  if (w === "base") return !/\(/.test(qualifier);
  // "super alt art" vs "Super Alternate Art"; "manga" vs "(Manga)".
  const key = w.replace("alt", "alternate").replace("artart", "art");
  return g.includes(key) || g.includes(w);
}

const files = walk(ROOT).sort();
console.log(`${files.length} images against ${API}\n`);

const rows = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  const exp = expected(f);
  const form = new FormData();
  form.set("front", new Blob([readFileSync(f)]), basename(f));

  const t0 = Date.now();
  let r, body;
  try {
    r = await fetch(`${API}/scans`, { method: "POST", body: form });
    body = await r.json();
  } catch (e) {
    rows.push({ rel, ok: false, why: `request failed: ${e.message}` });
    console.log(`FAIL ${rel} — ${e.message}`);
    continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!r.ok) {
    rows.push({ rel, ok: false, why: `HTTP ${r.status} ${JSON.stringify(body).slice(0, 120)}` });
    console.log(`FAIL ${rel} — HTTP ${r.status}`);
    continue;
  }

  const id = body.identification ?? null;
  const pc = id?.printingChoice ?? null;
  const v = body.valuation ?? null;
  const price = v?.tcgplayer?.market ?? v?.tcgplayer?.low ?? null;
  const agrees = printingAgrees(exp.printing, pc?.label);

  rows.push({
    rel, ok: true, secs,
    card: id ? `${id.name} ${id.localId ?? ""}`.trim() : null,
    game: id?.game ?? null,
    matchScore: id?.matchScore ?? null,
    printing: pc?.label ?? null,
    method: pc?.method ?? null,
    margin: pc?.margin ?? null,
    wantPrinting: exp.printing,
    printingOk: agrees,
    price, wantUsd: exp.usd,
    rejection: body.rejection ?? null,
  });

  const idTxt = id ? `${id.name} ${id.localId ?? ""}` : "NOT IDENTIFIED";
  const pTxt = pc ? `${pc.label} (${pc.method}, margin ${Number(pc.margin ?? 0).toFixed(2)})` : "no printing choice";
  const flag = agrees === false ? "  <<< PRINTING WRONG" : "";
  console.log(`${secs}s ${rel}`);
  console.log(`      id: ${idTxt}   score=${id?.matchScore ?? "-"}`);
  console.log(`      printing: ${pTxt}${flag}`);
  console.log(`      price: ${price ?? "none"}  expected ~${exp.usd ?? "?"}`);
  if (body.rejection) console.log(`      REJECTED: ${JSON.stringify(body.rejection)}`);
}

// ---- summary
const done = rows.filter((r) => r.ok);
const failed = rows.filter((r) => !r.ok);
const unidentified = done.filter((r) => !r.card);
const wrongPrinting = done.filter((r) => r.printingOk === false);
const noPrice = done.filter((r) => r.price == null);

console.log(`\n${"=".repeat(60)}\nSUMMARY`);
console.log(`  images          ${rows.length}`);
console.log(`  request failed  ${failed.length}`);
console.log(`  not identified  ${unidentified.length}  ${unidentified.map(r => r.rel).join(", ")}`);
console.log(`  wrong printing  ${wrongPrinting.length}  ${wrongPrinting.map(r => r.rel).join(", ")}`);
console.log(`  no price        ${noPrice.length}  ${noPrice.map(r => r.rel).join(", ")}`);
