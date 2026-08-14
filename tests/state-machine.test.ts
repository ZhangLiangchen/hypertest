import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidRunTransitionError,
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
  let ledger: import("../src/state-machine.js").RunLedger = {
    ...createRunLedger("run-1"),
    state: "execute",
  };
  ledger = recordTransition(ledger, "tests_failed", 1);
  ledger = recordTransition(ledger, "safe_repair", 2);
  ledger = recordTransition(ledger, "allowed", 3);
  ledger = recordTransition(ledger, "repair_applied", 4);
  assert.equal(ledger.state, "execute");
  assert.equal(ledger.repairRounds, 1);
  assert.equal(ledger.transitions.length, 4);
});

test("denial and invalid transitions fail closed", () => {
  const state = transitionRun("pre_code_gate", "denied");
  assert.equal(state, "rejected");
  assert.throws(() => transitionRun(state, "allowed"), InvalidRunTransitionError);
  assert.throws(() => transitionRun("intake", "published"), InvalidRunTransitionError);
});
