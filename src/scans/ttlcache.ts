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

export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; v: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
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
    const hit = this.map.get(key);
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
    this.map.set(key, { at: Date.now(), v });
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
