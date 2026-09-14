// The .env loader. Both of these cost a live deploy: ten keys reported
// UNDECRYPTABLE while the correct secret was visibly sitting in the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/env.js";

const withEnv = (body, keys) => {
  const dir = mkdtempSync(join(tmpdir(), "envtest-"));
  writeFileSync(join(dir, ".env"), body);
  for (const k of keys) delete process.env[k];
  loadEnvFile(dir);
  const out = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  return out;
};

test("the first of a duplicated key wins, as it always has", () => {
  // This is the shape that broke the deploy:
  //   echo 'PPT_KEY_SECRET=<paste it>' >> .env   then corrected in an editor,
  // which leaves the placeholder ABOVE the real value.
  const r = withEnv("PPT_KEY_SECRET=<paste it>\nPPT_KEY_SECRET=the-real-one\n", ["PPT_KEY_SECRET"]);
  assert.equal(r.PPT_KEY_SECRET, "<paste it>", "precedence must not change silently");
});

test("trailing whitespace is not part of a secret", () => {
  // scryptSync takes the secret verbatim, so one trailing space is the
  // difference between decrypting ten keys and none, with nothing to see.
  const r = withEnv("PPT_KEY_SECRET=abc123   \n", ["PPT_KEY_SECRET"]);
  assert.equal(r.PPT_KEY_SECRET, "abc123");
});

test("a quoted value arrives unquoted", () => {
  const r = withEnv(`A="one two"\nB='three'\nC=un"quoted\n`, ["A", "B", "C"]);
  assert.equal(r.A, "one two");
  assert.equal(r.B, "three");
  assert.equal(r.C, 'un"quoted', "a quote in the middle is just a character");
});

test("comments and blank lines are not variables", () => {
  const r = withEnv("# PPT_KEY_SECRET=commented-out\n\nREAL=yes\n", ["PPT_KEY_SECRET", "REAL"]);
  assert.equal(r.PPT_KEY_SECRET, undefined);
  assert.equal(r.REAL, "yes");
});

test("an already-set variable beats the file", () => {
  process.env.FROM_SHELL = "shell";
  const dir = mkdtempSync(join(tmpdir(), "envtest-"));
  writeFileSync(join(dir, ".env"), "FROM_SHELL=file\n");
  loadEnvFile(dir);
  assert.equal(process.env.FROM_SHELL, "shell");
  delete process.env.FROM_SHELL;
});

test("an empty value in the environment does not beat the file", () => {
  // The one that broke Didit on the box. A process manager remembering
  // `DIDIT_API_KEY=` injects an empty string, which is `!== undefined`, so the
  // real key three lines down in .env was never applied — and `Boolean("")`
  // is false, so the feature reported the key as not set while it was
  // visibly in the file.
  const dir = mkdtempSync(join(tmpdir(), "envtest-"));
  writeFileSync(join(dir, ".env"), "DIDIT_API_KEY=the-real-key\n");
  process.env.DIDIT_API_KEY = "";
  loadEnvFile(dir);
  const got = process.env.DIDIT_API_KEY;
  delete process.env.DIDIT_API_KEY;
  assert.equal(got, "the-real-key");
});

test("a missing .env is announced, not swallowed", () => {
  // A server that boots with no configuration and says nothing is a server
  // that reports every key as unset an hour later, in a feature, to a user.
  const dir = mkdtempSync(join(tmpdir(), "envtest-empty-"));
  const said = [];
  const warn = console.warn;
  console.warn = (m) => said.push(String(m));
  try {
    loadEnvFile(dir);
  } finally {
    console.warn = warn;
  }
  assert.equal(said.length, 1, "exactly one warning");
  assert.match(said[0], /no \.env/);
  assert.ok(said[0].includes(dir), "it has to name the path it looked in");
});
