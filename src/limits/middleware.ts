import type { NextFunction, Request, Response } from "express";
import { SlidingWindow, type Rule } from "./bucket.js";
import { readToken } from "../auth/tokens.js";

// What is worth limiting, and how hard.
//
// The numbers come from what a real person does, not from a round figure. Six
// sign-in attempts in fifteen minutes covers mistyping a password twice and
// then going to look it up; a hundredth attempt is not a person. Anything not
// listed here is unlimited on purpose — browsing is the product, and a limit
// on reading listings would fire first for the member scrolling fastest.

const RULES: { test: RegExp; method?: string; rule: Rule; by: "ip" | "user" }[] = [
  // Credentials. The expensive ones, and the ones worth guessing.
  { test: /^\/auth\/login$/,        method: "POST", rule: { limit: 6,  windowMs: 15 * 60_000 }, by: "ip" },
  { test: /^\/auth\/login\/mfa$/,   method: "POST", rule: { limit: 8,  windowMs: 15 * 60_000 }, by: "ip" },
  { test: /^\/auth\/register$/,     method: "POST", rule: { limit: 5,  windowMs: 60 * 60_000 }, by: "ip" },
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

const windows = new SlidingWindow();

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
  const path = req.path;
  const match = RULES.find(
    (r) => r.test.test(path) && (!r.method || r.method === req.method),
  );
  if (!match) return next();

  // A user-scoped rule falls back to the address when nobody is signed in.
  // Otherwise one unauthenticated caller shares a bucket with every other,
  // and the first bot locks out everybody.
  const who = match.by === "user" ? callerFor(req) ?? `ip:${clientIp(req)}` : clientIp(req);
  const key = `${match.by}:${path}:${who}`;
  const d = windows.check(key, match.rule);

  if (!d.ok) {
    res.setHeader("retry-after", String(d.retryAfterSec));
    res.status(429).json({
      error: "rate-limited",
      message: `Too many attempts. Try again in ${
        d.retryAfterSec < 90
          ? `${d.retryAfterSec} seconds`
          : `${Math.ceil(d.retryAfterSec / 60)} minutes`
      }.`,
      retryAfterSec: d.retryAfterSec,
    });
    return;
  }
  res.setHeader("x-ratelimit-remaining", String(d.remaining));
  next();
}

/** Called when a sign-in succeeds, so four typos before the right password do
 *  not leave someone one mistake from a lockout on the account they are in. */
export function forgetLoginAttempts(req: Request): void {
  windows.clear(`ip:/auth/login:${clientIp(req)}`);
}
