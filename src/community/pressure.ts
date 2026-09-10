// A phone number spread across four messages.
//
// Everything in `censor.ts` reads one message at a time, and every rule in it
// falls over the moment somebody types "my mobile starts 0412", then "345",
// then "678". No per-message rule can see that, however clever: each fragment
// is three or four digits, which is a quantity, a price, a card number, or
// nothing at all. The number only exists across the conversation.
//
// So this counts digits that have no business being there, per sender, per
// thread, over a short window. Fragments that ARE explained — a certificate, a
// card reference, a price, a year, a grade — are not counted, because this
// marketplace is people typing long numbers all day and a rule that cannot
// tell "1986 Fleer" from an area code is a rule that has to be turned off.
//
// When the unexplained digits add up to a dialable number, the message that
// completes it is masked and the thread is flagged. The earlier fragments
// cannot be recalled — they have been read already — but the number is not
// finished, the attempt is recorded, and whoever works trust & safety can see
// the whole exchange rather than four innocent-looking lines.

import { fold, replaceFolded } from "./fold.js";

const MASK = "[contact removed]";

/** Enough digits to dial. An Australian mobile is ten and a landline with an
 *  area code is ten; nine leaves room for somebody dropping a leading zero. */
const DIALABLE = 9;

/** Across at least this many fragments and this many messages.
 *
 *  One message carrying nine loose digits is already caught by the single
 *  message rules, so this only ever fires on something genuinely split up —
 *  which keeps it away from the person who happens to mention two prices. */
const MIN_PIECES = 3;
const MIN_MESSAGES = 2;

/** Things that make a number legitimate, read from the text just before it. */
const EXPLAINED = [
  /(?:cert(?:ificate|ification)?|serial|psa|bgs|cgc|sgc|tag|ace|ags|slab)\s*#?\s*$/i,
  /(?:grade[ds]?|gem|mint|nm|lp|mp|hp|centering|surface|edges|corners)\s*$/i,
  /(?:\$|aud|usd|eur|paid|pay|price[ds]?|offer(?:ed|ing)?|ask(?:ing)?|take|took|worth|sold|list(?:ed)?|says?|value[d]?|market|for|under|over|about|around)\s*$/i,
  /(?:of|from|out\s+of|set\s+of|#)\s*$/i,
  /(?:qty|quantity|x)\s*$/i,
];

/** A year, which every sports card and half the Pokemon sets carry. */
const isYear = (s: string) => /^(?:19|20)\d{2}$/.test(s);

/** Somebody saying, in words, that a number is coming.
 *
 *  This is the gate on the whole rule, and it is what keeps it off the ninety
 *  nine percent of threads that are two people haggling. "1986 Fleer 57" and
 *  "asking 4200, will take 3900" are unexplained digits by any measure, and
 *  counting them would mask an ordinary conversation about sports cards. The
 *  difference is never in the digits — it is that one of these people said the
 *  word "mobile".
 *
 *  "number" is excluded after "card", "set", "cert" and "serial", where it
 *  means the thing printed on the card. */
const INTENT =
  /\b(mobile|cell(?:phone)?|phone|whats\s?app|telegram|signal|snap(?:chat)?|insta(?:gram)?|discord|viber|wechat|kik|call me|text me|ring me|hit me up|reach me|contact me|add me|my digits|dial)\b|(?<!card\s|set\s|cert\s|serial\s)\bnumber\b/i;

/** A message that is digits and almost nothing else.
 *
 *  Nobody discusses a card by sending "345". A person doing that is reading a
 *  number out in pieces, and it is the one shape that needs no intent word to
 *  give it away — which matters, because the obvious way around a rule that
 *  wants the word "mobile" is not to type it. */
function isBare(folded: string): boolean {
  const words = folded.replace(/[\d\W_]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length <= 2;
}

export type Pieces = {
  /** How many unexplained digits this text contributes. */
  digits: number;
  /** Where they are, in FOLDED coordinates, for masking. */
  spans: { from: number; to: number }[];
  /** How many separate fragments they came in. */
  pieces: number;
  /** Whether the sender said a number was coming. */
  intent: boolean;
  /** Whether the message is digits and little else. */
  bare: boolean;
};

/** Digits in a message that nothing accounts for. */
export function loosePieces(input: string): Pieces {
  if (!input) return { digits: 0, spans: [], pieces: 0, intent: false, bare: false };
  const f = fold(input);
  const spans: { from: number; to: number }[] = [];
  let digits = 0;

  for (const m of f.text.matchAll(/\d(?:[\s.\-()]*\d)*/g)) {
    const run = m[0];
    const at = m.index ?? 0;
    const only = run.replace(/\D/g, "");
    // A single digit is a quantity. Two is the smallest piece anybody bothers
    // to split a number into.
    if (only.length < 2) continue;
    if (isYear(only)) continue;

    const before = f.text.slice(Math.max(0, at - 20), at);
    const after = f.text[at + run.length] ?? " ";
    // Against a slash, a hash or a letter is a card reference, not a number.
    if (/[\/#\w]$/.test(before) || /[\/#]/.test(after)) continue;
    if (EXPLAINED.some((re) => re.test(before))) continue;
    // A decimal is a measurement or a price, never a piece of a phone number.
    if (/\d\.\d/.test(run)) continue;

    digits += only.length;
    spans.push({ from: at, to: at + run.length });
  }

  return {
    digits, spans, pieces: spans.length,
    intent: INTENT.test(f.text),
    bare: digits > 0 && isBare(f.text),
  };
}

export type Verdict = {
  /** The message text to store, masked if this one completed a number. */
  text: string;
  /** True when this message was the one that tipped it over. */
  masked: boolean;
  /** Unexplained digits across the window, including this message. */
  total: number;
};

/** Judge one message against what its sender has already said in this thread.
 *
 *  `earlier` is the sender's own recent messages, newest first, as they were
 *  originally typed. */
export function weigh(input: string, earlier: string[]): Verdict {
  const mine = loosePieces(input);
  if (!mine.digits) return { text: input, masked: false, total: 0 };

  let total = mine.digits;
  let pieces = mine.pieces;
  let messages = 1;
  let intent = mine.intent;
  let bare = mine.bare ? 1 : 0;
  for (const past of earlier) {
    const p = loosePieces(past);
    // A message with no digits can still be the one that announced them.
    if (p.intent) intent = true;
    if (!p.digits) continue;
    total += p.digits;
    pieces += p.pieces;
    if (p.bare) bare++;
    messages++;
  }

  // Digits alone are never enough. Either the sender said a number was coming,
  // or they are sending fragments that are not a sentence about anything.
  const deliberate = intent || bare >= 2;
  const completes =
    deliberate && total >= DIALABLE && pieces >= MIN_PIECES && messages >= MIN_MESSAGES;
  if (!completes) return { text: input, masked: false, total };

  return {
    text: replaceFolded(input, fold(input), mine.spans, MASK),
    masked: true,
    total,
  };
}
