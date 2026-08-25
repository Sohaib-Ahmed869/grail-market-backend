import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "grailcard.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL
  );

  -- Paid price lookups, cached across restarts.
  --
  -- This was an in-process Map, which meant every dev reload (and every
  -- deploy) threw away the whole cache and the next scan re-bought prices it
  -- already had. PPT bills 2 credits per card returned, so a handful of
  -- repeat scans of the SAME card exhausted a day's quota and every card
  -- after that priced as blank. Cache lives in SQLite so a card costs
  -- credits once per TTL, not once per process.
  CREATE TABLE IF NOT EXISTS price_cache (
    key TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  -- Small durable key/value store. Currently holds the provider rate-limit
  -- breaker: when PPT reports its daily quota gone it also tells us exactly
  -- when it resets, and that deadline must outlive a restart or we go
  -- straight back to hammering a 429.
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
