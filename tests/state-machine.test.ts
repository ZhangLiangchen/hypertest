import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidRunTransitionError,
  assertValidRunLedger,
  createRunLedger,
  isTerminalRunState,
  recordTransition,
  transitionRun,
  type RunState,
} from "../src/state-machine.js";

test("happy path reaches completed through all three quality gates", () => {
  const steps = [
    "accepted",
    "evidence_ready",
    "analysis_ready",
    "plan_ready",
    "allowed",
    "patch_rendered",
    "patch_valid",
    "tests_passed",
    "verification_passed",
    "allowed",
    "published",
  ] as const;
  let state: RunState = "intake";
  for (const event of steps) state = transitionRun(state, event);
  assert.equal(state, "completed");
  assert.equal(isTerminalRunState(state), true);
});

test("ledger records a governed repair round", () => {
  let ledger = createRunLedger("run-1");
  for (const [index, event] of [
    "accepted",
    "evidence_ready",
    "analysis_ready",
    "plan_ready",
    "allowed",
    "patch_rendered",
    "patch_valid",
    "tests_failed",
    "safe_repair",
    "allowed",
    "repair_applied",
  ].entries()) {
    ledger = recordTransition(
      ledger,
      event as Parameters<typeof recordTransition>[1],
      index + 1,
    );
  }
  assert.equal(ledger.state, "execute");
  assert.equal(ledger.repairRounds, 1);
  assert.equal(ledger.transitions.length, 11);
  assert.doesNotThrow(() => assertValidRunLedger(ledger));
});

test("ledger validation rejects impossible or forged history", () => {
  const base = createRunLedger("forged");
  assert.throws(
    () =>
      assertValidRunLedger({
        ...base,
        state: "completed",
        transitions: [
          {
            from: "intake",
            event: "published",
            to: "completed",
            atEpochMs: 1,
          },
        ],
      }),
    /transition event is not valid/,
  );
  assert.throws(
    () => assertValidRunLedger({ ...base, repairRounds: 1 }),
    /repairRounds does not match/,
  );
});

test("denial and invalid transitions fail closed", () => {
  const state = transitionRun("pre_code_gate", "denied");
  assert.equal(state, "rejected");
  assert.equal(transitionRun("execute", "denied"), "rejected");
  assert.equal(transitionRun("execute", "human_required"), "needs_human");
  assert.throws(() => transitionRun(state, "allowed"), InvalidRunTransitionError);
  assert.throws(() => transitionRun("intake", "published"), InvalidRunTransitionError);
});
