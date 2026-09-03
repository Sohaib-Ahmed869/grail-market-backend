// The whole difficulty is the shapes people actually type. Every one of these
// is a real form a collector writes, and none is the format the catalogue uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCode, certUrl, certLinks } from "../src/scans/lookupcode.js";

test("a set code and a number, however it is punctuated", () => {
  for (const input of ["SV3a 205/108", "sv3a-205/108", "SV3A_205/108", "sv3a  #205/108"]) {
    const p = parseCode(input);
    assert.equal(p.kind, "code", input);
    assert.equal(p.code, "sv3a", input);
    assert.equal(p.number, "205", input);
    assert.equal(p.printedNumber, "205/108", input);
  }
});

test("a set code with no denominator still resolves", () => {
  const p = parseCode("SWSH12 160");
  assert.deepEqual(p, { kind: "code", code: "swsh12", number: "160", printedNumber: null });
});

test("a bare collector number, with or without the hash", () => {
  assert.deepEqual(parseCode("#4"), { kind: "number", number: "4", printedNumber: null });
  assert.deepEqual(parseCode("4/102"), { kind: "number", number: "4", printedNumber: "4/102" });
  // leading zeros are how the same card is printed on different sets
  assert.equal(parseCode("004/102").number, "4");
});

test("a certificate number is recognised by its length", () => {
  assert.deepEqual(parseCode("PSA 12345678"), { kind: "cert", grader: "PSA", cert: "12345678" });
  assert.deepEqual(parseCode("psa-12345678"), { kind: "cert", grader: "PSA", cert: "12345678" });
  // Beckett is what people write; BGS is what we key on
  assert.equal(parseCode("Beckett 0012345678").grader, "BGS");
});

test("a bare cert-length number does not get a company guessed for it", () => {
  const p = parseCode("12345678");
  assert.equal(p.kind, "cert");
  assert.equal(p.grader, "", "a PSA URL with a BGS number in it is a confident wrong answer");
});

test("a collector number is never mistaken for a certificate", () => {
  // the two shapes sit either side of a gap: collector numbers stop at four
  // digits, certificates start at seven
  assert.equal(parseCode("1234").kind, "number");
  assert.equal(parseCode("1234567").kind, "cert");
  // a slash always means a collector number, even when the digits either side
  // would otherwise total a cert-shaped run
  assert.equal(parseCode("1234/5678").kind, "number");
});

test("a run in the gap between the two shapes is neither, and says so", () => {
  // six digits is too long for a collector number and too short for a cert.
  // Guessing either would be a confident wrong answer, so it goes to search.
  assert.equal(parseCode("205108").kind, "text");
});

test("something that is plainly a name falls through to ordinary search", () => {
  for (const input of ["Charizard", "Base Set Charizard", "リザードン"]) {
    assert.deepEqual(parseCode(input), { kind: "text", text: input });
  }
});

test("empty input is empty, not a crash", () => {
  for (const bad of ["", "   ", null, undefined]) {
    assert.deepEqual(parseCode(bad), { kind: "text", text: "" });
  }
});

test("cert links point at the company's own register, and refuse when unknown", () => {
  assert.match(certUrl("PSA", "123"), /psacard\.com\/cert\/123/);
  assert.match(certUrl("cgc", "123"), /cgccards\.com/);
  assert.equal(certUrl("NOBODY", "123"), null, "never invent a register");
  assert.equal(certLinks("123").length, 4);
  assert.ok(certLinks("123").every((l) => l.url.includes("123")));
});
