import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { can, ROLE_LABEL, roleOf, type Capability } from "./roles.js";
import { staffFor, type Staff } from "./store.js";

// Who is asking, and may they.
//
// The admin endpoints authenticate exactly the way every other endpoint does:
// the caller's own session token, minted at sign-in. There is no separate
// admin credential, because a second credential is a second thing to leak, to
// rotate and to forget — and because a decision has to be filed against a
// person. A shared token cannot tell you who approved a listing.
//
// The console will get its own sign-in screen; when it does, nothing here
// changes. It signs a staff member in through the same /auth endpoints as the
// app, sends the same bearer token, and the role on their user row is what
// decides which pages open.

export type Caller = Staff & { can: (c: Capability) => boolean };

export type Denied = { error: string; message: string; status: 401 | 403 };

const UNAUTHENTICATED: Denied = {
  error: "unauthenticated",
  message: "Sign in to use the admin console.",
  status: 401,
};

/**
 * Resolve the caller, or say why not.
 *
 * Three outcomes, and they are deliberately different: not signed in, signed
 * in but not staff, and staff without this particular capability. A console
 * that answers all three with "no" cannot tell an operator whether to sign in
 * again or to ask for access.
 */
export async function requireStaff(req: Request): Promise<Caller | Denied> {
  const userId = callerId(req);

  /* No session, and the development shortcut is on: act as the operator it
     names. Nothing is read from or written to `users` — this is a stand-in for
     the sign-in screen the console has not got yet, not a real account, and it
     is gone the moment a real token arrives. */
  if (!userId) {
    const dev = devOperator();
    if (dev) return { ...dev, can: (c: Capability) => can(dev.role, c) };
    return UNAUTHENTICATED;
  }

  const staff = await staffFor(userId);
  if (!staff) {
    return {
      error: "not-staff",
      message: "This account does not hold a console role.",
      status: 403,
    };
  }
  return { ...staff, can: (c: Capability) => can(staff.role, c) };
}

/** As above, and then the one capability this endpoint needs. */
export async function requireCapability(
  req: Request,
  capability: Capability,
): Promise<Caller | Denied> {
  const who = await requireStaff(req);
  if ("error" in who) return who;
  if (!who.can(capability)) {
    return {
      error: "out-of-scope",
      message: `${ROLE_LABEL[who.role]} cannot ${capability.replace(".", " ")}.`,
      status: 403,
    };
  }
  return who;
}

export const denied = (v: Caller | Denied): v is Denied => "error" in v;

/**
 * The development stand-in for a signed-in operator.
 *
 * `ADMIN_DEV_USER` is the name a decision gets filed under; `ADMIN_DEV_ROLE`
 * is the role assumed, so the scoping can be exercised before there is a
 * sign-in screen to exercise it with. Neither reads or writes the database:
 * no real account is quietly promoted, and there is nothing to un-promote
 * later. Setting `ADMIN_DEV_USER` is the whole switch; unset, the console
 * answers 401 like anything else.
 *
 * It refuses to work when NODE_ENV is production. That refusal is the entire
 * safety of it, so it lives here, once, rather than at each call site.
 */
function devOperator(): Staff | null {
  const name = (process.env.ADMIN_DEV_USER ?? "").trim();
  if (!name) return null;
  if (process.env.NODE_ENV === "production") {
    console.warn("[admin] ADMIN_DEV_USER is set in production and is being ignored.");
    return null;
  }
  const role = roleOf(process.env.ADMIN_DEV_ROLE ?? "owner");
  if (role === "member") {
    console.warn(`[admin] ADMIN_DEV_ROLE="${process.env.ADMIN_DEV_ROLE}" is not a console role.`);
    return null;
  }
  return { userId: "dev", name, email: "", role };
}

/** Whether that stand-in is doing the work, so the console can say so. */
export const devAuthActive = (req: Request) => !callerId(req) && !!devOperator();
