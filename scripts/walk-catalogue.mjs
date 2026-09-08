// Tap-through check: every game -> its first set -> its first card.
//
// This is the walk a person does, and not running it is why "Card Not Found"
// was reported fixed twice while seven of the nine games were still broken.
// The One Piece fix was real and it was one catalogue; the other six were
// never looked at.
//
// It calls nine live upstreams, so it is a script rather than part of `npm
// test`. Run it after touching anything in games.ts, opensources.ts, or the
// card endpoint:
//
//   npm run walk           (needs the API running on 8180)
//
const API = "http://localhost:8180";
const j = async (u) => { try { const r = await fetch(API+u,{signal:AbortSignal.timeout(90000)}); return await r.json(); } catch(e){ return {error:String(e.message)}; } };

const games = (await j("/market/games")).games ?? [];
console.log(`walking ${games.length} games\n`);
let bad = 0;
for (const g of games) {
  const sets = (await j(`/market/sets?game=${encodeURIComponent(g.id)}`)).sets ?? [];
  if (!sets.length) { console.log(`  ${g.name.padEnd(24)} NO SETS`); bad++; continue; }
  const set = sets[0];
  const detail = await j(`/market/sets/${encodeURIComponent(set.setId)}`);
  const cards = detail?.cards ?? [];
  if (!cards.length) { console.log(`  ${g.name.padEnd(24)} set "${set.name}" has NO CARDS`); bad++; continue; }
  const card = cards[0];
  const meta = await j(`/market/card?catalogId=${encodeURIComponent(card.cardId)}&setId=${encodeURIComponent(set.setId)}`);
  const ok = Boolean(meta?.name);
  if (!ok) bad++;
  console.log(`  ${g.name.padEnd(24)} ${ok ? "OK  " : "FAIL"} ${String(card.cardId).slice(0,30).padEnd(32)} ${ok ? meta.name : (meta.error ?? "no name")}`);
}
console.log(`\n${bad} of ${games.length} games break when you tap a card.`);

