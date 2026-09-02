import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { authConfigured, mintToken, readToken } from "./tokens.js";
import { createUser, findById, signIn, setAvatar } from "./store.js";

/** Who is calling.
 *
 *  Every route that acts on behalf of a member reads this rather than a header
 *  the client filled in. Until it existed, the app asserted its own user id —
 *  fine while nothing was at stake, and not fine now that a verified identity
 *  and a paid plan hang off it. */
export function callerId(req: Request): string | null {
  const raw = req.header("authorization") ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  if (!token) return null;
  const t = readToken(token);
  return t.ok ? t.userId : null;
}

@Controller("auth")
export class AuthController {
  @Post("register")
  async register(@Body() b: { email?: string; name?: string; phone?: string; password?: string }) {
    if (!authConfigured()) return { error: "auth-unconfigured", message: "AUTH_SECRET is not set" };
    const email = String(b?.email ?? "").trim();
    const name = String(b?.name ?? "").trim();
    const password = String(b?.password ?? "");
    if (!email.includes("@") || name.length < 2 || password.length < 10) {
      return { error: "invalid", message: "Check your details and try again." };
    }
    const r = await createUser({ email, name, phone: b?.phone ?? null, password });
    if (!r.ok) {
      return r.why === "email-taken"
        ? { error: "email-taken", message: "That email already has an account. Sign in instead." }
        : { error: "no-store", message: "Accounts are unavailable right now." };
    }
    return { token: mintToken(r.user.user_id), user: r.user };
  }

  @Post("login")
  async login(@Body() b: { email?: string; password?: string }) {
    if (!authConfigured()) return { error: "auth-unconfigured", message: "AUTH_SECRET is not set" };
    const r = await signIn(String(b?.email ?? ""), String(b?.password ?? ""));
    if (!r.ok) return { error: "bad-credentials", message: "That email and password don't match." };
    return { token: mintToken(r.user.user_id), user: r.user };
  }

  /** The token's holder, for an app restoring a session. */
  /** Choose a face. The value is a key from the app's own set — the list
   *  lives in the client because that is where the artwork is, and the column
   *  is capped so a bad client cannot use it as free storage. */
  @Post("avatar")
  async avatar(@Req() req: Request, @Body() b: { avatar?: string | null }) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const ok = await setAvatar(id, b?.avatar ?? null);
    return ok ? { avatar: b?.avatar ?? null } : { error: "not-found" };
  }

  @Get("me")
  async me(@Req() req: Request) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const user = await findById(id);
    return user ? { user } : { error: "unauthenticated" };
  }
}
