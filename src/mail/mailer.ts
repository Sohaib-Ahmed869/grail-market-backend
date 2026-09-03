// Transactional email.
//
// Two rules shape this. First, sending is behind an adapter, so the provider
// is a config change and not an edit to six call sites. Second, sending never
// throws: a password that was successfully changed must not report failure
// because a mail server was slow. The caller learns the outcome from the
// return value if it cares, and every caller so far does not.

export type Mail = { to: string; subject: string; text: string; html?: string };
export type SendResult = { ok: true; via: string; id?: string } | { ok: false; why: string };

const FROM = () => process.env.MAIL_FROM ?? "GrailCard <no-reply@grailcard.com.au>";

/** Resend's HTTP API — one POST, no SDK, no dependency to keep current. */
async function viaResend(m: Mail, key: string): Promise<SendResult> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM(), to: [m.to], subject: m.subject, text: m.text, html: m.html,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, why: `resend-${r.status}` };
    const body = (await r.json().catch(() => ({}))) as { id?: string };
    return { ok: true, via: "resend", id: body.id };
  } catch (e) {
    return { ok: false, why: `resend-${(e as Error).name}` };
  }
}

/** With no provider configured, the mail goes to the log.
 *
 *  This is what runs in development, and it prints the whole body on purpose:
 *  a reset link that only exists in an email nobody can read makes the flow
 *  untestable. In production a missing key is a misconfiguration, so it is
 *  also a warning rather than a silent no-op. */
function viaLog(m: Mail): SendResult {
  const where = process.env.NODE_ENV === "production" ? "warn" : "log";
  console[where](
    `[mail:unsent] no MAIL provider configured\n  to: ${m.to}\n  subject: ${m.subject}\n${m.text}`,
  );
  return { ok: true, via: "log" };
}

export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY);

export async function sendMail(m: Mail): Promise<SendResult> {
  if (!m.to || !m.to.includes("@")) return { ok: false, why: "no-recipient" };
  const key = process.env.RESEND_API_KEY;
  if (!key) return viaLog(m);
  const r = await viaResend(m, key);
  // A provider that rejected the message is worth a line — but the caller is
  // not told to fail, because the thing the user asked for already happened.
  if (!r.ok) console.warn(`[mail] ${m.subject} -> ${m.to} failed: ${r.why}`);
  return r;
}
