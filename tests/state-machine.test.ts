import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidRunTransitionError,
  isTerminalRunState,
  transitionRun,
  type RunState,
} from "../src/state-machine.js";

test("happy path reaches completed through all three BUGate decision points", () => {
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
  for (const event of steps) {
    state = transitionRun(state, event);
  }

  assert.equal(state, "completed");
  assert.equal(isTerminalRunState(state), true);
});

test("a failed test can make one governed repair loop", () => {
  let state: RunState = "execute";
  state = transitionRun(state, "tests_failed");
  state = transitionRun(state, "safe_repair");
  state = transitionRun(state, "allowed");
  state = transitionRun(state, "repair_applied");
  assert.equal(state, "execute");
});

test("BUGate denial is terminal", () => {
  const state = transitionRun("pre_code_gate", "denied");
  assert.equal(state, "rejected");
  assert.throws(
    () => transitionRun(state, "allowed"),
    InvalidRunTransitionError,
  );
});

test("invalid transitions fail closed", () => {
  assert.throws(
    () => transitionRun("intake", "published"),
    InvalidRunTransitionError,
  );
});
