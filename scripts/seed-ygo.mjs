// npm run seed:ygo -- [--write] [--limit N]
// Dry run by default: it fetches and maps, and writes nothing.
import { initStore } from "../src/cards.store.js";
import { seedYugioh } from "../src/catalog/seedygo.js";

const args = process.argv;
const write = args.includes("--write");
const li = args.indexOf("--limit");
const limit = li > -1 ? Number(args[li + 1]) : 2000;

await initStore();
const r = await seedYugioh({ limit, dryRun: !write });
console.log(`\n${write ? "WROTE" : "DRY RUN - nothing written"}`);
console.log(`  pages fetched ${r.pages}`);
console.log(`  cards         ${r.cards}`);
console.log(`  printings     ${r.printings}`);
console.log(`  written       ${r.written}`);
process.exit(0);
