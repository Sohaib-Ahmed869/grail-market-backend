import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_SCHEMA, riskCodesFrom } from "../src/identity/store.js";

// The client's rule, set 31 August: identity documents are never retained on
// the GrailMarket database. Didit's decision payload carries the document
// itself — names, date of birth, document number, image URLs, the face match,
// IP analysis, contact details. The shape below is the real one, read off the
// three decisions that were stored before this was fixed, with every personal
// value replaced by an obvious fake.
const decision = {
  session_id: "s1", status: "Declined", vendor_data: "u_1",
  contact_details: { email: "person@example.com", phone: "+61400000000" },
  id_verifications: [{
    full_name: "JANE CITIZEN", date_of_birth: "1990-01-01", document_number: "12345678",
    front_image: "https://didit.example/front.jpg", portrait_image: "https://didit.example/face.jpg",
    address: "1 Example St", warnings: [
      { risk: "DUPLICATED_IP_ADDRESS", short_description: "Duplicated IP", long_description: "…", additional_data: { ip: "203.0.113.9" } },
      { risk: "DEVICE_EMULATOR_DETECTED", short_description: "Emulator", long_description: "…" },
    ],
  }],
  ip_analyses: [{ ip_address: "203.0.113.9", warnings: [{ risk: "DUPLICATED_IP_ADDRESS" }] }],
  liveness_checks: [{ reference_image: "https://didit.example/selfie.jpg", warnings: [{ risk: "LOW_LIVENESS_SCORE" }] }],
};

test("only Didit's risk codes survive — nothing personal", () => {
  const codes = riskCodesFrom(decision);
  assert.deepEqual(codes, ["DEVICE_EMULATOR_DETECTED", "DUPLICATED_IP_ADDRESS", "LOW_LIVENESS_SCORE"]);
  const kept = JSON.stringify(codes);
  for (const personal of ["JANE", "1990", "12345678", "example", "203.0.113", "+61400000000"]) {
    assert.ok(!kept.includes(personal), `${personal} must not be kept`);
  }
});

test("anything that is not a plain risk code is dropped, not kept verbatim", () => {
  const odd = { warnings: [{ risk: "JANE CITIZEN 1990-01-01" }, { risk: 42 }, { risk: "OK_CODE" }] };
  assert.deepEqual(riskCodesFrom(odd), ["OK_CODE"]);
  assert.deepEqual(riskCodesFrom(null), []);
});

test("the schema no longer creates a column that can hold the decision, and removes the old one", () => {
  assert.ok(!/decision\s+jsonb/i.test(IDENTITY_SCHEMA.split("DO $$")[0]), "identity_events must not be created with a decision column");
  assert.match(IDENTITY_SCHEMA, /DROP COLUMN IF EXISTS decision/i);
});
