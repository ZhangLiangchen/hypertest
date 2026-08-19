export const terminalRunStates = [
  "completed",
  "needs_human",
  "rejected",
  "failed",
] as const;

export type TerminalRunState = (typeof terminalRunStates)[number];

export type RunState =
  | "intake"
  | "acquire_evidence"
  | "analyze"
  | "plan"
  | "pre_code_gate"
  | "render"
  | "validate_patch"
  | "execute"
  | "diagnose"
  | "repair_gate"
  | "repair"
  | "verify"
  | "publish_gate"
  | "publish"
  | TerminalRunState;

export type RunEvent =
  | "accepted"
  | "evidence_ready"
  | "analysis_ready"
  | "plan_ready"
  | "allowed"
  | "denied"
  | "human_required"
  | "patch_rendered"
  | "patch_valid"
  | "tests_passed"
  | "tests_failed"
  | "safe_repair"
  | "unsafe_or_unknown"
  | "repair_applied"
  | "verification_passed"
  | "published"
  | "fatal_error";

const transitions: Readonly<
  Partial<Record<RunState, Readonly<Partial<Record<RunEvent, RunState>>>>>
> = {
  intake: { accepted: "acquire_evidence", fatal_error: "failed" },
  acquire_evidence: { evidence_ready: "analyze", fatal_error: "failed" },
  analyze: { analysis_ready: "plan", fatal_error: "failed" },
  plan: { plan_ready: "pre_code_gate", fatal_error: "failed" },
  pre_code_gate: {
    allowed: "render",
    denied: "rejected",
    human_required: "needs_human",
    fatal_error: "failed",
  },
  render: { patch_rendered: "validate_patch", fatal_error: "failed" },
  validate_patch: { patch_valid: "execute", fatal_error: "failed" },
  execute: {
    tests_passed: "verify",
    tests_failed: "diagnose",
    denied: "rejected",
    human_required: "needs_human",
    fatal_error: "failed",
  },
  diagnose: {
    safe_repair: "repair_gate",
    unsafe_or_unknown: "needs_human",
    fatal_error: "failed",
  },
  repair_gate: {
    allowed: "repair",
    denied: "rejected",
    human_required: "needs_human",
    fatal_error: "failed",
  },
  repair: { repair_applied: "execute", fatal_error: "failed" },
  verify: { verification_passed: "publish_gate", fatal_error: "failed" },
  publish_gate: {
    allowed: "publish",
    denied: "rejected",
    human_required: "needs_human",
    fatal_error: "failed",
  },
  publish: { published: "completed", fatal_error: "failed" },
};

export interface RunTransitionRecord {
  readonly from: RunState;
  readonly event: RunEvent;
  readonly to: RunState;
  readonly atEpochMs: number;
  readonly detail?: string;
}

export interface RunLedger {
  readonly schema: "hypertest.run-ledger/v1";
  readonly runId: string;
  readonly state: RunState;
  readonly repairRounds: number;
  readonly transitions: readonly RunTransitionRecord[];
}

export class InvalidRunTransitionError extends Error {
  public constructor(
    public readonly state: RunState,
    public readonly event: RunEvent,
  ) {
    super(`Invalid HyperTest transition: ${state} --${event}--> ?`);
    this.name = "InvalidRunTransitionError";
  }
}

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return (terminalRunStates as readonly string[]).includes(state);
}

export function transitionRun(state: RunState, event: RunEvent): RunState {
  if (isTerminalRunState(state)) {
    throw new InvalidRunTransitionError(state, event);
  }

  const next = transitions[state]?.[event];
  if (next === undefined) {
    throw new InvalidRunTransitionError(state, event);
  }
  return next;
}

export function recordTransition(
  ledger: RunLedger,
  event: RunEvent,
  atEpochMs = Date.now(),
  detail?: string,
): RunLedger {
  const next = transitionRun(ledger.state, event);
  return {
    ...ledger,
    state: next,
    repairRounds:
      ledger.state === "repair" && event === "repair_applied"
        ? ledger.repairRounds + 1
        : ledger.repairRounds,
    transitions: [
      ...ledger.transitions,
      {
        from: ledger.state,
        event,
        to: next,
        atEpochMs,
        ...(detail === undefined ? {} : { detail }),
      },
    ],
  };
}

export function createRunLedger(runId: string): RunLedger {
  return {
    schema: "hypertest.run-ledger/v1",
    runId,
    state: "intake",
    repairRounds: 0,
    transitions: [],
  };
}

export function assertValidRunLedger(ledger: RunLedger): void {
  const invalid = (message: string): never => {
    throw new Error(`Invalid run ledger: ${message}`);
  };
  if (ledger.schema !== "hypertest.run-ledger/v1" || ledger.runId.length === 0) {
    invalid("identity is malformed");
  }
  let state: RunState = "intake";
  let repairRounds = 0;
  let previousAt = -1;
  for (const transition of ledger.transitions) {
    if (
      !Number.isInteger(transition.atEpochMs) ||
      transition.atEpochMs < 0 ||
      transition.atEpochMs < previousAt
    ) {
      invalid("transition timestamps must be non-negative and nondecreasing");
    }
    if (transition.from !== state) {
      invalid("transition source does not match the replayed state");
    }
    const expected: RunState = ((): RunState => {
      try {
        return transitionRun(state, transition.event);
      } catch {
        return invalid("transition event is not valid from its source state");
      }
    })();
    if (transition.to !== expected) {
      invalid("transition destination does not match the state machine");
    }
    if (state === "repair" && transition.event === "repair_applied") {
      repairRounds += 1;
    }
    state = expected;
    previousAt = transition.atEpochMs;
  }
  if (ledger.state !== state) invalid("final state does not match transition replay");
  if (ledger.repairRounds !== repairRounds) {
    invalid("repairRounds does not match transition replay");
  }
}
