// Keeping the trade on the platform.
//
// Two members swapping a phone number in the open is not a privacy problem,
// it is the marketplace being hollowed out: the deal moves to WhatsApp and
// the ID check, the dispute path and the record that a trade happened at all
// go with it. The scope document makes masking a launch requirement.
//
// The hard part is not finding phone numbers. It is not eating the catalogue
// while doing it — this forum is people typing "OP13-119", "Base Set 4/102"
// and "cert 82749113" all day, and a masker that swallows those makes the
// place unusable. So every digit rule below is anchored on shapes a phone
// number has and a card reference does not: a leading 0 or +, or grouping
// into 3-4 digit blocks, and never a run that sits against a / # - or letter.

const MASK = "[contact removed]";

export type CensorResult = {
  text: string;
  masked: boolean;
  /** what kind of thing was found, for moderation rather than for the user */
  hits: string[];
};

/** Digits written as words, which is the first thing anyone tries. */
const WORD_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/** Words that make a long number legitimate.
 *
 *  This is the inversion that makes the rule work. A phone number can be
 *  written a hundred ways — 343423423, 8 8 1 2 3 4 5 6 7 8, +61, (04) — and
 *  chasing each shape is a losing game. So any long run of digits is treated
 *  as a number to be removed UNLESS it is labelled as something else. In a
 *  graded-card marketplace the legitimate long numbers are certificates, and
 *  they are always introduced by one of these. */
const LABELLED = /(?:cert(?:ificate|ification)?|serial|psa|bgs|cgc|sgc|tag|ace|ags|slab)\s*#?\s*$/i;

const PHONE_PATTERNS: RegExp[] = [
  // +61 412 345 678 / +14155550132 — any international form
  /\+\d[\d\s().-]{7,17}\d/g,
  // 0412 345 678, 02 9876 5432, (04) 1234 5678 — a leading zero is the tell.
  // The first group is 1-3 digits because an AU mobile is 04XX XXX XXX while
  // a landline is 0X XXXX XXXX, and both have to match.
  /\(?0\d{1,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
  // 0412345678 run together
  /\b0\d{8,9}\b/g,
];

/** Links.
 *
 *  Blocked outright rather than masked selectively, because the danger is not
 *  what the URL says — it is that a plausible-looking address goes somewhere
 *  else. "grailmarket-verify.com" reads as ours and is not, and no amount of
 *  displaying the text protects someone who taps it. There is nothing a
 *  seller needs a link for that a photograph or a card page does not cover.
 */
const LINK_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/gi,
  /\bwww\.[\w-]+\.[a-z]{2,}\S*/gi,
  // bare domains with a real-looking TLD, so "grailmarket-verify.com" goes
  // even without a scheme. Restricted to common TLDs so "4/102" and
  // "PSA 10" survive.
  /\b[\w-]+\.(?:com|net|org|io|co|me|au|shop|store|xyz|link|app|site|info|biz)\b\S*/gi,
];

const EMAIL_PATTERNS: RegExp[] = [
  /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g,
  // me (at) example (dot) com, me [at] example [dot] com, me AT example DOT com
  /\b[\w.+-]+\s*[\[(]?\s*at\s*[\])]?\s*[\w-]+\s*[\[(]?\s*(?:dot|\.)\s*[\])]?\s*[a-z]{2,}\b/gi,
];

/** Apps people move to, and handles. Flagged, not silently allowed: naming
 *  the platform is the invitation, whether or not a number follows. */
const OFF_PLATFORM =
  /\b(whats\s?app|whatsap|telegram|signal|snap(?:chat)?|insta(?:gram)?|discord|messenger|viber|wechat|kik)\b/gi;
const HANDLE = /(?:^|\s)@[A-Za-z0-9._]{3,30}\b/g;

/** Any run of seven or more digits, however it is spaced.
 *
 *  Seven because that is the shortest thing anyone can dial, and because
 *  prices, years and card numbers are all shorter. Separators inside the run
 *  are ignored, so "8 8 1 2 3 4 5 6 7 8" and "415 555 0132" are the same
 *  thing to this rule — which is the point: the previous version matched
 *  shapes, and a person who wants to leak a number simply picks a different
 *  shape. */
function maskLongRuns(s: string): { text: string; found: boolean } {
  let found = false;
  const run = /\d(?:[\s.\-()]*\d){6,}/g;
  const text = s.replace(run, (m, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 24), offset);
    // a certificate, a card number, or part of a larger token
    if (LABELLED.test(before)) return m;
    if (/[\/#\w]$/.test(before)) return m;
    const after = whole[offset + m.length] ?? " ";
    if (/[\/]/.test(after)) return m;
    found = true;
    return MASK;
  });
  return { text, found };
}

/** Spelled-out digits: "oh four one two ..." — only masked when there are
 *  enough in a row to be a number rather than a sentence about a card. */
function maskWordDigits(s: string): { text: string; found: boolean } {
  const words = Object.keys(WORD_DIGITS).join("|");
  const run = new RegExp(`\\b(?:${words})(?:[\\s-]+(?:${words})){6,}\\b`, "gi");
  let found = false;
  const text = s.replace(run, () => { found = true; return MASK; });
  return { text, found };
}

/** Mask anything that would let two people finish the deal elsewhere. */
export function censor(input: string): CensorResult {
  if (!input) return { text: input, masked: false, hits: [] };
  let text = input;
  const hits: string[] = [];

  // Emails first: an address contains a domain, and running the link rules
  // first would eat half of it and leave "me@" behind.
  for (const re of EMAIL_PATTERNS) {
    text = text.replace(re, () => { if (!hits.includes("email")) hits.push("email"); return MASK; });
  }

  for (const re of LINK_PATTERNS) {
    text = text.replace(re, () => {
      if (!hits.includes("link")) hits.push("link");
      return "[link removed]";
    });
  }

  for (const re of PHONE_PATTERNS) {
    text = text.replace(re, (m, offset: number, whole: string) => {
      // A card reference sits against a slash, hash, dash-with-letters or a
      // letter; a phone number does not. Checking the neighbours is what
      // keeps "Base Set 4/102" and "OP13-119" intact.
      const before = whole[offset - 1] ?? " ";
      const after = whole[offset + m.length] ?? " ";
      if (/[\/#\w]/.test(before) || /[\/#]/.test(after)) return m;
      // A Beckett certificate starts 00 and is ten digits, which is exactly
      // the shape of a landline. The label is the only thing that separates
      // them, so this rule has to read it too — not just the newer one.
      if (LABELLED.test(whole.slice(Math.max(0, offset - 24), offset))) return m;
      // needs enough digits to be a number at all
      if ((m.match(/\d/g) ?? []).length < 8) return m;
      if (!hits.includes("phone")) hits.push("phone");
      return MASK;
    });
  }

  const runs = maskLongRuns(text);
  text = runs.text;
  if (runs.found && !hits.includes("phone")) hits.push("phone");

  const spelled = maskWordDigits(text);
  text = spelled.text;
  if (spelled.found && !hits.includes("phone")) hits.push("phone");

  if (OFF_PLATFORM.test(text)) hits.push("off-platform");
  OFF_PLATFORM.lastIndex = 0;
  if (HANDLE.test(text)) hits.push("handle");
  HANDLE.lastIndex = 0;

  return { text, masked: text !== input, hits };
}

/** Does this contain something that would take the deal off the platform?
 *
 *  Broader than `censor` masks: naming Telegram is an invitation even with no
 *  number attached. Used for flagging to moderation, not for rewriting text —
 *  masking the word "instagram" out of a sentence would read as a bug. */
export function hasContact(input: string): boolean {
  const r = censor(input);
  return r.masked || r.hits.length > 0;
}
