// npm run backfill:sku -- [--write]
// Default is a dry run: it reports and writes nothing.
import { initStore } from "../src/cards.store.js";
import { initCatalog } from "../src/catalog/store.js";
import { backfillFinish } from "../src/catalog/backfill.js";

const write = process.argv.includes("--write");
await initStore();
await initCatalog();
const r = await backfillFinish({ dryRun: !write });
console.log(`\n${write ? "WROTE" : "DRY RUN — nothing written"}`);
console.log(`  considered ${r.considered}`);
console.log(`  ${write ? "written" : "would write"} ${r.written}`);
console.log(`  ambiguous  ${r.ambiguous}   (candidates disagreed — left null on purpose)`);
console.log(`  unmatched  ${r.unmatched}   (no printing for this card)`);
console.log(`  skipped    ${r.skipped}   (already had a finish)`);
if (r.examples.length) {
  console.log("\n  ambiguous examples:");
  for (const e of r.examples) console.log(`    ${e.catalogId}  saw: ${e.saw.join(", ")}`);
}
process.exit(0);
