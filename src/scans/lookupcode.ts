// Parsing what somebody types into the code box.
//
// The scan reads a set code off a card because it has to; this is for the
// person holding the card who would rather type six characters than take a
// photograph, and for the one whose card the camera keeps failing on.
//
// Pure, because the whole difficulty is the shapes people actually write:
// "SV3a 205/108", "sv3a-205", "#205", "205/108", "PSA 12345678". Every one of
// those is the same request and none of them is the format the catalogue uses.

export type Parsed =
  | { kind: "cert"; grader: string; cert: string }
  | { kind: "code"; code: string; number: string; printedNumber: string | null }
  | { kind: "number"; number: string; printedNumber: string | null }
  | { kind: "text"; text: string };

const GRADERS = ["PSA", "BGS", "CGC", "SGC", "ACE", "AGS", "TAG", "BECKETT"];

/** Long enough to be a certificate, short enough to still be one.
 *
 *  Grading certs run 7–11 digits. Below that it is a collector number with
 *  spaces in it; above, somebody has pasted something else entirely. */
const CERT_DIGITS = /^\d{7,11}$/;

export function parseCode(raw: string): Parsed {
  const input = String(raw ?? "").trim();
  if (!input) return { kind: "text", text: "" };

  // A certificate number, with or without the company in front of it.
  const certWords = input.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const graderAt = certWords.findIndex((w) => GRADERS.includes(w));
  if (graderAt >= 0) {
    const digits = certWords.slice(graderAt + 1).join("").replace(/\D/g, "");
    if (CERT_DIGITS.test(digits)) {
      const named = certWords[graderAt]!;
      return { kind: "cert", grader: named === "BECKETT" ? "BGS" : named, cert: digits };
    }
  }
  // Bare digits of certificate length. Unknown company: the caller offers the
  // links rather than guessing, because a PSA URL with a BGS number in it is
  // a confident wrong answer.
  const bare = input.replace(/[^0-9]/g, "");
  if (CERT_DIGITS.test(bare) && !/\//.test(input)) {
    return { kind: "cert", grader: "", cert: bare };
  }

  // A set code and a number: "SV3a 205/108", "sv3a-205", "SWSH12 160".
  const withCode = /^([A-Za-z][A-Za-z0-9]{1,7})[\s\-_]*#?\s*(\d{1,4})(?:\s*\/\s*(\d{1,4}))?$/.exec(
    input,
  );
  if (withCode) {
    const [, code, number, of] = withCode;
    return {
      kind: "code",
      code: code!.toLowerCase(),
      number: String(Number(number)),
      printedNumber: of ? `${number}/${of}` : null,
    };
  }

  // A number on its own: "205/108", "#205", "4".
  const numOnly = /^#?\s*(\d{1,4})(?:\s*\/\s*(\d{1,4}))?$/.exec(input);
  if (numOnly) {
    const [, number, of] = numOnly;
    return {
      kind: "number",
      number: String(Number(number)),
      printedNumber: of ? `${number}/${of}` : null,
    };
  }

  // Anything else is a name, and the ordinary search already handles those.
  return { kind: "text", text: input };
}

/** Where to check a certificate. We do not hold grading company data and are
 *  not going to pretend to — this hands over to the company's own register,
 *  which is the only authority on whether a slab is real. */
export function certUrl(grader: string, cert: string): string | null {
  switch (grader.toUpperCase()) {
    case "PSA": return `https://www.psacard.com/cert/${cert}`;
    case "BGS": return `https://www.beckett.com/grading/card-lookup?item_number=${cert}`;
    case "CGC": return `https://www.cgccards.com/certlookup/${cert}/`;
    case "SGC": return `https://gosgc.com/card/${cert}`;
    default: return null;
  }
}

/** Every register worth offering when the company is unknown. */
export const certLinks = (cert: string) =>
  ["PSA", "BGS", "CGC", "SGC"].map((g) => ({ grader: g, url: certUrl(g, cert)! }));
