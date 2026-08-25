import { db } from "../db.js";
import { chargeScan } from "./ledger.js";

// Per-provider daily consumption, measured rather than assumed.
//
// Only PPT reports its own budget (via x-ratelimit-* headers). Gemini's free
// allowance is account-specific and not exposed by the API, and JustTCG sends
// no rate-limit headers at all — so for those the only honest number is what
// WE have spent. Counting it here lets the UI say "N scans left" with a real
// denominator instead of a guess.

db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    provider TEXT NOT NULL,
    day TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, day)
  );
`);

const bump = db.prepare(
  "INSERT INTO usage (provider, day, units) VALUES (?, ?, ?) " +
    "ON CONFLICT(provider, day) DO UPDATE SET units = units + excluded.units",
);
const readDay = db.prepare("SELECT units FROM usage WHERE provider = ? AND day = ?");
const readSince = db.prepare(
  "SELECT COALESCE(SUM(units), 0) AS n FROM usage WHERE provider = ? AND day >= ?",
);

/** UTC day — matches how PPT and Gemini reset. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordUsage(provider: string, units = 1): void {
  try {
    bump.run(provider, today(), units);
  } catch {
    /* metering must never break a scan */
  }
  // Attribute the spend to the scan in flight, if there is one. Doing it here
  // means every adapter is covered by the call it already makes, rather than
  // each one having to remember to report separately — which is how a provider
  // ends up silently uncounted.
  try {
    chargeScan(provider, units);
  } catch {
    /* ditto */
  }
}

export function usedToday(provider: string): number {
  const row = readDay.get(provider, today()) as { units: number } | undefined;
  return row?.units ?? 0;
}

export function usedSince(provider: string, day: string): number {
  const row = readSince.get(provider, day) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** First day of the current UTC month, for monthly-quota providers. */
export function monthStart(): string {
  return new Date().toISOString().slice(0, 8) + "01";
}
