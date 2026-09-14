// Turning what somebody typed into what they meant, before anything reads it.
//
// The masking rules in `censor.ts` are good at the shapes a phone number has.
// They are useless against a person who writes the same number in a different
// alphabet, and there are a lot of alphabets:
//
//   ０４１２３４５６７８     fullwidth, one keystroke away on any IME
//   ٠٤١٢٣٤٥٦٧٨            Arabic-Indic
//   0️⃣4️⃣1️⃣2️⃣              emoji keycaps
//   04​12​345​678            zero-width joiners between the digits
//   O4I2 E45 G78          letters that look like digits
//   cero cuatro uno dos   any language at all
//
// Chasing each of those with its own regular expression is a treadmill: the
// next one is always cheaper to invent than to block. So nothing here blocks
// anything. This file folds all of them down to plain ASCII digits and hands
// ONE canonical string to the rules, which then only ever have to know about
// "0412345678".
//
// The catch is that the text people see must be the text they typed, with the
// masked parts replaced — not a folded version of it. So every character in
// the folded string remembers which characters of the original it came from,
// and a match found in the fold can be mapped back to the span that produced
// it. That is what `Folded.origin` is for.

/** A folded copy of some text, plus the map back to the original. */
export type Folded = {
  /** The canonical text: ASCII, no zero-width characters, digits as digits. */
  text: string;
  /** For each index in `text`, the [start, end) span of the ORIGINAL it came
   *  from. A folded character can stand for several original ones ("three"
   *  becomes "3") and some original characters stand for none (a zero-width
   *  joiner), so this is not an offset — it is a lookup. */
  origin: { start: number; end: number }[];
};

/* Digits that are not ASCII digits. Every one of these is a keyboard people
 * actually have: Arabic, Persian, Devanagari, Bengali, Thai, and the fullwidth
 * forms that Japanese and Chinese input methods produce by default. */
const DIGIT_BLOCKS: [number, string][] = [
  [0xff10, "fullwidth"],
  [0x0660, "arabic-indic"],
  [0x06f0, "extended-arabic-indic"],
  [0x0966, "devanagari"],
  [0x09e6, "bengali"],
  [0x0e50, "thai"],
];

function asciiDigit(code: number): string | null {
  if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
  for (const [base] of DIGIT_BLOCKS) {
    if (code >= base && code <= base + 9) return String(code - base);
  }
  return null;
}

/** Characters that carry no meaning and exist to break up a pattern.
 *
 *  A zero-width space between every digit defeats any rule written in terms of
 *  adjacency, costs the sender nothing, and is invisible to the person reading
 *  it. Emoji keycaps are here for the same reason: "1️⃣" is the digit 1, a
 *  variation selector and a combining keycap. */
const INVISIBLE = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, // zero-width space/joiners, BOM
  0xfe0e, 0xfe0f,                          // variation selectors
  0x20e3,                                  // combining enclosing keycap
  0x00ad,                                  // soft hyphen
]);

/** Number words, in the languages this marketplace is actually used in.
 *
 *  Sydney is the market and the sellers are not all writing English. Each of
 *  these is only ever folded as a WHOLE word, and folding one is harmless on
 *  its own — "one of these" becoming "1 of these" changes nothing, because
 *  every rule downstream needs seven digits in a row before it acts. What it
 *  stops is a number spelled out from end to end.
 *
 *  Words that are common in ordinary English are deliberately absent even
 *  where they are digits elsewhere: "do" is two in Hindi and "a" question in
 *  every second message here. */
const WORDS: Record<string, string> = {
  // English
  zero: "0", oh: "0", nought: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  // Spanish
  cero: "0", uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5",
  seis: "6", siete: "7", ocho: "8", nueve: "9",
  // French. Accents are stripped before the lookup, so "zero" here also
  // catches "zéro" as typed.
  un: "1", deux: "2", trois: "3", quatre: "4", cinq: "5",
  sept: "7", huit: "8", neuf: "9",
  // German
  eins: "1", zwei: "2", drei: "3", vier: "4", funf: "5",
  sechs: "6", sieben: "7", acht: "8",
  // Italian / Portuguese
  due: "2", tre: "3", quattro: "4", cinque: "5", sei: "6", otto: "8", nove: "9",
  um: "1", dois: "2", oito: "8",
  // Hindi / Urdu, written in Latin script, which is how it is typed here
  ek: "1", teen: "3", char: "4", chaar: "4", paanch: "5", panch: "5",
  chhe: "6", cheh: "6", saat: "7", aath: "8", nau: "9", sifar: "0", sunya: "0",
  // Indonesian / Malay
  satu: "1", dua: "2", tiga: "3", empat: "4", lima: "5", enam: "6",
  tujuh: "7", delapan: "8", sembilan: "9", nol: "0",
  // Chinese, both the characters and the pinyin
  "零": "0", "一": "1", "二": "2", "三": "3", "四": "4",
  "五": "5", "六": "6", "七": "7", "八": "8", "九": "9",
  ling: "0", yi: "1", er: "2", san: "3", si: "4", wu: "5", liu: "6",
  qi: "7", ba: "8", jiu: "9",
};

/** Number words that are also ordinary words in English.
 *
 *  "do" is two in Hindi and half the messages in this app; "si" is four in
 *  pinyin and "if" in Spanish. Folding them everywhere would be noise, so they
 *  fold only when the words on BOTH sides are already digits — which is to say,
 *  only in the middle of a number being spelled out. */
const AMBIGUOUS: Record<string, string> = {
  do: "2", no: "9", si: "4", a: "8", er: "2", yi: "1", ba: "8", wu: "5",
  sei: "6", um: "1", un: "1", one_: "1",
};

/** Letters people use as digits.
 *
 *  Only ever applied inside a token that already contains a digit. That one
 *  condition is what separates "O4I2 E45 G78" from "beetles", which folds to
 *  8337135 — seven digits, and a false positive that would mask an ordinary
 *  English word. A word carrying no digits is a word. */
const LEET: Record<string, string> = {
  o: "0", O: "0", l: "1", I: "1", i: "1", e: "3", E: "3", a: "4", A: "4",
  s: "5", S: "5", b: "8", B: "8", g: "9", G: "9", t: "7", T: "7",
  z: "2", Z: "2", q: "9", Q: "9",
};

const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);

/** Fold text down to one canonical form, keeping a map back to the original. */
export function fold(input: string): Folded {
  const out: string[] = [];
  const origin: { start: number; end: number }[] = [];

  const push = (s: string, start: number, end: number) => {
    for (const ch of s) {
      out.push(ch);
      origin.push({ start, end });
    }
  };

  // Pass one: characters. Invisibles vanish, foreign digits become digits,
  // everything else is carried across unchanged and lowercased later.
  const chars: { ch: string; start: number; end: number }[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    if (INVISIBLE.has(code)) { i += width - 1; continue; }
    const d = asciiDigit(code);
    chars.push({ ch: d ?? String.fromCodePoint(code), start: i, end: i + width });
    i += width - 1;
  }

  // Pass two: tokens. A token is a run of letters and digits; anything else is
  // punctuation and passes straight through.
  // Tokens are collected first, then folded, because a word that is only a
  // digit in the middle of other digits cannot be judged until its neighbours
  // are known.
  const tokens: { raw: string; start: number; end: number; word: boolean }[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i]!.ch)) {
      // A CJK digit is a word all by itself and never sits inside one.
      const c = chars[i]!;
      tokens.push({ raw: c.ch, start: c.start, end: c.end, word: WORDS[c.ch] !== undefined });
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && isWordChar(chars[j]!.ch)) j++;
    const token = chars.slice(i, j);
    tokens.push({
      raw: token.map((c) => c.ch).join(""),
      start: token[0]!.start,
      end: token[token.length - 1]!.end,
      word: true,
    });
    i = j;
  }

  // Accents are decoration on a number word: "zéro" and "zero" are one digit.
  const plainOf = (raw: string) =>
    raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Which tokens are unambiguously digits, before the ambiguous ones are
  // judged against them.
  const digitAt = tokens.map((t) => {
    if (WORDS[t.raw] !== undefined) return WORDS[t.raw]!;      // CJK, exact
    const w = WORDS[plainOf(t.raw)];
    if (w !== undefined) return w;
    return /^\d+$/.test(t.raw) ? t.raw : null;
  });

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    let value = digitAt[k];

    if (value == null) {
      const amb = AMBIGUOUS[plainOf(t.raw)];
      // Neighbours, skipping the punctuation between words.
      const near = (dir: -1 | 1) => {
        for (let n = k + dir; n >= 0 && n < tokens.length; n += dir) {
          if (/^[A-Za-z0-9\u3007\u4e00-\u9fff]/.test(tokens[n]!.raw)) return digitAt[n];
        }
        return null;
      };
      if (amb !== undefined && near(-1) != null && near(1) != null) value = amb;
    }

    if (value != null) {
      // Every character of the word maps back to the whole word, so masking
      // the digit masks "three" rather than "t".
      push(value, t.start, t.end);
    } else if (/\d/.test(t.raw)) {
      // A token that already carries a digit is one where a letter that looks
      // like a digit probably is one.
      let at = t.start;
      for (const c of t.raw) { push(LEET[c] ?? c, at, at + 1); at++; }
    } else {
      let at = t.start;
      for (const c of t.raw) { push(c, at, at + 1); at++; }
    }
  }

  return { text: out.join(""), origin };
}

/** Translate a span found in the folded text back to the original.
 *
 *  Returns the span of the ORIGINAL that produced those folded characters, so
 *  a caller can cut it out and put a mask in its place. */
export function toOriginal(
  f: Folded, from: number, to: number,
): { start: number; end: number } {
  if (to <= from || !f.origin.length) return { start: 0, end: 0 };
  const first = f.origin[Math.max(0, Math.min(from, f.origin.length - 1))]!;
  const last = f.origin[Math.max(0, Math.min(to - 1, f.origin.length - 1))]!;
  return { start: first.start, end: last.end };
}

/** Replace spans of the ORIGINAL text, given spans found in the FOLD.
 *
 *  Spans are applied right to left so earlier offsets stay valid, and
 *  overlapping spans are merged rather than producing "[removed][removed]". */
export function replaceFolded(
  input: string, f: Folded, spans: { from: number; to: number }[], mask: string,
): string {
  if (!spans.length) return input;
  const real = spans
    .map((s) => toOriginal(f, s.from, s.to))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (!real.length) return input;

  const merged: { start: number; end: number }[] = [real[0]!];
  for (const s of real.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }

  // Invisible characters against the edge of a span belong to it. An emoji
  // keycap is a digit, a variation selector and a combining mark; masking only
  // the digit leaves the decoration behind as a stray glyph.
  const invisibleAt = (at: number) => {
    const c = input.codePointAt(at);
    return c !== undefined && INVISIBLE.has(c);
  };
  let out = input;
  for (const s of merged.reverse()) {
    let { start, end } = s;
    while (start > 0 && invisibleAt(start - 1)) start--;
    while (end < input.length && invisibleAt(end)) end++;
    out = out.slice(0, start) + mask + out.slice(end);
  }
  return out;
}
