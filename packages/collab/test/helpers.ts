import { HypertestError, type SqlDatabase } from '@hypertest/core';
import {
  DEFAULT_BUDGET,
  DEFAULT_WORK_BUDGET,
  workItemFingerprint,
  type DomainEvent,
  type ExperimentSpec,
  type Finding,
  type OracleChangeProposal,
  type OracleSpec,
  type PlanRevision,
  type QualityDecision,
  type SystemModel,
  type TestArtifact,
  type TestRun,
} from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { testDeps } from '@hypertest/testkit';
import {
  collabMigrations,
  createBlackboard,
  createDecisionRepository,
  createEventStore,
  createInbox,
  createRunRepository,
  createSpecRepository,
  type Blackboard,
  type CollabDeps,
  type DecisionRepository,
  type EventStore,
  type Inbox,
  type NewWorkItem,
  type RunRepository,
  type SpecRepository,
} from '../src/index.ts';

export interface Env {
  db: SqlDatabase;
  deps: CollabDeps & ReturnType<typeof testDeps>;
  events: EventStore;
  board: Blackboard;
  runs: RunRepository;
  specs: SpecRepository;
  decisions: DecisionRepository;
  inbox: Inbox;
  dispose(): Promise<void>;
}

/** One migrated database per test file; tests isolate themselves with distinct run ids. */
export async function openEnv(kind?: 'pglite' | 'postgres'): Promise<Env> {
  const t = await createTestDatabase(kind ? { kind, migrations: collabMigrations } : { migrations: collabMigrations });
  const base = testDeps();
  const deps = { ...base, db: t.db };
  const events = createEventStore(deps);
  return {
    db: t.db,
    deps,
    events,
    board: createBlackboard({ ...deps, events }),
    runs: createRunRepository({ ...deps, events }),
    specs: createSpecRepository({ ...deps, events }),
    decisions: createDecisionRepository({ ...deps, events }),
    inbox: createInbox(deps),
    dispose: t.dispose,
  };
}

/** Asserts a promise rejects with a HypertestError of the given code; returns it for detail checks. */
export async function rejectsWith(p: Promise<unknown>, code: HypertestError['code']): Promise<HypertestError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HypertestError && e.code === code) return e;
    throw new Error(`expected HypertestError(${code}), got ${e instanceof HypertestError ? `HypertestError(${e.code}): ${e.message}` : String(e)}`);
  }
  throw new Error(`expected HypertestError(${code}), but the promise resolved`);
}

export async function count(db: SqlDatabase, sql: string, params: Array<string | number> = []): Promise<number> {
  const r = await db.query<{ n: unknown }>(sql, params);
  return Number(r.rows[0]!.n);
}

export function types(events: DomainEvent<unknown>[]): string[] {
  return events.map((e) => e.eventType);
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: 'checkout returns 500 for empty cart',
    description: 'POST /checkout with an empty cart answers 500 instead of 400',
    severity: 'P1',
    category: 'product_defect',
    status: 'open',
    fingerprint: 'fp-checkout-500',
    ...overrides,
  };
}

export function newWorkItem(runId: string, overrides: Partial<NewWorkItem> = {}): NewWorkItem {
  const objective = overrides.objective ?? 'analyse the checkout failure';
  const role = overrides.role ?? 'rca';
  return {
    runId,
    kind: 'reaction',
    origin: { kind: 'system', reason: 'test' },
    title: 'RCA: checkout 500',
    objective,
    role,
    objectiveIds: [],
    capabilityRequirements: [],
    inputRefs: [],
    evidenceRequirements: [],
    dependsOn: [],
    budget: DEFAULT_WORK_BUDGET,
    priority: 10,
    depth: 1,
    fingerprint: workItemFingerprint({ runId, role, objective, originKey: 'test' }),
    resourceClaims: [],
    ...overrides,
  };
}

export function testRun(runId: string, overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId,
    goal: 'assess whether this change is releasable',
    target: { repoPath: '/repo', commit: 'abc123' },
    status: 'created',
    budget: DEFAULT_BUDGET,
    runtimeManifestId: 'rm_1',
    policyRevision: 'pol_1',
    currentPlanRevision: 0,
    oracleRevisions: {},
    experimentIds: [],
    labels: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function planInput(runId: string, overrides: Partial<PlanRevision> = {}): Omit<PlanRevision, 'revision' | 'status' | 'createdAt' | 'validationIssues' | 'decidedAt'> {
  return {
    planId: `plan-${runId}`,
    runId,
    rationale: 'initial decomposition',
    objectives: [{ objectiveId: 'o1', description: 'checkout works', priority: 'P1', riskRefs: [], acceptanceCriteria: ['200 on valid cart'], status: 'open' }],
    workItems: [{ localId: 'a', title: 'analyse diff', objective: 'analyse diff', role: 'code_change_analyst', dependsOn: [], objectiveIds: ['o1'] }],
    cancelWorkItems: [],
    assumptions: [],
    readyForGate: false,
    createdFromSnapshot: 'cs_1',
    proposedBy: 'agent-lead',
    ...overrides,
  };
}

export function systemModel(runId: string, overrides: Partial<SystemModel> = {}): Omit<SystemModel, 'revision' | 'createdAt' | 'supersedes'> {
  return {
    systemModelId: `sm-${runId}`,
    runId,
    subject: { repoRefs: ['repo'], commitDigests: ['abc123'], buildDigests: [] },
    components: [{ componentId: 'checkout', name: 'checkout', kind: 'service', paths: ['src/checkout'], riskTags: [] }],
    interfaces: [],
    dependencies: [],
    stateMachines: [],
    invariants: [],
    changedComponents: ['checkout'],
    riskTags: ['payments'],
    sources: [],
    createdBy: 'agent-arch',
    ...overrides,
  };
}

export function oracle(oracleId: string, overrides: Partial<OracleSpec> = {}): Omit<OracleSpec, 'revision' | 'createdAt' | 'supersedes'> & { revision?: number } {
  return {
    oracleId,
    scope: { components: ['checkout'], description: 'checkout contract' },
    assertions: [{ assertionId: 'a1', description: 'empty cart ⇒ 400', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'POST', path: '/checkout', expectStatus: 400 } }],
    authorities: [{ sourceRef: 'REQ-12', authority: 'approved_requirement' }],
    judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
    changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human', 'independent_agent'] },
    status: 'approved',
    approvedBy: [{ kind: 'human', id: 'alice' }],
    ...overrides,
  };
}

export function proposal(runId: string, overrides: Partial<OracleChangeProposal> = {}): OracleChangeProposal {
  return {
    proposalId: `prop-${runId}`,
    runId,
    oracleId: `or-${runId}`,
    fromRevision: 1,
    proposedAssertions: [{ assertionId: 'a1', description: 'empty cart ⇒ 422', kind: 'requirement', severity: 'P1' }],
    rationale: 'the API returns 422 now',
    proposedBy: { kind: 'agent', id: 'agent-exec', role: 'executor', modelProvider: 'openai' },
    relatedEvidenceRefs: ['ev_1'],
    wouldFlipRecordedFailure: true,
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function experiment(runId: string, overrides: Partial<ExperimentSpec> = {}): Omit<ExperimentSpec, 'revision' | 'createdAt' | 'supersedes'> {
  return {
    experimentId: `exp-${runId}`,
    runId,
    oracleRefs: [{ oracleId: 'or-1', revision: 1 }],
    hypothesis: 'checkout rejects empty carts',
    subjects: [{ role: 'candidate', buildDigest: 'sha256:b' }],
    environment: { environmentId: 'env-1', environmentClass: 'local', generation: 1 },
    fixtures: [],
    faultPlan: [],
    randomSeeds: ['42'],
    isolation: { mode: 'shared_readonly', resourceClaims: [] },
    evidenceRequirements: [],
    stopConditions: [],
    contaminationRules: [],
    createdBy: 'agent-designer',
    ...overrides,
  };
}

export function testArtifact(runId: string, overrides: Partial<TestArtifact> = {}): Omit<TestArtifact, 'revision' | 'createdAt'> & { revision?: number } {
  return {
    artifactId: `ta-${runId}`,
    runId,
    path: 'test/checkout.test.ts',
    artifactDigest: 'sha256:t1',
    sourceType: 'generated',
    oracleRefs: [{ oracleId: 'or-1', revision: 1, assertionIds: ['a1'] }],
    runner: { framework: 'node_test', selector: 'test/checkout.test.ts' },
    validations: {},
    approvalState: 'draft',
    ...overrides,
  };
}

export function decision(runId: string, decisionId: string, overrides: Partial<QualityDecision> = {}): QualityDecision {
  return {
    decisionId,
    runId,
    revision: 1,
    gateId: 'release',
    scope: { description: 'release gate', objectiveIds: ['o1'] },
    verdict: 'fail',
    requiresHumanReview: false,
    oracleRevisions: { 'or-1': 1 },
    experimentRevisions: {},
    evidenceRootHash: 'root-1',
    evidenceCount: 3,
    satisfiedCriteria: [],
    violatedCriteria: [],
    unknownCriteria: [],
    unresolvedFindings: [],
    unresolvedRisks: [],
    exceptions: [],
    reviewerDecisions: [],
    reasons: ['P1 finding open'],
    runtimeManifestId: 'rm_1',
    policyRevision: 'pol_1',
    decidedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
