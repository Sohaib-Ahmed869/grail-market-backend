// A cache that forgets.
//
// Every in-process cache here was a bare Map with a TTL checked on read and
// nothing that ever deleted a key. An expired entry was skipped, not removed,
// so the map only ever grew — one entry per distinct search term, per card id,
// per listing query, for the life of the process. That is fine at ten
// searches an hour and it is an out-of-memory kill at ten thousand, which is
// the traffic this is being pointed at.
//
// Bounded and LRU: reading an entry marks it recent (Map preserves insertion
// order, so delete-then-set moves it to the end), and inserting past the cap
// evicts the oldest. Expired entries are dropped on read rather than swept, so
// there is no timer to leak either.

import { db } from "../db.js";

// Persistence, for the caches that hold something we paid for.
//
// Every cache here lived in memory only, so every restart threw it away and
// the next request bought it again. On 14 Sep a day of dev reloads re-bought
// the sports set lists and player pictures until eBay's catalogue allowance
// (1,500 calls) was gone, and every sport came back empty. A cache given a
// namespace also writes to the local SQLite file the price cache already
// uses, and reads back from it after a restart. Memory is still the fast
// path; SQLite is only touched on a miss and on a write.
let tableReady = false;
function table() {
  if (tableReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ttl_cache (
    ns TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (ns, key)
  )`);
  tableReady = true;
}

export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; v: V }>();
  private writes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    /** Set to keep entries across restarts — see above. Only for values that
     *  are plain JSON. */
    private readonly persist?: string,
  ) {
    if (persist) table();
  }

  /** Read through to SQLite on a memory miss, restoring the entry with the
   *  time it was really written, so a restart does not reset its age. */
  private load(key: string): { at: number; v: V } | undefined {
    if (!this.persist) return undefined;
    try {
      const row = db.prepare("SELECT at, value FROM ttl_cache WHERE ns = ? AND key = ?")
        .get(this.persist, key) as { at: number; value: string } | undefined;
      if (!row) return undefined;
      return { at: Number(row.at), v: JSON.parse(row.value) as V };
    } catch {
      return undefined;
    }
  }

  /** The last value written, however old — for when fetching a fresh one is
   *  not possible (an allowance spent, a provider down). Yesterday's set list
   *  is a far better answer than an empty screen. */
  stale(key: string): V | undefined {
    return (this.map.get(key) ?? this.load(key))?.v;
  }

  get(key: string): V | undefined {
    let hit = this.map.get(key);
    if (!hit) {
      hit = this.load(key);
      if (hit && Date.now() - hit.at < this.ttlMs) this.map.set(key, hit);
    }
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // touch: most-recently-used goes to the back of the insertion order
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }

  /** Miss and a cached `null` are different answers.
   *
   *  Two of these caches store `V | null` as a NEGATIVE cache — "we asked, the
   *  answer was nothing, don't ask again for twelve hours". A bare get() gives
   *  back null for both cases, so a negative entry would read as a miss and
   *  the expensive call it exists to prevent would run every time. The wrapper
   *  is truthy whether or not the value inside it is. */
  entry(key: string): { v: V } | undefined {
    let hit = this.map.get(key);
    if (!hit) {
      hit = this.load(key);
      if (hit && Date.now() - hit.at < this.ttlMs) this.map.set(key, hit);
    }
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return { v: hit.v };
  }

  set(key: string, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    const at = Date.now();
    this.map.set(key, { at, v });
    if (this.persist) {
      try {
        db.prepare("INSERT INTO ttl_cache (ns, key, at, value) VALUES (?, ?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET at = excluded.at, value = excluded.value")
          .run(this.persist, key, at, JSON.stringify(v));
        // Old rows are kept a while past their TTL so `stale()` has something
        // to fall back on, then cleared now and then rather than on a timer.
        if (++this.writes % 500 === 0) {
          db.prepare("DELETE FROM ttl_cache WHERE ns = ? AND at < ?").run(this.persist, at - this.ttlMs * 7);
        }
      } catch {
        // A cache that cannot write is still a cache.
      }
    }
    while (this.map.size > this.max) {
      // Map iteration is insertion-ordered, so the first key is the coldest.
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
