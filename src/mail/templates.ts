// The emails themselves, kept apart from the sending so the wording can be
// read and changed without going near a fetch call.

const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const shell = (heading: string, body: string) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f4f0;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <div style="font-size:20px;font-weight:700;color:#0f1b3d;letter-spacing:-0.3px">GrailCard</div>
    <h1 style="font-size:22px;color:#0f1b3d;margin:24px 0 12px">${esc(heading)}</h1>
    ${body}
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#8a8a8a;text-align:center">
    GrailCard · Australia · you received this because someone used this address on grailcard.com.au
  </p>
</div>`;

const button = (href: string, label: string) => `
<p style="margin:24px 0">
  <a href="${esc(href)}" style="display:inline-block;background:#0f1b3d;color:#fff;text-decoration:none;
     padding:14px 24px;border-radius:12px;font-weight:600">${esc(label)}</a>
</p>`;

export function resetEmail(name: string, link: string, minutes: number) {
  const text =
    `Hi ${name},\n\n` +
    `Someone asked to reset the password on your GrailCard account. Open this link within ${minutes} minutes:\n\n` +
    `${link}\n\n` +
    `If that wasn't you, you can ignore this — your password stays as it is.\n`;
  return {
    subject: "Reset your GrailCard password",
    text,
    html: shell(
      "Reset your password",
      `<p style="color:#4a4a4a;line-height:1.6">Hi ${esc(name)}, someone asked to reset the password on
       your account. This link works once, and stops working in ${minutes} minutes.</p>
       ${button(link, "Choose a new password")}
       <p style="color:#8a8a8a;font-size:13px;line-height:1.6">If that wasn't you, ignore this email —
       your password stays as it is. Nobody can get in with this link alone.</p>`,
    ),
  };
}

export function passwordChangedEmail(name: string) {
  const text =
    `Hi ${name},\n\nYour GrailCard password was just changed.\n\n` +
    `If that wasn't you, reset it immediately and check the devices signed in to your account.\n`;
  return {
    subject: "Your GrailCard password was changed",
    text,
    html: shell(
      "Your password was changed",
      `<p style="color:#4a4a4a;line-height:1.6">Hi ${esc(name)}, the password on your account was just
       changed.</p>
       <p style="color:#4a4a4a;line-height:1.6">If that wasn't you, reset it straight away — this is the
       only warning you get, and it is worth acting on.</p>`,
    ),
  };
}

export function mfaChangedEmail(name: string, enabled: boolean) {
  const what = enabled ? "turned on" : "turned off";
  return {
    subject: `Two-step verification ${what}`,
    text: `Hi ${name},\n\nTwo-step verification on your GrailCard account was ${what}.\n\n` +
      `If that wasn't you, change your password now.\n`,
    html: shell(
      `Two-step verification ${what}`,
      `<p style="color:#4a4a4a;line-height:1.6">Hi ${esc(name)}, two-step verification on your account
       was ${what}. If that wasn't you, change your password now.</p>`,
    ),
  };
}

export function welcomeEmail(name: string) {
  return {
    subject: "Welcome to GrailCard",
    text: `Hi ${name},\n\nYour GrailCard account is ready. Scan a card to see what it's worth, ` +
      `build a collection, and list what you're ready to part with.\n`,
    html: shell(
      "Welcome to GrailCard",
      `<p style="color:#4a4a4a;line-height:1.6">Hi ${esc(name)}, your account is ready. Scan a card to
       see what it's worth, build a collection, and list what you're ready to part with.</p>`,
    ),
  };
}
