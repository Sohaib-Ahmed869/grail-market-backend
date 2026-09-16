// An unsure answer from the vision LLM is dropped — unless it is the only
// answer there is going to be. With VISION_URL=off there is no OCR, no picture
// match and no catalogue lookup to check a name against, so "Mega Slowbro ex,
// confident: false" is the whole result. It is kept, and stays unconfirmed and
// unpriced like every other llm identification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identifyWithGemini } from "../src/scans/gemini.js";

const reply = (payload) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
});

function withStub(payload, run) {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async () => reply(payload);
  return (async () => {
    try {
      return await run();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
    }
  })();
}

const unsure = { name: "Mega Slowbro ex", game: "pokemon", number: "031/084", confident: false };

test("an unsure answer is dropped by default", async () => {
  const got = await withStub(unsure, () => identifyWithGemini("aGk="));
  assert.equal(got, null);
});

test("an unsure answer is kept when it is the only answer available", async () => {
  const got = await withStub(unsure, () => identifyWithGemini("aGk=", "image/jpeg", { allowUnsure: true }));
  assert.equal(got?.name, "Mega Slowbro ex");
  assert.equal(got?.game, "pokemon");
  assert.equal(got?.number, "031/084");
  // the caller has to be able to tell the two apart
  assert.equal(got?.confident, false);
});

test("a confident answer says so", async () => {
  const got = await withStub({ ...unsure, confident: true }, () => identifyWithGemini("aGk="));
  assert.equal(got?.confident, true);
});

test("allowUnsure does not rescue an answer with no name", async () => {
  const got = await withStub({ name: "", game: "pokemon", confident: false }, () =>
    identifyWithGemini("aGk=", "image/jpeg", { allowUnsure: true }),
  );
  assert.equal(got, null);
});
