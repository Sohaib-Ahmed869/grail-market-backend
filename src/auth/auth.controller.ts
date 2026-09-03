import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { authConfigured, mintToken, readToken } from "./tokens.js";
import {
  changePassword, consumeReset, createReset, createUser, disableMfa, enableMfa,
  findByEmail, findById, linkIdentity, linkedProviders, pendingMfaSecret, setAvatar,
  signIn, spendRecoveryCode, stageMfa, updateProfile,
} from "./store.js";
import { oauthConfigured, verifyIdentity, type Provider } from "./oauth.js";
import { providerKey } from "./jwt.js";
import { RESET_TTL_MS } from "./reset.js";
import { newSecret, otpauthUrl, recoveryCodes, verifyTotp } from "./totp.js";
import { forgetLoginAttempts } from "../limits/middleware.js";
import { sendMail } from "../mail/mailer.js";
import { mfaChangedEmail, passwordChangedEmail, resetEmail, welcomeEmail } from "../mail/templates.js";

const digest = (s: string) =>
  createHash("sha256").update(String(s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "")).digest("hex");

/** Where the reset link points. The app opens it; the web app renders it. */
const resetLink = (token: string) =>
  `${process.env.PUBLIC_WEB_URL ?? "https://grailcard.com.au"}/reset?token=${encodeURIComponent(token)}`;

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
  if (!t.ok) return null;
  // A half-finished sign-in is not a sign-in. The MFA challenge is minted with
  // the same signature as a session token — deliberately, so it cannot be
  // forged — which means this is the place that stops it being spent as one.
  if (t.userId.startsWith("mfa:")) return null;
  return t.userId;
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
    await sendMail({ to: r.user.email, ...welcomeEmail(r.user.name) });
    return { token: mintToken(r.user.user_id), user: r.user };
  }

  @Post("login")
  async login(@Body() b: { email?: string; password?: string }, @Req() req?: Request) {
    if (!authConfigured()) return { error: "auth-unconfigured", message: "AUTH_SECRET is not set" };
    const email = String(b?.email ?? "");
    const r = await signIn(email, String(b?.password ?? ""));
    if (!r.ok) return { error: "bad-credentials", message: "That email and password don't match." };
    // The password was right, whichever branch we take below. Clearing here
    // means four typos before the correct password do not leave someone one
    // mistake from a lockout on the account they are getting into.
    if (req) forgetLoginAttempts(req);

    // Second step, if the account has one. The password was correct, so a
    // short-lived token is minted to carry that fact to the /login/mfa call —
    // otherwise the second step would have to take the password again.
    if (r.user.mfa_enabled) {
      return {
        mfa: "required",
        challenge: mintToken(`mfa:${r.user.user_id}`, 5 * 60 * 1000),
        message: "Enter the code from your authenticator app.",
      };
    }
    return { token: mintToken(r.user.user_id), user: r.user };
  }

  /** Step two of signing in. Accepts a six-digit code or a recovery code. */
  @Post("login/mfa")
  async loginMfa(@Body() b: { challenge?: string; code?: string }) {
    if (!authConfigured()) return { error: "auth-unconfigured", message: "AUTH_SECRET is not set" };
    const t = readToken(String(b?.challenge ?? ""));
    if (!t.ok || !t.userId.startsWith("mfa:")) {
      return { error: "challenge-expired", message: "That took too long. Sign in again." };
    }
    const userId = t.userId.slice(4);
    const user = await findById(userId);
    if (!user) return { error: "bad-credentials", message: "Sign in again." };

    const row = await findByEmail(user.email);
    const code = String(b?.code ?? "");
    const ok =
      (row?.mfa_secret && verifyTotp(row.mfa_secret, code, Date.now())) ||
      (code.replace(/[^0-9A-Za-z]/g, "").length === 10 &&
        (await spendRecoveryCode(userId, digest(code))));
    if (!ok) return { error: "bad-code", message: "That code isn't right. Codes change every 30 seconds." };
    return { token: mintToken(userId), user };
  }

  /** Sign in with Google or Apple.
   *
   *  The app never sends us a password here and never handles one — it hands
   *  over the identity token the provider gave it, and everything that makes
   *  that trustworthy happens in verifyIdentity: the signature, the issuer,
   *  the audience and the expiry. */
  @Post("oauth")
  async oauth(
    @Body() b: { provider?: string; idToken?: string; name?: string },
    @Req() req?: Request,
  ) {
    if (!authConfigured()) return { error: "auth-unconfigured", message: "AUTH_SECRET is not set" };
    const provider = String(b?.provider ?? "") as Provider;
    if (provider !== "google" && provider !== "apple") {
      return { error: "invalid", message: "Unknown sign-in method." };
    }
    if (!oauthConfigured(provider)) {
      return {
        error: "not-configured",
        message: `Signing in with ${provider === "google" ? "Google" : "Apple"} isn't set up yet.`,
      };
    }

    const v = await verifyIdentity(provider, String(b?.idToken ?? ""), b?.name ?? null);
    if (!v.ok) {
      // One message for every bad-token reason, and a different one for the
      // provider being down — the first is nothing the user can act on, the
      // second is worth trying again in a minute.
      return v.why === "provider-unreachable"
        ? { error: "provider-down", message: "Couldn't reach that sign-in service. Try again shortly." }
        : { error: "bad-token", message: "That sign-in didn't check out. Try again." };
    }

    const r = await linkIdentity({
      provider,
      providerKey: providerKey(provider, v.identity.sub),
      email: v.identity.email,
      emailVerified: v.identity.emailVerified,
      name: v.identity.name,
    });
    if (!r.ok) {
      const message = {
        "no-store": "Accounts are unavailable right now.",
        "no-email": "That account didn't share an email address, so we can't create one for you.",
        // Deliberately specific: this is the one case where telling them what
        // to do next is more use than a generic refusal, and it reveals
        // nothing — they already proved they hold the address.
        "needs-password": "An account already uses that email. Sign in with your password instead.",
      }[r.why];
      return { error: r.why, message };
    }

    if (r.created) {
      await sendMail({ to: r.user.email, ...welcomeEmail(r.user.name) });
    }
    if (req) forgetLoginAttempts(req);
    return { token: mintToken(r.user.user_id), user: r.user, created: r.created };
  }

  // ---- forgotten password --------------------------------------------------

  /** Always the same answer.
   *
   *  Reporting "no account with that email" turns this form into a way to
   *  test which addresses are registered, which is exactly what a credential
   *  stuffer wants before they start. */
  @Post("forgot")
  async forgot(@Body() b: { email?: string }) {
    const same = {
      ok: true,
      message: "If that address has an account, a reset link is on its way.",
    };
    const email = String(b?.email ?? "").trim();
    if (!email.includes("@")) return same;
    const row = await findByEmail(email);
    if (!row) return same;

    const r = await createReset(row.user_id);
    if (r) {
      const mail = resetEmail(row.name, resetLink(r.token), Math.round(RESET_TTL_MS / 60000));
      await sendMail({ to: row.email, ...mail });
    }
    return same;
  }

  /** Spend the link and set the new password. One message for every failure —
   *  the reasons are separated in `resetVerdict` for our logs, not for here. */
  @Post("reset")
  async reset(@Body() b: { token?: string; password?: string }) {
    const password = String(b?.password ?? "");
    if (password.length < 10) {
      return { error: "weak", message: "Use at least 10 characters." };
    }
    const r = await consumeReset(String(b?.token ?? ""), password);
    if (!r.ok) {
      return {
        error: "bad-token",
        message: "That link has expired or has already been used. Ask for a new one.",
      };
    }
    const user = await findById(r.userId);
    if (user) await sendMail({ to: user.email, ...passwordChangedEmail(user.name) });
    return { token: mintToken(r.userId), user };
  }

  // ---- account settings ----------------------------------------------------

  @Post("password")
  async password(@Req() req: Request, @Body() b: { current?: string; next?: string }) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const r = await changePassword(id, String(b?.current ?? ""), String(b?.next ?? ""));
    if (!r.ok) {
      return r.why === "weak"
        ? { error: "weak", message: "Use at least 10 characters." }
        : { error: "wrong-password", message: "That's not your current password." };
    }
    const user = await findById(id);
    if (user) await sendMail({ to: user.email, ...passwordChangedEmail(user.name) });
    return { ok: true };
  }

  @Post("profile")
  async profile(@Req() req: Request, @Body() b: { name?: string; phone?: string | null }) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const user = await updateProfile(id, {
      name: b?.name, phone: b?.phone === undefined ? undefined : b?.phone,
    });
    return user ? { user } : { error: "invalid", message: "Check your details and try again." };
  }

  // ---- two-step verification -----------------------------------------------

  /** Hand out a secret and the QR payload. Nothing is on yet. */
  @Post("mfa/start")
  async mfaStart(@Req() req: Request) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const user = await findById(id);
    if (!user) return { error: "unauthenticated" };
    if (user.mfa_enabled) return { error: "already-on", message: "Two-step is already on." };
    const secret = newSecret();
    if (!(await stageMfa(id, secret))) return { error: "no-store" };
    return { secret, otpauth: otpauthUrl(secret, user.email) };
  }

  /** Prove the app works, then it goes on — and only then are recovery codes
   *  shown, once, because they are stored hashed and cannot be shown again. */
  @Post("mfa/confirm")
  async mfaConfirm(@Req() req: Request, @Body() b: { code?: string }) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const secret = await pendingMfaSecret(id);
    if (!secret) return { error: "not-started", message: "Start again from your account settings." };
    if (!verifyTotp(secret, String(b?.code ?? ""), Date.now())) {
      return { error: "bad-code", message: "That code isn't right. Codes change every 30 seconds." };
    }
    const codes = recoveryCodes();
    if (!(await enableMfa(id, codes.map(digest)))) return { error: "no-store" };
    const user = await findById(id);
    if (user) await sendMail({ to: user.email, ...mfaChangedEmail(user.name, true) });
    return { ok: true, recoveryCodes: codes };
  }

  /** Turning it off takes the password, for the same reason changing one does. */
  @Post("mfa/off")
  async mfaOff(@Req() req: Request, @Body() b: { password?: string }) {
    const id = callerId(req);
    if (!id) return { error: "unauthenticated" };
    const user = await findById(id);
    if (!user) return { error: "unauthenticated" };
    const row = await findByEmail(user.email);
    const { verifyPassword } = await import("./passwords.js");
    if (!row || !(await verifyPassword(String(b?.password ?? ""), row.password))) {
      return { error: "wrong-password", message: "Enter your password to turn this off." };
    }
    await disableMfa(id);
    await sendMail({ to: user.email, ...mfaChangedEmail(user.name, false) });
    return { ok: true };
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
    if (!user) return { error: "unauthenticated" };
    return { user, providers: await linkedProviders(id) };
  }

  /** Which sign-in methods this build can actually offer. The app asks before
   *  it draws the buttons — a Google button on a server with no client id is
   *  a button that fails after the person has already left the app. */
  @Get("methods")
  methods() {
    return {
      password: authConfigured(),
      google: oauthConfigured("google"),
      apple: oauthConfigured("apple"),
    };
  }
}
