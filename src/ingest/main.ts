import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Same minimal .env loader main.ts uses. Duplicated deliberately: the job has
// to run from cron without booting Nest, and importing the API's bootstrap to
// get at four lines of parsing would drag the whole HTTP server in with it.
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const { ingestPrices } = await import("./prices.js");
const { backfillCatalogCards } = await import("./backfill.js");
const { verifyKeys } = await import("./verify.js");
const { reloadKeys } = await import("../scans/pptkeys.js");
const { initStore, storeConfigured } = await import("../cards.store.js");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const backfillOnly = args.includes("--backfill");
const verifyOnly = args.includes("--verify-keys");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

// The pool lives encrypted in the store, and configuredKeys() reads an
// in-memory snapshot that the server fills at boot. A CLI has no boot, so it
// has to load once before anything asks for a key — otherwise every command
// here sees an empty pool and reports "not set" for keys that are right there.
await reloadKeys().catch(() => 0);

if (verifyOnly) {
  const checks = await verifyKeys();
  process.exit(checks.some((c) => !c.ok) ? 1 : 0);
}

if (!storeConfigured()) {
  console.error("[ingest] DATABASE_URL is not set — the work list lives in Postgres");
  process.exit(1);
}
if (!(await initStore())) {
  console.error("[ingest] could not reach the store");
  process.exit(1);
}

// Always seed the registry first. It is free (TCGdex), idempotent, and a card
// we have already paid to price but never registered is a card the refresh job
// cannot see.
await backfillCatalogCards();
if (backfillOnly) process.exit(0);

const result = await ingestPrices({ limit, dryRun });
console.log(JSON.stringify(result, null, 2));
process.exit(result.stoppedBecause === "not-configured" ? 1 : 0);
