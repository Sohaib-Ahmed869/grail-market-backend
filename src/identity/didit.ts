import { createHmac, timingSafeEqual } from "node:crypto";

// Didit identity verification, server side.
//
// The API key lives here and only here. A mobile app that could create its own
// verification sessions could create them for anybody, so the phone asks this
// service and gets back a single-use token — the key never leaves the server
// and never reaches a bundle someone can unzip.

const BASE = "https://verification.didit.me";

/** Which modules run, and their thresholds. Configuration, not a secret — it
 *  is chosen per session and belongs in code where it can be reviewed. */
export const WORKFLOW_ID = "bf3b831d-c410-4f36-82aa-64bea6e3307c";

export type SessionOut = { sessionId: string; token: string; url: string };

export function diditConfigured(): boolean {
  return Boolean(process.env.DIDIT_API_KEY);
}

/** Open a verification for one member.
 *
 *  `vendorData` is our own user id. Didit files the session against it, and it
 *  is what comes back on the webhook — so it is the only thing tying a
 *  decision to a person, and it must be ours rather than anything the client
 *  supplied. */
export async function createSession(vendorData: string): Promise<SessionOut> {
  const key = process.env.DIDIT_API_KEY;
  if (!key) throw new Error("DIDIT_API_KEY is not set");

  const res = await fetch(`${BASE}/v3/session/`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_id: WORKFLOW_ID, vendor_data: vendorData }),
  });

  if (!res.ok) {
    // 403 here means the key is missing, wrong, or revoked. There is no
    // machine-readable discriminator, so it is logged and handled as one case.
    const detail = await res.text();
    throw new Error(`didit session create failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const s = (await res.json()) as {
    session_id: string; session_token: string; url: string;
  };
  return { sessionId: s.session_id, token: s.session_token, url: s.url };
}

// ---- webhook verification ---------------------------------------------------

/** Whole-number floats become integers, recursively.
 *
 *  Didit canonicalises this way before signing, so 1.0 signs as 1. Skip it and
 *  every payload containing a round score fails to verify. */
function shortenFloats(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shortenFloats);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shortenFloats(x)]),
    );
  }
  if (typeof v === "number" && !Number.isInteger(v) && v % 1 === 0) return Math.trunc(v);
  return v;
}

/** Keys sorted lexicographically, array order untouched. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

export const canonicalise = (parsed: unknown): string =>
  JSON.stringify(sortKeys(shortenFloats(parsed)));

export type VerifyResult =
  | { ok: true }
  | { ok: false; why: "no-secret" | "stale" | "bad-signature" };

/** Is this webhook really from Didit, and recent?
 *
 *  X-Signature-V2 rather than X-Signature: it signs the re-serialised body, so
 *  it survives Express parsing the JSON and handing us an object. The raw-bytes
 *  variant does not.
 *
 *  Freshness matters as much as the signature. A valid signature is valid
 *  forever, so without the timestamp window an attacker who captured one
 *  approval could replay it to verify anyone, any time. */
export function verifyWebhook(
  rawBody: string,
  signature: string,
  timestamp: string | number,
  nowMs = Date.now(),
): VerifyResult {
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, why: "no-secret" };

  const ts = Number(timestamp);
  if (!ts || Math.abs(nowMs / 1000 - ts) > 300) return { ok: false, why: "stale" };

  const expected = createHmac("sha256", secret)
    .update(canonicalise(JSON.parse(rawBody)), "utf8")
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  // length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and the length is not the secret
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, why: "bad-signature" };
  }
  return { ok: true };
}

/** The statuses Didit sends, exactly. Compared case-sensitively — "Approved"
 *  and "approved" are not the same string and only one of them ever arrives. */
export type DiditStatus =
  | "Not Started" | "In Progress" | "Awaiting User" | "In Review"
  | "Approved" | "Declined" | "Resubmitted" | "Abandoned"
  | "Expired" | "Kyc Expired";
