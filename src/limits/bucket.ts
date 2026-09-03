// Rate limiting, as a decision about counters.
//
// A sliding window rather than a fixed one: a fixed window lets an attacker
// send the whole allowance at 11:59:59 and the whole allowance again at
// 12:00:00, which is twice the limit in two seconds. This keeps the timestamps
// and counts what actually happened in the last N milliseconds.
//
// In process, deliberately. A shared store would survive a restart and cover
// several instances, and it would also put a network call in front of the
// login form — so the failure mode of the thing protecting sign-in becomes
// "the rate limiter is down, nobody can sign in". This is a floor, not a
// perimeter; the perimeter is the CDN.

export type Rule = { limit: number; windowMs: number };
export type Decision = { ok: true; remaining: number } | { ok: false; retryAfterSec: number };

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly max = 20_000) {}

  /** Records the attempt and says whether it is allowed.
   *
   *  Recording a REFUSED attempt too is on purpose: someone hammering the door
   *  should not have their window drain while they hammer. */
  check(key: string, rule: Rule, now = Date.now()): Decision {
    this.sweep(now);
    const cutoff = now - rule.windowMs;
    const seen = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    seen.push(now);
    this.hits.set(key, seen);

    if (seen.length > rule.limit) {
      // How long until the oldest hit leaves the window — which is the
      // earliest moment the next attempt could succeed.
      const oldest = seen[Math.max(0, seen.length - rule.limit - 1)];
      const waitMs = Math.max(0, oldest + rule.windowMs - now);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    return { ok: true, remaining: rule.limit - seen.length };
  }

  /** Forget a key entirely — used when an attempt SUCCEEDS, so a person who
   *  mistyped their password four times is not still near the limit for the
   *  next hour on the account they just got into. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Bounded, like every other in-process store here. Without this the map
   *  grows one entry per distinct IP for the life of the process. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.hits.size < this.max) return;
    this.lastSweep = now;
    const keep = new Map<string, number[]>();
    for (const [k, times] of this.hits) {
      // An hour covers the longest window any rule uses; anything older than
      // that cannot affect a decision.
      const live = times.filter((t) => t > now - 3_600_000);
      if (live.length) keep.set(k, live);
    }
    this.hits.clear();
    for (const [k, v] of keep) this.hits.set(k, v);
    while (this.hits.size > this.max) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
