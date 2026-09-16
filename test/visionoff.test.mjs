// VISION_URL=off runs the API with no vision service: no OCR, no DINOv2, no
// picture matching. A scan must still come out the other end — named by Gemini
// from the raw photo — and nothing may try to reach a service that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VisionAnalyzeResponse } from "@grailcard/shared";
import { blankAnalysis, normaliseVisionUrl, visionDisabled } from "../src/scans/visionurl.js";
import { recognizeCard } from "../src/scans/imagematch.js";

test("off, none, false, 0 and disabled all switch the vision service off", () => {
  for (const v of ["off", "OFF", " none ", "false", "0", "disabled"]) {
    assert.equal(visionDisabled(v), true, v);
  }
});

test("unset or a real URL leaves the vision service on", () => {
  for (const v of [undefined, "", "http://localhost:8100", "vision.example.com"]) {
    assert.equal(visionDisabled(v), false, String(v));
  }
});

test("'off' is not mistaken for a host with no domain", () => {
  const warn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    normaliseVisionUrl("off");
  } finally {
    console.warn = warn;
  }
  assert.equal(warned, false);
});

test("the blank analysis is a valid response that still enters identification", () => {
  const res = VisionAnalyzeResponse.parse(blankAnalysis());
  assert.equal(res.ok, true);
  // runScan only identifies when `ocr` is present; without it Gemini is never asked
  assert.ok(res.ocr);
  assert.deepEqual(res.ocr.nameCandidates, []);
  assert.equal(res.warpedImageB64 ?? null, null);
});

test("recognizeCard asks nothing when vision is off", async () => {
  const prevUrl = process.env.VISION_URL;
  const prevFetch = globalThis.fetch;
  process.env.VISION_URL = "off";
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("no service"); };
  try {
    assert.equal(await recognizeCard("aGVsbG8="), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.VISION_URL;
    else process.env.VISION_URL = prevUrl;
  }
});
