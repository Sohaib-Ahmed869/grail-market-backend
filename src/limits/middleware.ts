import type { NextFunction, Request, Response } from "express";
import { SlidingWindow, type Rule } from "./bucket.js";
import { readToken } from "../auth/tokens.js";
import { tickMaintenance } from "../maintenance/jobs.js";

// What is worth limiting, and how hard.
//
// The numbers come from what a real person does, not from a round figure. Six
// sign-in attempts in fifteen minutes covers mistyping a password twice and
// then going to look it up; a hundredth attempt is not a person. Anything not
// listed here is unlimited on purpose — browsing is the product, and a limit
// on reading listings would fire first for the member scrolling fastest.

const RULES: { test: RegExp; method?: string; rule: Rule; by: Dimension }[] = [
  // Credentials. The expensive ones, and the ones worth guessing.
  //
  // Keyed on the address AND the account being tried, not the address alone.
  // Guessing one password is what this is for, and that is one account from
  // one place — but a hundred different people signing in from a card show's
  // wifi, an office, or a suburb behind one carrier-grade NAT address are also
  // one address, and six attempts locked all of them out for a quarter of an
  // hour. The narrow key limits the attack without ever meeting the crowd.
  { test: /^\/auth\/login$/,        method: "POST", rule: { limit: 6,  windowMs: 15 * 60_000 }, by: "ip+account" },
  // A backstop on the address alone, well above what a room full of people
  // does and well below what a script does. Without it the key above is
  // trivially defeated by varying the email.
  { test: /^\/auth\/login$/,        method: "POST", rule: { limit: 120, windowMs: 15 * 60_000 }, by: "ip" },
  { test: /^\/auth\/login\/mfa$/,   method: "POST", rule: { limit: 8,  windowMs: 15 * 60_000 }, by: "ip+account" },
  // Registration is not a guessing attack — there is nothing to guess. This
  // exists to stop a script opening accounts in bulk, so the number has to
  // clear the real case of a lot of people signing up at once from one
  // address. Five an hour did not: the fifth person through the door shut it
  // for everyone else for an hour, and because a refused attempt is recorded
  // too, one person retrying a form pushed their own wait out towards the
  // full window. A ten-minute burst ceiling stops a script, which does not
  // stop at sixty, and never meets a crowd.
  { test: /^\/auth\/register$/,     method: "POST", rule: { limit: 60, windowMs: 10 * 60_000 }, by: "ip" },
  // Looser than a password: a token has already been checked by Google or
  // Apple before it reaches us, so the thing being limited is our own JWKS
  // fetching rather than a guessing attack.
  { test: /^\/auth\/oauth$/,        method: "POST", rule: { limit: 15, windowMs: 15 * 60_000 }, by: "ip" },
  // Sending mail costs money and lands in someone else's inbox, so this is
  // tighter than the rest — and it is the one endpoint a stranger can aim at
  // an address that is not theirs.
  { test: /^\/auth\/forgot$/,       method: "POST", rule: { limit: 4,  windowMs: 60 * 60_000 }, by: "ip" },
  { test: /^\/auth\/reset$/,        method: "POST", rule: { limit: 8,  windowMs: 60 * 60_000 }, by: "ip" },
  { test: /^\/auth\/password$/,     method: "POST", rule: { limit: 6,  windowMs: 15 * 60_000 }, by: "user" },
  { test: /^\/auth\/mfa\//,         method: "POST", rule: { limit: 10, windowMs: 15 * 60_000 }, by: "user" },

  // Anything that writes something other people see. A limit here is a spam
  // control rather than a security one, so it is generous enough that nobody
  // posting normally will ever meet it.
  { test: /^\/community\//,         method: "POST", rule: { limit: 30, windowMs: 10 * 60_000 }, by: "user" },
  { test: /^\/messages\//,          method: "POST", rule: { limit: 90, windowMs: 10 * 60_000 }, by: "user" },
  { test: /^\/listings\/[^/]+\/offer/, method: "POST", rule: { limit: 20, windowMs: 10 * 60_000 }, by: "user" },
  { test: /^\/ratings/,             method: "POST", rule: { limit: 15, windowMs: 60 * 60_000 }, by: "user" },
  { test: /^\/disputes/,            method: "POST", rule: { limit: 25, windowMs: 60 * 60_000 }, by: "user" },

  // A scan is the most expensive request we serve — it can reach a paid
  // provider. The plan quota is the real ceiling; this stops a loop.
  { test: /^\/scans$/,              method: "POST", rule: { limit: 40, windowMs: 10 * 60_000 }, by: "user" },
];

/** What a bucket is counted against.
 *
 *  `ip+account` narrows an address-keyed rule by the account being reached,
 *  so a limit meant to stop somebody guessing ONE password does not also
 *  count everyone else behind the same address. */
type Dimension = "ip" | "user" | "ip+account";

const windows = new SlidingWindow();

/** The account a credential request names, lowercased, or null.
 *
 *  Read from the parsed body — `express.json()` runs before this middleware.
 *  Never trusted for anything but a counter key: an attacker choosing their
 *  own key here only narrows their own bucket, and the address-wide backstop
 *  above is what stops them widening the attack that way. */
function accountFor(req: Request): string | null {
  const b = req.body as { email?: unknown; handle?: unknown } | undefined;
  const raw = b?.email ?? b?.handle;
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return t ? t.slice(0, 120) : null;
}

/** Behind a proxy the socket address is the proxy. Render and Cloudflare both
 *  set x-forwarded-for; the client is the FIRST entry, the rest are hops. */
function clientIp(req: Request): string {
  const fwd = req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/** The caller's id if they have one, without importing the auth controller —
 *  which would make a cycle, since the controller will import this. */
function callerFor(req: Request): string | null {
  const raw = req.header("authorization") ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  if (!token) return null;
  try {
    const t = readToken(token);
    return t.ok && !t.userId.startsWith("mfa:") ? t.userId : null;
  } catch {
    // readToken throws when AUTH_SECRET is unset. An unconfigured server
    // should not 500 on every request; it should fall back to the address.
    return null;
  }
}

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // Piggybacked here rather than given a middleware of its own: this already
  // runs on every request, and the check is a subtraction against an in-memory
  // clock that touches nothing in the common case. There is no cron process
  // and no worker dyno — see maintenance/schedule.ts for why.
  tickMaintenance();

  const path = req.path;
  // Every rule that matches, not the first. Sign-in carries two — a narrow
  // per-account one and a wide per-address backstop — and `find` would have
  // silently ignored the second, which is the half that stops the first being
  // walked around by varying the email.
  const matches = RULES.filter(
    (r) => r.test.test(path) && (!r.method || r.method === req.method),
  );
  if (!matches.length) return next();

  const ip = clientIp(req);
  // A user-scoped rule falls back to the address when nobody is signed in.
  // Otherwise one unauthenticated caller shares a bucket with every other,
  // and the first bot locks out everybody.
  const keyFor = (by: Dimension): string => {
    const who =
      by === "user" ? callerFor(req) ?? `ip:${ip}`
      // An unnamed account falls back to the address, so a request that simply
      // leaves the email out cannot slip past the rule by having no key.
      : by === "ip+account" ? `${ip}|${accountFor(req) ?? "-"}`
      : ip;
    return `${by}:${path}:${who}`;
  };

  // Every matching rule is recorded, then the tightest refusal wins. Checking
  // them all rather than stopping at the first failure keeps the counters
  // honest: a rule that stopped being consulted the moment a sibling refused
  // would drain while the caller was being turned away by the other one.
  let refused: { retryAfterSec: number } | null = null;
  let remaining = Infinity;
  for (const m of matches) {
    const d = windows.check(keyFor(m.by), m.rule);
    if (d.ok) remaining = Math.min(remaining, d.remaining);
    else if (!refused || d.retryAfterSec > refused.retryAfterSec) refused = d;
  }

  if (refused) {
    res.setHeader("retry-after", String(refused.retryAfterSec));
    res.status(429).json({
      error: "rate-limited",
      message: `Too many attempts. Try again in ${
        refused.retryAfterSec < 90
          ? `${refused.retryAfterSec} seconds`
          : `${Math.ceil(refused.retryAfterSec / 60)} minutes`
      }.`,
      retryAfterSec: refused.retryAfterSec,
    });
    return;
  }
  res.setHeader("x-ratelimit-remaining", String(remaining));
  next();
}

/** Called when a sign-in succeeds, so four typos before the right password do
 *  not leave someone one mistake from a lockout on the account they are in.
 *
 *  It clears the per-account bucket only. The address-wide backstop is left
 *  alone deliberately: it counts a volume no person reaches, so a success is
 *  not evidence against it — and letting one success wipe it would let an
 *  attacker with a single valid login reset the ceiling at will.
 *
 *  This has to build the key the same way the middleware does, and it did
 *  not survive the move to a two-part key on its own: it was clearing
 *  `ip:/auth/login:<addr>`, a key nothing writes any more, and silently
 *  forgetting nothing. Hence `keyForLogin`, used by both. */
export function forgetLoginAttempts(req: Request): void {
  windows.clear(keyForLogin(req));
}

/** The per-account sign-in key, in one place so the middleware and the
 *  success path cannot drift apart again. */
function keyForLogin(req: Request): string {
  return `ip+account:/auth/login:${clientIp(req)}|${accountFor(req) ?? "-"}`;
}
