import assert from "node:assert/strict";
import test from "node:test";

import { assertUsableGateDecision, type GateDecision } from "../src/gate.js";

function decision(overrides: Partial<GateDecision> = {}): GateDecision {
  return {
    schema: "hypertest.gate-decision/v1",
    verdict: "allow",
    receiptId: "receipt-1",
    reasonCodes: [],
    obligations: [],
    evidenceHashes: [],
    ...overrides,
  };
}

test("accepts a current BUGate allow receipt", () => {
  assert.doesNotThrow(() => assertUsableGateDecision(decision(), 100));
});

test("fails closed for denial, human review, expiry, and missing receipt id", () => {
  for (const verdict of ["deny", "needs_human"] as const) {
    assert.throws(
      () => assertUsableGateDecision(decision({ verdict }), 100),
      /did not authorize/,
    );
  }
  assert.throws(
    () => assertUsableGateDecision(decision({ expiresAtEpochMs: 100 }), 100),
    /expired/,
  );
  assert.throws(
    () => assertUsableGateDecision(decision({ receiptId: "" }), 100),
    /missing an id/,
  );
});
