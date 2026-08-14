import assert from "node:assert/strict";
import test from "node:test";

import {
  StaticQualityGate,
  assertUsableGateDecision,
  createGateRequest,
  gateRequestHash,
} from "../src/gate.js";

const evidence = {
  kind: "test-plan",
  schema: "hypertest.test-plan/v1",
  uri: "file:///tmp/plan",
  mediaType: "application/json",
  sha256: "a".repeat(64),
} as const;

test("allow receipt binds request and evidence", async () => {
  const request = createGateRequest({
    requestId: "request-1",
    runId: "run-1",
    action: "apply_patch",
    sourceRevision: "revision",
    evidence: [evidence],
  });
  const decision = await new StaticQualityGate("allow").decide(request);
  assert.equal(decision.requestHash, gateRequestHash(request));
  assert.doesNotThrow(() => assertUsableGateDecision(decision, request, 100));
  assert.throws(
    () =>
      assertUsableGateDecision(
        { ...decision, evidenceHashes: [] },
        request,
        100,
      ),
    /does not bind all current evidence/,
  );
});

test("denial and expiry fail closed", async () => {
  const request = createGateRequest({
    requestId: "request-2",
    runId: "run-1",
    action: "publish_change",
    sourceRevision: "revision",
    evidence: [evidence],
  });
  const denied = await new StaticQualityGate("deny").decide(request);
  assert.throws(() => assertUsableGateDecision(denied, request, 100), /did not authorize/);
  const allowed = await new StaticQualityGate("allow").decide(request);
  assert.throws(
    () => assertUsableGateDecision({ ...allowed, expiresAtEpochMs: 100 }, request, 100),
    /expired/,
  );
});
