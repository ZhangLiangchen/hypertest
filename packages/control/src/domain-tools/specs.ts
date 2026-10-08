import { readFile } from 'node:fs/promises';
import { canonicalJson, sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import {
  EVENT_TYPES, ORACLE_CHANGE_INPUT_SCHEMA, SYSTEM_MODEL_INPUT_SCHEMA, TEST_ARTIFACT_INPUT_SCHEMA,
  type BudgetEnvelope, type ComponentModel, type ContaminationRule, type DataAssetModel, type DependencyEdge, type EnvironmentRef, type EvidenceRequirement,
  type EventContext, type ExperimentSpec, type FaultSpec, type InterfaceModel, type IsolationPlan, type OracleAssertion, type OracleSpec, type Ref, type ResourceClaim, type Review,
  type RunnerSpec, type SecurityBoundary, type StateMachineModel, type StopCondition, type TestArtifact, type TestArtifactReview, type TestRun, type TestValidation, type WorkloadSpec,
} from '@hypertest/domain';
import {
  artifactCaseStatuses, codeRevisionOf, exclusiveResourcesOf, normalizeTestPath, oracleAuthorityProblems, oracleRefProblems, sensitivityBinding, sameTestFile, type BindingPurpose,
} from '@hypertest/policy';
import type { ToolContext, ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { event } from '../util.ts';
import { runScope } from '../work-factory.ts';
import { Caller, checkEvidence, domainTool, refuse, success } from './common.ts';

interface SystemModelInput {
  components: ComponentModel[];
  interfaces?: InterfaceModel[];
  dependencies?: DependencyEdge[];
  stateMachines?: StateMachineModel[];
  invariants?: string[];
  changedComponents?: string[];
  riskTags?: string[];
  /** (additive, coverage-12) */
  dataAssets?: DataAssetModel[];
  securityBoundaries?: SecurityBoundary[];
  /** (additive, D-8) Provenance of the model: evidence ids, files, commits, URLs it was derived from. */
  sources?: Ref[];
}

interface OracleChangeInput {
  oracleId: string;
  fromRevision: number;
  proposedAssertions: OracleAssertion[];
  rationale: string;
  relatedEvidenceRefs?: string[];
}

/** (additive, D-3) The per-experiment budget accepted by experiment.define (enforced on the experiment's actions). */
export interface ExperimentBudgetInput {
  maxToolCalls?: number;
  maxWallClockMs?: number;
  maxExternalQps?: number;
  maxComputeMinutes?: number;
}

interface ExperimentInput {
  hypothesis: string;
  environmentId?: string;
  workload?: WorkloadSpec;
  faultPlan?: FaultSpec[];
  isolation?: Pick<ExperimentSpec['isolation'], 'mode' | 'resourceClaims'>;
  evidenceRequirements?: EvidenceRequirement[];
  oracleRefs?: Array<{ oracleId: string; revision: number }>;
  /** (additive, conformance-6) Fixture references (datasets, seeds files, accounts pools) the experiment uses. */
  fixtures?: string[];
  /** (additive, conformance-6) Random seeds; one is generated (retry-stable) and recorded when absent. */
  randomSeeds?: string[];
  /** (additive, conformance-6) When the experiment stops; derived from the workload when absent. */
  stopConditions?: StopCondition[];
  /** (additive, conformance-6) Contamination rules; derived from the admitted claims when absent. */
  contaminationRules?: ContaminationRule[];
  /** (additive, D-3) Per-experiment budget. */
  budget?: ExperimentBudgetInput;
}

type Isolation = ExperimentSpec['isolation'];

/** (D-3) The budget scope of an experiment's actions (child of its run's scope). */
export function experimentScope(experimentId: string): string {
  return `experiment:${experimentId}`;
}

/**
 * (conformance-6) The isolation an experiment is admitted with. Without claims, defaults derive from what it does to its
 * environment `env/<environmentId>` (the key black-box tools act on): a fault plan ⇒ fault_exclusive, a workload or an
 * exclusive/dedicated mode ⇒ write_exclusive, else read_shared. Declared claims must cover what the experiment does:
 * a fault plan needs a fault_exclusive claim, a workload a write/fault claim; shared_readonly holds only read_shared
 * claims and runs neither. Never weakened: a problem refuses the definition.
 */
export function experimentIsolation(input: Pick<ExperimentInput, 'isolation' | 'faultPlan' | 'workload'>, environment: EnvironmentRef): { ok: true; isolation: Isolation } | { ok: false; problem: string } {
  const faults = (input.faultPlan ?? []).length > 0;
  const writes = faults || input.workload !== undefined;
  const mode: Isolation['mode'] = input.isolation?.mode ?? (writes ? 'exclusive_write' : 'shared_readonly');
  if (writes && mode === 'shared_readonly') return { ok: false, problem: `isolation mode shared_readonly cannot run a ${faults ? 'fault plan' : 'workload'}; use exclusive_write or dedicated_environment with ${faults ? 'fault_exclusive' : 'write_exclusive'} claims` };
  const declared = input.isolation?.resourceClaims ?? [];
  let claims: ResourceClaim[];
  if (declared.length === 0) {
    claims = [{ resourceKey: `env/${environment.environmentId}`, mode: faults ? 'fault_exclusive' : mode === 'shared_readonly' ? 'read_shared' : 'write_exclusive' }];
  } else {
    if (faults && !declared.some((c) => c.mode === 'fault_exclusive')) return { ok: false, problem: 'a fault plan needs a fault_exclusive resource claim on the resources the faults hit' };
    if (writes && !declared.some((c) => c.mode !== 'read_shared')) return { ok: false, problem: 'a workload needs a write_exclusive (or fault_exclusive) resource claim on the resources it loads' };
    if (mode === 'shared_readonly' && declared.some((c) => c.mode !== 'read_shared')) return { ok: false, problem: 'isolation mode shared_readonly can only hold read_shared claims' };
    const seen = new Set<string>();
    claims = [];
    for (const c of declared) {
      const k = `${c.resourceKey}\u0000${c.mode}\u0000${c.quantity ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      claims.push(c.quantity === undefined ? { resourceKey: c.resourceKey, mode: c.mode } : { resourceKey: c.resourceKey, mode: c.mode, quantity: c.quantity });
    }
  }
  if (mode === 'dedicated_environment' && !claims.some((c) => c.resourceKey === `env/${environment.environmentId}` && c.mode !== 'read_shared')) {
    // a dedicated environment is held exclusively as a whole
    claims.push({ resourceKey: `env/${environment.environmentId}`, mode: faults ? 'fault_exclusive' : 'write_exclusive' });
  }
  return { ok: true, isolation: { mode, resourceClaims: claims } };
}

/** (conformance-6) Stop conditions when none are given: the workload's duration; a manual stop for open-ended load or faults. */
export function defaultStopConditions(input: Pick<ExperimentInput, 'workload' | 'faultPlan'>): StopCondition[] {
  if (input.workload?.durationMs !== undefined) return [{ kind: 'duration', value: input.workload.durationMs }];
  if (input.workload !== undefined || (input.faultPlan ?? []).length > 0) return [{ kind: 'manual' }];
  return [];
}

/** (conformance-6) Contamination rules when none are given: the admitted claims, enforced by admission while held. */
export function defaultContaminationRules(isolation: Isolation): ContaminationRule[] {
  const keys = [...new Set(isolation.resourceClaims.map((c) => c.resourceKey))].sort();
  if (keys.length === 0) return [];
  const exclusive = isolation.resourceClaims.some((c) => c.mode !== 'read_shared');
  return [{
    description: exclusive
      ? `admission-enforced: while this experiment holds its claims, no other experiment or work item may use ${keys.join(', ')}`
      : `admission-enforced: while this experiment holds its claims, no other experiment or work item may write to, load or inject faults into ${keys.join(', ')}`,
    exclusiveResources: keys,
  }];
}

function keyCovers(claimKey: string, resourceKey: string): boolean {
  return resourceKey === claimKey || resourceKey.startsWith(`${claimKey}/`);
}

/**
 * (D-3) Contamination rules beyond the defaults are ENFORCED: every resource a rule declares exclusive becomes a claim of
 * the experiment, admitted atomically with the others — so no other experiment or work item can write to it while the
 * experiment holds it (admission + dispatcher), and the gate's contamination check (C10) covers it. A writing experiment
 * holds it `write_exclusive` (unless a write/fault claim already covers it); a `shared_readonly` experiment holds it
 * `read_shared` (which already excludes every writer, and never lets the read-only experiment host writes itself).
 */
export function claimsWithRules(claims: ResourceClaim[], rules: ContaminationRule[], mode: Isolation['mode'] = 'exclusive_write'): ResourceClaim[] {
  const out = [...claims];
  const readOnly = mode === 'shared_readonly';
  for (const r of rules) {
    for (const key of r.exclusiveResources) {
      if (out.some((c) => (readOnly || c.mode !== 'read_shared') && keyCovers(c.resourceKey, key))) continue;
      out.push({ resourceKey: key, mode: readOnly ? 'read_shared' : 'write_exclusive' });
    }
  }
  return out;
}

interface RegisterInput {
  path: string;
  sourceType: TestArtifact['sourceType'];
  runner: RunnerSpec;
  oracleRefs: TestArtifact['oracleRefs'];
  experimentId?: string;
  supersedesArtifactId?: string;
}

interface ValidateInput {
  artifactId: string;
  knownGoodEvidenceId?: string;
  knownBadEvidenceId?: string;
  mutationEvidenceId?: string;
  /** (additive, D-1) Why no known-good revision can exist (keeps the artifact out of P0/P1 support). */
  knownGoodUnavailableReason?: string;
}

const EVIDENCE_REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceType', 'minCount'],
  properties: { evidenceType: { type: 'string', minLength: 1 }, minCount: { type: 'integer', minimum: 1 }, description: { type: 'string' }, critical: { type: 'boolean' } },
} as const;

const STOP_CONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: { kind: { type: 'string', enum: ['duration', 'error_rate_above', 'metric_threshold', 'manual'] }, value: { type: 'number' }, metric: { type: 'string', minLength: 1 } },
} as const;

const CONTAMINATION_RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'exclusiveResources'],
  properties: { description: { type: 'string', minLength: 1 }, exclusiveResources: { type: 'array', items: { type: 'string', minLength: 1 } } },
} as const;

const RESOURCE_CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resourceKey', 'mode'],
  properties: { resourceKey: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['read_shared', 'write_exclusive', 'fault_exclusive'] }, quantity: { type: 'integer', minimum: 1 } },
} as const;

const EXPERIMENT_BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxToolCalls: { type: 'integer', minimum: 1 },
    maxWallClockMs: { type: 'integer', minimum: 1000 },
    maxExternalQps: { type: 'number', exclusiveMinimum: 0 },
    maxComputeMinutes: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

function field(structured: JsonValue | undefined, key: string): JsonValue | undefined {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return undefined;
  return (structured as Record<string, JsonValue>)[key];
}

/** What experiment.define returns (also for a replayed call). */
function experimentSummary(e: ExperimentSpec): Record<string, unknown> {
  return {
    experimentId: e.experimentId, revision: e.revision, environment: e.environment, isolation: e.isolation, fixtures: e.fixtures, randomSeeds: e.randomSeeds,
    stopConditions: e.stopConditions, contaminationRules: e.contaminationRules, budget: e.budget,
  };
}

/** An id derived from the tool invocation: a replayed call (crash before the call settled) addresses the same object. */
function retryStableId(prefix: string, runId: string, invocationId: string): string {
  return `${prefix}_${sha256Hex(`${runId}\u0000${invocationId}`).slice(0, 26)}`;
}

/** (D-1) Deterministic event id of the oracle consistency review request of one artifact revision. */
export function artifactReviewRequestEventId(artifactId: string, revision: number): string {
  return `evt_review_ta_${sha256Hex(`review.requested\u0000${artifactId}\u0000${revision}`).slice(0, 32)}`;
}

/** (D-3) Deterministic event id of an experiment's stop (one per experiment). */
export function experimentStopEventId(experimentId: string): string {
  return `evt_expstop_${sha256Hex(`experiment.stopped\u0000${experimentId}`).slice(0, 32)}`;
}

/**
 * (D-7/D-10) The oracle revisions in force for a run: each pinned revision that is approved, governed (authorities and
 * approvals as the design requires), still the latest approved revision and not declared invalid since.
 */
export async function oraclesInForce(deps: Pick<ControlDeps, 'specs'>, run: Pick<TestRun, 'oracleRevisions'>): Promise<OracleSpec[]> {
  const out: OracleSpec[] = [];
  for (const [oracleId, revision] of Object.entries(run.oracleRevisions ?? {})) {
    const o = await deps.specs.getOracle(oracleId, revision);
    if (!o || o.status !== 'approved' || oracleAuthorityProblems(o).length > 0) continue;
    const latest = await deps.specs.getOracle(oracleId);
    if (latest && latest.revision > revision && (latest.status === 'approved' || latest.status === 'invalid')) continue;
    out.push(o);
  }
  return out;
}

/** The lifecycle stage a validation reached (for responses). */
function stageOf(v: { status?: string } | undefined): string {
  return v?.status ?? 'missing';
}

export function specTools(deps: ControlDeps): ToolSpec[] {
  const { specs, runs, oracles, environments, workspaces, admission, events } = deps;

  return [
    domainTool<SystemModelInput>({
      id: 'system_model.record',
      title: 'Record the system model',
      description:
        'Record (a new revision of) the run\'s SystemModel: components with their observed paths, interfaces, dependencies, state machines, invariants, data assets (databases, tables, queues, buckets, secrets …), security boundaries (network, authentication, authorization, tenant …), changed components, risk tags and the sources it was derived from (evidence ids, files, commits). Build digests come from the run\'s registered environment. A run needs a system model before its verdict (gate C12). The system model informs planning; it is never an oracle.',
      inputSchema: SYSTEM_MODEL_INPUT_SCHEMA,
      area: 'system_model',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const run = await caller.run();
        const target = run.target;
        const componentIds = new Set(input.components.map((c) => c.componentId));
        const unknownComponents = [
          ...(input.dataAssets ?? []).flatMap((a) => (a.componentId !== undefined && !componentIds.has(a.componentId) ? [`data asset ${a.assetId} names unknown component ${a.componentId}`] : [])),
          ...(input.securityBoundaries ?? []).flatMap((b) => b.components.filter((c) => !componentIds.has(c)).map((c) => `security boundary ${b.boundaryId} names unknown component ${c}`)),
        ];
        if (unknownComponents.length > 0) return refuse('invalid_argument', `system model refused: ${unknownComponents.join('; ')} (declare the component first)`);
        const sources = [...new Map((input.sources ?? []).map((s) => [`${s.kind}:${s.id}`, s])).values()];
        const cited = sources.filter((s) => s.kind === 'evidence').map((s) => s.id);
        const ev = await checkEvidence(deps, ctx.runId, cited);
        if (!ev.ok) return refuse('unknown_evidence', `system model refused: ${ev.problems.join('; ')}`);
        // D-9: the builds the model describes — the registered environment's build digest (authoritative registry read)
        const buildDigests: string[] = [];
        if (target.environmentId !== undefined) {
          const env = (environments.load ? await environments.load(target.environmentId) : undefined) ?? environments.get(target.environmentId);
          if (env?.buildDigest !== undefined) buildDigests.push(env.buildDigest);
        }
        const model = await specs.saveSystemModel(
          {
            systemModelId: `sm_${run.runId}`,
            runId: run.runId,
            subject: { repoRefs: target.repoPath ? [target.repoPath] : [], commitDigests: target.commit ? [target.commit] : [], buildDigests },
            components: input.components.map((c) => ({ ...c, riskTags: c.riskTags ?? [] })),
            interfaces: input.interfaces ?? [],
            dependencies: input.dependencies ?? [],
            stateMachines: input.stateMachines ?? [],
            invariants: input.invariants ?? [],
            dataAssets: input.dataAssets ?? [],
            securityBoundaries: input.securityBoundaries ?? [],
            changedComponents: input.changedComponents ?? [],
            riskTags: input.riskTags ?? [],
            sources,
            createdBy: ctx.agentId,
          },
          ctx.eventContext,
        );
        await runs.update(run.runId, { systemModelRevision: model.revision }, ctx.eventContext);
        return success({ systemModelId: model.systemModelId, revision: model.revision, buildDigests: model.subject.buildDigests, sources: model.sources.length });
      },
    }),

    domainTool<{ oracleId: string; revision?: number }>({
      id: 'oracle.get',
      title: 'Get an oracle',
      description: 'Read an oracle (correctness criteria): by default the revision pinned by this run, else the latest. Oracles are governed; you may only propose changes.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['oracleId'], properties: { oracleId: { type: 'string', minLength: 1 }, revision: { type: 'integer', minimum: 1 } } },
      effect: 'read',
      area: 'oracles',
      async execute(input, ctx) {
        const run = await new Caller(deps, ctx).run();
        const revision = input.revision ?? run.oracleRevisions[input.oracleId];
        const oracle = await specs.getOracle(input.oracleId, revision);
        if (!oracle) return refuse('not_found', `oracle ${input.oracleId}${revision !== undefined ? ` revision ${revision}` : ''} does not exist`);
        return success({ oracle, pinnedByRun: run.oracleRevisions[input.oracleId] === oracle.revision });
      },
    }),

    domainTool<Record<string, never>>({
      id: 'oracle.list',
      title: 'List oracles',
      description: 'List the oracles pinned by this run (with their pinned revision) and other approved oracles.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      effect: 'read',
      area: 'oracles',
      async execute(_input, ctx) {
        const run = await new Caller(deps, ctx).run();
        const pinned = [];
        for (const [oracleId, revision] of Object.entries(run.oracleRevisions)) {
          const o = await specs.getOracle(oracleId, revision);
          if (o) pinned.push({ oracleId, revision, status: o.status, scope: o.scope, assertions: o.assertions.map((a) => ({ assertionId: a.assertionId, severity: a.severity, kind: a.kind, description: a.description })) });
        }
        const others = (await specs.listOracles({ status: ['approved'] })).filter((o) => !Object.hasOwn(run.oracleRevisions, o.oracleId)).map((o) => ({ oracleId: o.oracleId, revision: o.revision, scope: o.scope }));
        return success({ pinned, otherApproved: others });
      },
    }),

    domainTool<OracleChangeInput>({
      id: 'oracle.propose_change',
      title: 'Propose an oracle change',
      description: 'Propose a governed change of an oracle (the complete proposed assertions, rationale, related evidence). You can never approve your own proposal; an independent approver decides.',
      inputSchema: ORACLE_CHANGE_INPUT_SCHEMA,
      area: 'oracles',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const related = [...new Set(input.relatedEvidenceRefs ?? [])];
        const ev = await checkEvidence(deps, ctx.runId, related);
        if (!ev.ok) return refuse('unknown_evidence', `oracle change refused: ${ev.problems.join('; ')}`);
        const epoch = await caller.epoch();
        const proposedBy: { kind: 'agent'; id: string; role: string; modelProvider?: string } = { kind: 'agent', id: ctx.agentId, role: ctx.role };
        if (epoch.provider !== undefined) proposedBy.modelProvider = epoch.provider;
        const proposal = await oracles.propose(
          { runId: ctx.runId, oracleId: input.oracleId, fromRevision: input.fromRevision, proposedAssertions: input.proposedAssertions, rationale: input.rationale, relatedEvidenceRefs: related },
          proposedBy,
          ctx.eventContext,
        );
        return success({ proposalId: proposal.proposalId, status: proposal.status, wouldFlipRecordedFailure: proposal.wouldFlipRecordedFailure });
      },
    }),

    domainTool<ExperimentInput>({
      id: 'experiment.define',
      title: 'Define an experiment',
      description:
        'Define an ExperimentSpec (hypothesis, environment, workload, fault plan, isolation with resource claims, fixtures, random seeds, stop conditions, contamination rules, evidence requirements, oracle refs, budget) BEFORE any write to an environment, load or fault run — such calls are refused for a work item that runs for no active experiment. Subjects, environment generation and build digest come from the run and its registered environment. The isolation claims (plus every resource a contamination rule declares exclusive) are ADMITTED atomically for the experiment (default: env/<environmentId> — fault_exclusive for a fault plan, write_exclusive for a workload, else read_shared): if another experiment or work item holds conflicting claims the experiment is NOT created and the conflicting holders are returned. Isolation mode dedicated_environment requires an environment registered as dedicated. Work items that declare the experiment (inputRefs kind experiment) may run write/fault/load tools only while its claims are held, only on environments/URLs the claims cover, only faults of its fault plan and load within its workload, until a stop condition is met or its budget (maxToolCalls, maxWallClockMs, maxExternalQps, maxComputeMinutes) is spent. The QualityGate judges its validity (C10).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['hypothesis'],
        properties: {
          hypothesis: { type: 'string', minLength: 1, maxLength: 4000 },
          environmentId: { type: 'string', minLength: 1 },
          workload: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['http_load', 'custom'] }, targetUrl: { type: 'string' }, ratePerSecond: { type: 'number', minimum: 0 },
              durationMs: { type: 'integer', minimum: 1 }, concurrency: { type: 'integer', minimum: 1 }, scenario: { type: 'string' },
            },
          },
          faultPlan: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'target'],
              properties: { kind: { type: 'string', enum: ['process_kill', 'restart', 'latency', 'error_rate', 'partition', 'custom'] }, target: { type: 'string' }, atMs: { type: 'integer', minimum: 0 }, params: { type: 'object' } },
            },
          },
          isolation: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'resourceClaims'],
            properties: { mode: { type: 'string', enum: ['shared_readonly', 'exclusive_write', 'dedicated_environment'] }, resourceClaims: { type: 'array', items: RESOURCE_CLAIM_SCHEMA } },
          },
          evidenceRequirements: { type: 'array', items: EVIDENCE_REQUIREMENT_SCHEMA },
          oracleRefs: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['oracleId', 'revision'], properties: { oracleId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } } },
          },
          fixtures: { type: 'array', items: { type: 'string', minLength: 1 } },
          randomSeeds: { type: 'array', items: { type: 'string', minLength: 1 } },
          stopConditions: { type: 'array', items: STOP_CONDITION_SCHEMA },
          contaminationRules: { type: 'array', items: CONTAMINATION_RULE_SCHEMA },
          budget: EXPERIMENT_BUDGET_SCHEMA,
        },
      } as JsonSchema,
      area: 'experiments',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const run = await caller.run();
        const envId = input.environmentId ?? run.target.environmentId;
        let environment: EnvironmentRef = { environmentId: envId ?? 'local', environmentClass: 'local', generation: 0 };
        let dedication: { dedicated: boolean; namespace?: string; database?: string; account?: string } | undefined;
        if (envId !== undefined) {
          // the authoritative generation (shared SQL registry when present): the experiment records what it runs against
          const env = (environments.load ? await environments.load(envId) : undefined) ?? environments.get(envId);
          if (!env) return refuse('not_found', `environment ${envId} is not registered`);
          environment = { environmentId: env.environmentId, environmentClass: env.environmentClass, generation: env.generation };
          if (env.buildDigest !== undefined) environment.buildDigest = env.buildDigest;
          if (env.control?.target !== undefined) environment.topologyRef = `${env.control.kind}:${env.control.target.split('#')[0]}${env.control.namespace ? `/${env.control.namespace}` : ''}`;
          dedication = env.isolation;
        }
        // coverage-13: a dedicated environment is a registration fact, never an agent's claim
        if (input.isolation?.mode === 'dedicated_environment' && dedication?.dedicated !== true) {
          return refuse('isolation_insufficient', `experiment not created: isolation mode dedicated_environment needs an environment registered as dedicated (environments[].isolation.dedicated: true); ${envId === undefined ? 'no environment is named' : `environment ${envId} is ${dedication ? 'registered as shared' : 'not registered as dedicated'}`} — use exclusive_write with resource claims instead`);
        }
        const oracleRefs = input.oracleRefs ?? Object.entries(run.oracleRevisions).map(([oracleId, revision]) => ({ oracleId, revision }));
        for (const ref of oracleRefs) {
          if (!(await specs.getOracle(ref.oracleId, ref.revision))) return refuse('not_found', `oracle ${ref.oracleId} revision ${ref.revision} does not exist`);
        }
        const subject: ExperimentSpec['subjects'][number] = { role: 'candidate', buildDigest: environment.buildDigest ?? run.target.commit ?? 'unknown' };
        if (run.target.commit !== undefined) subject.commit = run.target.commit;
        // retry-stable id: a replayed call returns the experiment it already defined
        const experimentId = retryStableId('exp', ctx.runId, ctx.invocationId);
        /** `admission.granted` of the experiment, once: a deterministic event id makes the append idempotent (replays). */
        const grantedEvent = async (id: string, granted: ResourceClaim[]): Promise<void> => {
          const eventId = `evt_admgr_${sha256Hex(`admission.granted\u0000${id}`).slice(0, 32)}`;
          await events.append([{ ...event(ctx.eventContext, EVENT_TYPES.admissionGranted, 'experiment', id, { experimentId: id, claims: granted, holderId: id, workItemId: ctx.workItemId }), eventId }]);
        };
        const known = await specs.getExperiment(experimentId);
        if (known) {
          // review B2: a replay after a call that failed once the experiment was saved completes what it left undone
          // (the run's record of it, the admission audit, its budget scope); its claims were kept (they follow its owners)
          if (!run.experimentIds.includes(known.experimentId)) {
            await runs.update(run.runId, { experimentIds: [...new Set([...run.experimentIds, known.experimentId])] }, ctx.eventContext);
          }
          await openExperimentBudget(deps, run.runId, known);
          await grantedEvent(known.experimentId, known.isolation.resourceClaims);
          return success(experimentSummary(known));
        }
        const iso = experimentIsolation(input, environment);
        if (!iso.ok) return refuse('isolation_insufficient', `experiment not created: ${iso.problem}`);
        const rules = input.contaminationRules ?? defaultContaminationRules(iso.isolation);
        // D-3: contamination rules beyond the defaults are enforced through admission (their resources become claims)
        const claims = claimsWithRules(iso.isolation.resourceClaims, rules, iso.isolation.mode);
        const plan: IsolationPlan = { dedicatedEnvironment: iso.isolation.mode === 'dedicated_environment', contaminationChecks: [] };
        if (dedication?.dedicated === true && iso.isolation.mode === 'dedicated_environment') {
          if (dedication.namespace !== undefined) plan.dedicatedNamespace = dedication.namespace;
          if (dedication.database !== undefined) plan.dedicatedDatabase = dedication.database;
          if (dedication.account !== undefined) plan.dedicatedAccount = dedication.account;
        }
        const isolation: Isolation = { mode: iso.isolation.mode, resourceClaims: claims, plan };
        const exclusive = exclusiveResourcesOf({ isolation, contaminationRules: rules } as ExperimentSpec);
        plan.contaminationChecks = [
          ...(exclusive.length > 0 ? [{ kind: 'foreign_operations' as const, resources: exclusive }] : []),
          { kind: 'environment_generation' as const },
          ...(claims.some((c) => c.mode !== 'read_shared') ? [{ kind: 'exclusive_claims' as const }] : []),
        ];
        // conformance-6: the claims are admitted atomically BEFORE the experiment exists (holder = experimentId); a
        // conflicting holder refuses it — two experiments never invalidate each other's results
        const request = { holderId: experimentId, runId: run.runId, claims, ttlMs: deps.config.leaseTtlMs ?? 60_000, compatibleHolders: [ctx.workItemId] };
        const adm = await admission.admit(request);
        if (!adm.admitted) {
          const holders = [...new Set(adm.conflicts.map((c) => c.heldBy))].sort();
          const conflicts = adm.conflicts.map((c) => ({ requested: c.requested, heldBy: c.heldBy, held: c.held }));
          await events.append([event(ctx.eventContext, EVENT_TYPES.admissionRefused, 'experiment', experimentId, { experimentId, conflicts: conflicts.map((c) => `${c.requested.resourceKey}@${c.heldBy}`).sort(), claims })]);
          return refuse(
            'resource_conflict',
            `experiment not created: its isolation claims conflict with claims held by ${holders.join(', ')} (${conflicts.map((c) => `${c.requested.mode}(${c.requested.resourceKey}) vs ${c.held.mode}(${c.held.resourceKey}) of ${c.heldBy}`).join('; ')}). Wait for them to end, or define an experiment on other resources.`,
            { admitted: false, holders, conflicts } as unknown as JsonValue,
          );
        }
        const spec: Omit<ExperimentSpec, 'revision' | 'createdAt' | 'supersedes'> = {
          experimentId,
          runId: run.runId,
          oracleRefs,
          hypothesis: input.hypothesis,
          subjects: [subject],
          environment,
          fixtures: [...new Set(input.fixtures ?? [])],
          faultPlan: input.faultPlan ?? [],
          // recorded, never empty: a generated seed is derived from the (retry-stable) invocation
          randomSeeds: input.randomSeeds !== undefined && input.randomSeeds.length > 0 ? [...input.randomSeeds] : [sha256Hex(`${ctx.runId}\u0000${ctx.invocationId}\u0000seed`).slice(0, 16)],
          isolation,
          evidenceRequirements: input.evidenceRequirements ?? [],
          stopConditions: input.stopConditions ?? defaultStopConditions(input),
          contaminationRules: rules,
          createdBy: ctx.agentId,
        };
        if (input.workload !== undefined) spec.workload = input.workload;
        if (input.budget !== undefined && Object.keys(input.budget).length > 0) spec.budget = input.budget as Partial<BudgetEnvelope>;
        if (run.systemModelRevision !== undefined) spec.systemModelRevision = run.systemModelRevision;
        let saved: ExperimentSpec;
        try {
          saved = await specs.saveExperiment(spec, ctx.eventContext);
        } catch (e) {
          // not created: its claims must not outlive it — released only when the experiment is known NOT to exist (a save
          // that failed after its commit leaves an existing experiment, whose claims stay; unknown ⇒ kept until the TTL)
          const exists = await specs.getExperiment(experimentId).then((x) => x !== undefined, () => true);
          if (!exists) await admission.release(experimentId).catch(() => undefined);
          throw e;
        }
        // review B2: once saved, the experiment exists and keeps its claims (they follow its owners); a failure from here on
        // is completed by the replay (retry-stable id), never by releasing the claims of an existing experiment
        await runs.update(run.runId, { experimentIds: [...new Set([...run.experimentIds, saved.experimentId])] }, ctx.eventContext);
        await openExperimentBudget(deps, run.runId, saved);
        await grantedEvent(experimentId, claims);
        return success(experimentSummary(saved));
      },
    }),

    domainTool<{ experimentId: string; reason: string }>({
      id: 'experiment.stop',
      title: 'Stop an experiment',
      description:
        'Record a manual stop of an experiment of this run (with the reason): from then on its write, load and fault calls are refused (ending a load job with load.stop stays possible). Stop conditions (duration, error rate, metric threshold) stop an experiment automatically when they are met.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['experimentId', 'reason'], properties: { experimentId: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1, maxLength: 2000 } } },
      area: 'experiments',
      async execute(input, ctx) {
        const spec = await specs.getExperiment(input.experimentId);
        if (!spec || spec.runId !== ctx.runId) return refuse('not_found', `experiment ${input.experimentId} does not exist in this run`);
        const recorded = await recordExperimentStop(deps, ctx.eventContext, spec, { condition: 'manual', reason: input.reason, observed: `manual stop by ${ctx.agentId}` });
        return success({ experimentId: spec.experimentId, stopped: true, at: recorded.at, condition: recorded.condition });
      },
    }),

    domainTool<RegisterInput>({
      id: 'test_artifact.register',
      title: 'Register a test artifact',
      description:
        'Register a test file of your workspace as a TestArtifact (path, sourceType, runner {framework, selector, command?}, oracleRefs naming the oracle assertions it encodes). Its content is stored content-addressed; it starts as a draft and becomes gate evidence only after its whole lifecycle: static check, known-good pass, known-bad/mutation fail (test_artifact.validate) and an independent oracle consistency review. Registering the same path again with unchanged content returns the current revision (never demotes it); changed content creates a new draft revision that must be validated again.',
      inputSchema: TEST_ARTIFACT_INPUT_SCHEMA,
      area: 'test_artifacts',
      timeoutMs: 60_000,
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const path = normalizeTestPath(input.path);
        const abs = await workspaces.resolvePath(ctx.workspace, path);
        let content: Buffer;
        try {
          content = await readFile(abs);
        } catch {
          return refuse('not_found', `test file ${path} does not exist in your workspace`);
        }
        // the oracle assertions it claims to encode must exist (the oracle consistency review judges whether it does)
        const refProblems: string[] = [];
        for (const ref of input.oracleRefs) {
          const o = await specs.getOracle(ref.oracleId, ref.revision);
          if (!o) refProblems.push(`oracle ${ref.oracleId} revision ${ref.revision} does not exist`);
          else for (const id of ref.assertionIds) if (!o.assertions.some((a) => a.assertionId === id)) refProblems.push(`assertion ${id} does not exist in oracle ${ref.oracleId}@${ref.revision}`);
        }
        if (refProblems.length > 0) return refuse('not_found', `registration refused: ${refProblems.join('; ')}`);
        // through the call's (metered, budget-bounded) artifact store (conformance-5)
        const ref = await ctx.artifacts.put(content, { mimeType: 'text/plain' });
        const epoch = await caller.epoch();
        // A test written in this run is never "existing": designers' artifacts are generated (or repaired/mutated).
        const sourceType: TestArtifact['sourceType'] = ctx.role === 'test_designer' && input.sourceType === 'existing' ? 'generated' : input.sourceType;
        let artifactId = retryStableId('ta', ctx.runId, ctx.invocationId);
        let previous: TestArtifact | undefined;
        if (input.supersedesArtifactId !== undefined) {
          previous = await specs.getTestArtifact(input.supersedesArtifactId);
          if (!previous || previous.runId !== ctx.runId) return refuse('not_found', `test artifact ${input.supersedesArtifactId} does not exist in this run`);
          artifactId = previous.artifactId;
        } else {
          // addendum: re-registering a path of this run addresses its artifact (never a second artifact for one file)
          previous = (await specs.listTestArtifacts(ctx.runId)).find((a) => sameTestFile(a.path, path));
          if (previous) artifactId = previous.artifactId;
          else previous = await specs.getTestArtifact(artifactId); // a replayed registration
        }
        if (previous && previous.artifactDigest === ref.sha256 && previous.path === path) {
          // unchanged content: idempotent — the current revision is returned as is (a validated/approved artifact is never demoted)
          const sameRefs = canonicalJson(previous.oracleRefs as unknown as JsonValue) === canonicalJson(input.oracleRefs as unknown as JsonValue) && canonicalJson(previous.runner as unknown as JsonValue) === canonicalJson(input.runner as unknown as JsonValue);
          if (sameRefs || previous.approvalState !== 'draft') {
            const note = sameRefs ? undefined : `content unchanged: artifact ${previous.artifactId} revision ${previous.revision} (${previous.approvalState}) is kept as registered; its runner/oracleRefs change only with a new content revision`;
            return success({ artifactId: previous.artifactId, revision: previous.revision, artifactDigest: previous.artifactDigest, sha256: sha256Hex(content), approvalState: previous.approvalState, sourceType: previous.sourceType, unchanged: true }, note);
          }
        }
        const generatedBy: NonNullable<TestArtifact['generatedBy']> = { agentId: ctx.agentId, role: ctx.role };
        if (epoch.epochId !== undefined) generatedBy.modelEpochId = epoch.epochId;
        if (ctx.snapshot) generatedBy.contextSnapshotId = ctx.snapshot.snapshotId;
        const artifact: Omit<TestArtifact, 'revision' | 'createdAt'> = {
          artifactId,
          runId: ctx.runId,
          path,
          artifactDigest: ref.sha256,
          sourceType,
          generatedBy,
          oracleRefs: input.oracleRefs,
          runner: input.runner,
          validations: {},
          approvalState: 'draft',
        };
        if (input.experimentId !== undefined) artifact.experimentId = input.experimentId;
        // compare-and-set on the revision this registration supersedes (a concurrent write is a conflict, never lost)
        if (previous !== undefined && previous.artifactId === artifactId) artifact.supersedes = previous.revision;
        const run = await caller.run();
        if (run.systemModelRevision !== undefined) artifact.systemModelRevision = run.systemModelRevision;
        const saved = await specs.saveTestArtifact(artifact, ctx.eventContext);
        const changed = previous !== undefined && previous.artifactDigest !== saved.artifactDigest;
        return success(
          { artifactId: saved.artifactId, revision: saved.revision, artifactDigest: saved.artifactDigest, sha256: sha256Hex(content), approvalState: saved.approvalState, sourceType: saved.sourceType, ...(changed ? { contentChanged: true } : {}) },
          changed ? `the content of ${path} changed: artifact ${saved.artifactId} revision ${saved.revision} is a new draft — validate it again (static check, known-good, known-bad or mutation) and have it reviewed` : undefined,
        );
      },
    }),

    domainTool<ValidateInput>({
      id: 'test_artifact.validate',
      title: 'Validate a test artifact',
      description:
        'Record the lifecycle validation of a registered test artifact from evidence of this run that executed EXACTLY its file and content (foreign evidence is refused): knownGoodEvidenceId (a test-result whose cases of the artifact all passed — on the BASE revision via test.run revision "base"; a pass on the workspace (candidate) code is accepted but then the artifact never supports or violates a P0/P1 assertion), knownBadEvidenceId (a test-result with ≥1 failed case of the artifact on other code than the known-good run), mutationEvidenceId (a mutation-result of a mutation.run of the candidate\'s PRODUCT source whose testSelector named only the artifact\'s file, with ≥1 killed mutant). The static (syntax) check comes from the cited runs. knownGoodUnavailableReason records why no known-good revision can exist (the artifact then never supports a P0/P1 assertion). A validated artifact is sent to an independent oracle consistency review; only an approved artifact is gate evidence.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['artifactId'],
        properties: {
          artifactId: { type: 'string', minLength: 1 },
          knownGoodEvidenceId: { type: 'string', minLength: 1 },
          knownBadEvidenceId: { type: 'string', minLength: 1 },
          mutationEvidenceId: { type: 'string', minLength: 1 },
          knownGoodUnavailableReason: { type: 'string', minLength: 20, maxLength: 2000 },
        },
      },
      area: 'test_artifacts',
      async execute(input, ctx) {
        const artifact = await specs.getTestArtifact(input.artifactId);
        if (!artifact || artifact.runId !== ctx.runId) return refuse('not_found', `test artifact ${input.artifactId} does not exist in this run`);
        const cited = [input.knownGoodEvidenceId, input.knownBadEvidenceId, input.mutationEvidenceId].filter((x): x is string => x !== undefined);
        if (cited.length === 0 && input.knownGoodUnavailableReason === undefined) return refuse('evidence_required', 'cite at least one of knownGoodEvidenceId, knownBadEvidenceId, mutationEvidenceId (or record knownGoodUnavailableReason)');
        if (input.knownGoodEvidenceId !== undefined && input.knownGoodUnavailableReason !== undefined) return refuse('invalid_argument', 'cite a known-good run OR record why none can exist, not both');
        const ev = await checkEvidence(deps, ctx.runId, cited);
        if (!ev.ok) return refuse('unknown_evidence', `validation refused: ${ev.problems.join('; ')}`);
        const byId = new Map(ev.records.map((r) => [r.evidenceId, r]));
        // D-0: every cited record must have executed THIS artifact's file and content — foreign evidence is refused outright
        const bindings = new Map<string, { codeDigest: string; revision: 'workspace' | 'base'; static?: { checker: string; ok: boolean; detail?: string } }>();
        const purposes: Array<[BindingPurpose, string | undefined]> = [['known_good', input.knownGoodEvidenceId], ['known_bad', input.knownBadEvidenceId], ['mutation', input.mutationEvidenceId]];
        const runNow = await deps.runs.get(ctx.runId);
        for (const [purpose, id] of purposes) {
          if (id === undefined) continue;
          const b = sensitivityBinding(byId.get(id)!, artifact, purpose);
          if (!b.ok) return refuse('foreign_evidence', `validation refused: ${b.problem}`);
          const rev = codeRevisionOf(byId.get(id)!);
          if (purpose === 'known_good' && rev?.kind === 'base' && rev.baseCommit !== runNow?.target.baseCommit) {
            return refuse('foreign_evidence', `validation refused: known-good evidence ${id} ran on base revision ${String(rev.baseCommit)}, not this run's base commit ${runNow?.target.baseCommit ?? '(none)'}`);
          }
          bindings.set(`${purpose}:${id}`, { codeDigest: b.codeDigest, revision: b.revision, ...(b.file.staticCheck ? { static: b.file.staticCheck } : {}) });
        }
        const reasons: string[] = [];
        const validations: TestArtifact['validations'] = { ...artifact.validations };
        const bound = (v: TestValidation, purpose: BindingPurpose, id: string): TestValidation => {
          const b = bindings.get(`${purpose}:${id}`)!;
          return { ...v, codeDigest: b.codeDigest, artifactDigest: artifact.artifactDigest, revision: b.revision };
        };

        if (input.knownGoodEvidenceId !== undefined) {
          const e = byId.get(input.knownGoodEvidenceId)!;
          const statuses = artifactCaseStatuses(e, artifact.path);
          let v: TestValidation;
          const badCode = validations.knownBad?.status === 'passed' ? validations.knownBad.codeDigest : undefined;
          const code = bindings.get(`known_good:${e.evidenceId}`)!.codeDigest;
          if (badCode !== undefined && badCode === code) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `known-good and known-bad ran on the same code (tree ${code.slice(0, 12)}…): sensitivity needs the defect in the code under test, not a different run of the same code` };
          else if (statuses.length > 0 && statuses.every((s) => s === 'passed')) v = { status: 'passed', evidenceRefs: [e.evidenceId], detail: `passed on known-good code (${bindings.get(`known_good:${e.evidenceId}`)!.revision} revision)` };
          else v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `the artifact's cases did not all pass on the known-good code (${statuses.join(', ')})` };
          if (v.status !== 'passed') reasons.push(`known-good: ${v.detail}`);
          else if (bindings.get(`known_good:${e.evidenceId}`)!.revision !== 'base') {
            // D-1: only a pass on the run's BASE revision says what correct behaviour is; a pass on the candidate may encode
            // the defect itself as the expectation
            reasons.push('known-good ran on the workspace (candidate) code, not on the base revision: the artifact can become gate evidence but never supports or violates a P0/P1 assertion — run test.run revision "base" and validate with that run for P0/P1 support');
          }
          validations.knownGood = bound(v, 'known_good', e.evidenceId);
          delete validations.knownGoodUnavailable;
        }
        if (input.knownGoodUnavailableReason !== undefined) {
          if (validations.knownGood?.status === 'passed') return refuse('invalid_argument', `artifact ${artifact.artifactId} already has a passing known-good run (${validations.knownGood.evidenceRefs.join(', ')})`);
          delete validations.knownGood;
          validations.knownGoodUnavailable = { reason: input.knownGoodUnavailableReason, recordedBy: ctx.agentId, at: deps.clock.isoNow() };
          reasons.push('known-good unavailable (recorded): the artifact can never support or violate a P0/P1 assertion');
        }
        if (input.knownBadEvidenceId !== undefined) {
          const e = byId.get(input.knownBadEvidenceId)!;
          const statuses = artifactCaseStatuses(e, artifact.path);
          const failed = statuses.filter((s) => s === 'failed').length;
          const goodCode = validations.knownGood?.status === 'passed' ? validations.knownGood.codeDigest : undefined;
          const code = bindings.get(`known_bad:${e.evidenceId}`)!.codeDigest;
          let v: TestValidation;
          if (goodCode !== undefined && code === goodCode) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `known-good and known-bad ran on the same code (tree ${goodCode.slice(0, 12)}…): sensitivity needs the defect in the code under test, not a different run of the same code` };
          else if (failed >= 1 && !statuses.includes('error')) v = { status: 'passed', evidenceRefs: [e.evidenceId], detail: `failed on known-bad code (${failed} failed cases of this artifact)` };
          else v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: 'the test did not fail with an assertion failure on the known-bad code (insensitive or harness error)' };
          if (v.status !== 'passed') reasons.push(`known-bad: ${v.detail}`);
          validations.knownBad = bound(v, 'known_bad', e.evidenceId);
        }
        if (input.mutationEvidenceId !== undefined) {
          const e = byId.get(input.mutationEvidenceId)!;
          const killed = field(e.structured, 'killed');
          const score = field(e.structured, 'score');
          const baseline = field(e.structured, 'baseline');
          let v: TestValidation & { killed?: number; score?: number };
          if (typeof killed !== 'number' || killed < 1) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: 'no mutant was killed by this artifact' };
          else if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline) || baseline['passed'] !== true) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: 'the mutation run has no passing baseline' };
          else v = { status: 'passed', evidenceRefs: [e.evidenceId], detail: `${killed} mutant(s) killed by this artifact alone`, killed, ...(typeof score === 'number' ? { score } : {}) };
          if (v.status !== 'passed') reasons.push(`mutation: ${v.detail}`);
          validations.mutation = bound(v, 'mutation', e.evidenceId);
          if (v.status === 'passed') validations.mutationScore = typeof score === 'number' ? score : 0;
          else delete validations.mutationScore;
        }
        // static (syntax) check of exactly this content, from the cited bound runs
        for (const [key, b] of bindings) {
          if (!b.static) continue;
          const id = key.slice(key.indexOf(':') + 1);
          if (b.static.ok) {
            validations.static = { status: 'passed', evidenceRefs: [id], detail: b.static.checker, artifactDigest: artifact.artifactDigest };
            break;
          }
          validations.static = { status: 'failed', evidenceRefs: [id], detail: `${b.static.checker}: ${b.static.detail ?? 'error'}`, artifactDigest: artifact.artifactDigest };
        }
        if (validations.static?.status !== 'passed') reasons.push(`static check ${validations.static ? `failed (${validations.static.detail})` : 'missing: none of the cited runs carries a static check of this file (run it with test.run in your workspace)'}`);

        const good = validations.knownGood?.status === 'passed' || (validations.knownGood === undefined && validations.knownGoodUnavailable !== undefined);
        const sensitive = validations.knownBad?.status === 'passed' || validations.mutation?.status === 'passed';
        if (!good && validations.knownGoodUnavailable === undefined) reasons.push('known-good missing: run the test on the base revision (test.run revision "base") or on fixed code, or record knownGoodUnavailableReason');
        if (!sensitive) reasons.push('sensitivity not demonstrated (needs a bound failing known-bad run or a bound mutation run with a killed mutant)');
        const validated = validations.static?.status === 'passed' && good && sensitive;
        const keepApproval = validated && artifact.approvalState === 'approved' && artifact.oracleReview?.verdict === 'approve' && artifact.oracleReview.artifactDigest === artifact.artifactDigest;
        const { revision: _r, createdAt: _c, supersedes: _s, ...rest } = artifact;
        // compare-and-set on the revision read (review: a concurrent registration or review is never overwritten by a stale
        // read — the store refuses with conflict and the call can be repeated on the current revision)
        const next: Omit<TestArtifact, 'revision' | 'createdAt'> = { ...rest, validations, approvalState: keepApproval ? 'approved' : validated ? 'validated' : 'draft', supersedes: artifact.revision };
        if (!keepApproval) delete next.oracleReview;
        const saved = await specs.saveTestArtifact(next, ctx.eventContext);
        if (saved.approvalState === 'validated') await requestArtifactReview(deps, ctx, saved);
        const goodOnWorkspace = validations.knownGood?.status === 'passed' && validations.knownGood.revision !== 'base';
        const stages = {
          static: stageOf(validations.static), knownGood: validations.knownGoodUnavailable ? 'unavailable' : goodOnWorkspace ? 'passed (workspace: no P0/P1 support)' : stageOf(validations.knownGood),
          knownBad: stageOf(validations.knownBad), mutation: stageOf(validations.mutation), oracleReview: saved.approvalState === 'approved' ? 'approved' : 'pending',
        };
        const p0p1 = validations.knownGoodUnavailable || goodOnWorkspace ? ' It will never support or violate a P0/P1 assertion (its known-good run is not a pass on the base revision).' : '';
        const note = saved.approvalState === 'validated'
          ? `validated: an independent oracle consistency review was requested; the artifact becomes gate evidence once a reviewer approves it.${p0p1}`
          : saved.approvalState === 'approved' ? (p0p1 !== '' ? p0p1.trim() : undefined) : `artifact stays draft: ${reasons.join('; ')}`;
        return success({ artifactId: saved.artifactId, revision: saved.revision, approvalState: saved.approvalState, stages, validations: saved.validations, reasons }, note);
      },
    }),
  ];
}

/** (D-3) Opens the budget scope of an experiment with its declared limits (idempotent; no budget ⇒ nothing to open). */
export async function openExperimentBudget(deps: Pick<ControlDeps, 'budget'>, runId: string, spec: Pick<ExperimentSpec, 'experimentId' | 'budget'>): Promise<void> {
  const b = spec.budget;
  if (!b) return;
  const limits: Record<string, number> = {};
  if (b.maxToolCalls !== undefined) limits['toolCalls'] = b.maxToolCalls;
  if (b.maxExternalQps !== undefined) limits['externalQps'] = b.maxExternalQps;
  if (b.maxComputeMinutes !== undefined) limits['computeMs'] = Math.round(b.maxComputeMinutes * 60_000);
  if (Object.keys(limits).length === 0) return;
  try {
    await deps.budget.open(experimentScope(spec.experimentId), limits, runScope(runId));
  } catch {
    // the run scope is not open (a run without budget rows, e.g. a unit harness): the experiment scope is a root then
    await deps.budget.open(experimentScope(spec.experimentId), limits);
  }
}

/**
 * (D-3) Records the stop of an experiment once (`experiment.stopped`, deterministic event id): a met stop condition or a
 * manual stop. Returns the recorded stop (the first one when it was already stopped).
 */
export async function recordExperimentStop(
  deps: Pick<ControlDeps, 'events' | 'clock'>,
  ctx: EventContext,
  spec: Pick<ExperimentSpec, 'experimentId'>,
  stop: { condition: string; reason: string; observed?: string; at?: string },
): Promise<{ at: string; condition: string; reason: string }> {
  const eventId = experimentStopEventId(spec.experimentId);
  const known = await deps.events.get(eventId);
  if (known) {
    const p = (known.payload ?? {}) as { at?: string; condition?: string; reason?: string };
    return { at: p.at ?? known.occurredAt, condition: p.condition ?? 'manual', reason: p.reason ?? '' };
  }
  const at = stop.at ?? deps.clock.isoNow();
  try {
    await deps.events.append([{ ...event(ctx, EVENT_TYPES.experimentStopped, 'experiment', spec.experimentId, { experimentId: spec.experimentId, condition: stop.condition, reason: stop.reason, observed: stop.observed, at }), eventId }]);
  } catch (e) {
    if (!(await deps.events.get(eventId))) throw e;
  }
  // (review) the RECORDED stop is the stop: a concurrent caller may have recorded it first (same deterministic id)
  const recorded = await deps.events.get(eventId);
  const p = (recorded?.payload ?? {}) as { at?: string; condition?: string; reason?: string };
  return recorded ? { at: p.at ?? recorded.occurredAt, condition: p.condition ?? 'manual', reason: p.reason ?? '' } : { at, condition: stop.condition, reason: stop.reason };
}

/** (D-1) Requests the oracle consistency review of a validated artifact revision (once per revision). */
async function requestArtifactReview(deps: ControlDeps, ctx: ToolContext, a: TestArtifact): Promise<void> {
  const eventId = artifactReviewRequestEventId(a.artifactId, a.revision);
  if (await deps.events.get(eventId)) return;
  const refs = a.oracleRefs.map((r) => `${r.oracleId}@${r.revision} [${r.assertionIds.join(', ')}]`).join('; ') || 'none';
  const payload = {
    subjectRef: { kind: 'test_artifact', id: a.artifactId },
    title: `oracle consistency of test artifact ${a.artifactId} (${a.path})`,
    summary: `Test artifact ${a.artifactId} (${a.path}, revision ${a.revision}, content ${a.artifactDigest.slice(0, 12)}…) passed its static check, known-good and sensitivity validation. Review its ORACLE CONSISTENCY: read the test (fs.read ${a.path}) and the oracle assertions it claims to encode (${refs}) with oracle.get, and judge whether its assertions check exactly those assertions (exact values, no weaker check, nothing skipped). Record the verdict with blackboard.post_review on subjectRef {"kind":"test_artifact","id":"${a.artifactId}"} citing the validation evidence you inspected (${[...(a.validations.knownGood?.evidenceRefs ?? []), ...(a.validations.knownBad?.evidenceRefs ?? []), ...(a.validations.mutation?.evidenceRefs ?? [])].join(', ') || 'none'}): approve makes it gate evidence, reject sends it back to draft.`,
    artifactId: a.artifactId,
    revision: a.revision,
  };
  await deps.events.append([{ ...event(ctx.eventContext, EVENT_TYPES.reviewRequested, 'test_artifact', a.artifactId, payload), eventId }]);
}

/**
 * (D-1) The oracle consistency review of a test artifact, applied when a reviewer posts a review on subjectRef
 * `{ kind: 'test_artifact', id }` (blackboard.post_review). Checked BEFORE the review record is posted: the artifact exists
 * in the run; an approval needs a `validated` (or already approved) artifact, a reviewer other than its creator agent and
 * of another role, and oracleRefs naming assertions of oracle revisions in force for the run. Returns the refusal text.
 */
export async function artifactReviewRefusal(deps: ControlDeps, ctx: ToolContext, artifactId: string, verdict: Review['verdict']): Promise<string | undefined> {
  const a = await deps.specs.getTestArtifact(artifactId);
  if (!a || a.runId !== ctx.runId) return `test artifact ${artifactId} does not exist in this run`;
  if (verdict !== 'approve') return undefined;
  if (a.approvalState !== 'validated' && a.approvalState !== 'approved') {
    return `test artifact ${artifactId} is ${a.approvalState}: only a validated artifact (static check, known-good, known-bad or mutation done) can pass the oracle consistency review`;
  }
  if (a.generatedBy?.agentId === ctx.agentId) return `you created test artifact ${artifactId}: its oracle consistency review must come from another agent`;
  const creatorRole = a.generatedBy?.role ?? 'test_designer';
  if (ctx.role === creatorRole) return `the oracle consistency review of test artifact ${artifactId} must come from a role other than its creator's (${creatorRole})`;
  const run = await deps.runs.get(ctx.runId);
  const problems = oracleRefProblems(a, run ? await oraclesInForce(deps, run) : []);
  if (problems.length > 0) return `test artifact ${artifactId} cannot be approved: ${problems.join('; ')}`;
  return undefined;
}

/**
 * (D-1, review) The artifact content a review by the calling work item judges: the revision named by the oracle consistency
 * review request the work item was created for (`review.requested` of that artifact), else the current content.
 */
export async function reviewedArtifactDigest(deps: ControlDeps, ctx: ToolContext, artifactId: string): Promise<string | undefined> {
  const item = await deps.blackboard.getWorkItem(ctx.workItemId);
  const eventId = item?.origin.kind === 'reactor' ? item.origin.eventId : undefined;
  const request = eventId !== undefined ? await deps.events.get(eventId) : undefined;
  const p = (request?.payload ?? {}) as { artifactId?: unknown; revision?: unknown };
  if (request?.eventType === EVENT_TYPES.reviewRequested && p.artifactId === artifactId && typeof p.revision === 'number') {
    const requested = await deps.specs.getTestArtifact(artifactId, p.revision);
    if (requested) return requested.artifactDigest;
  }
  return (await deps.specs.getTestArtifact(artifactId))?.artifactDigest;
}

/**
 * (D-1) Applies a posted review to the artifact: approve ⇒ approved (with the review), reject ⇒ draft. `reviewedDigest` is
 * the content the review was checked against (read before the review was posted): when the artifact's content changed
 * since (a new registration), the review is NOT applied — it judged other content — and `stale` says so.
 */
export async function applyArtifactReview(
  deps: ControlDeps,
  ctx: ToolContext,
  artifactId: string,
  review: { recordId: string; verdict: Review['verdict']; modelProvider?: string },
  reviewedDigest?: string,
): Promise<{ approvalState: TestArtifact['approvalState']; stale?: string } | undefined> {
  if (review.verdict !== 'approve' && review.verdict !== 'reject') return undefined;
  const a = await deps.specs.getTestArtifact(artifactId);
  if (!a || a.runId !== ctx.runId) return undefined;
  if (a.oracleReview?.reviewRecordId === review.recordId) return { approvalState: a.approvalState }; // replayed
  if (reviewedDigest !== undefined && reviewedDigest !== a.artifactDigest) {
    return { approvalState: a.approvalState, stale: `test artifact ${artifactId} changed while it was reviewed (content ${reviewedDigest.slice(0, 12)}… → ${a.artifactDigest.slice(0, 12)}…, revision ${a.revision} ${a.approvalState}): the review was recorded but NOT applied — review the current content once it is validated` };
  }
  // a further approval of the content already approved changes nothing (no new revision; the review record stays posted)
  if (review.verdict === 'approve' && a.approvalState === 'approved' && a.oracleReview?.verdict === 'approve' && a.oracleReview.artifactDigest === a.artifactDigest) return { approvalState: a.approvalState };
  const run = await deps.runs.get(ctx.runId);
  const inForce = run ? await oraclesInForce(deps, run) : [];
  const oracleRevisions: Record<string, number> = {};
  for (const ref of a.oracleRefs) {
    const o = inForce.find((x) => x.oracleId === ref.oracleId);
    if (o) oracleRevisions[o.oracleId] = o.revision;
  }
  const r: TestArtifactReview = { reviewRecordId: review.recordId, reviewerAgentId: ctx.agentId, reviewerRole: ctx.role, verdict: review.verdict, artifactDigest: a.artifactDigest, oracleRevisions, at: deps.clock.isoNow() };
  if (review.modelProvider !== undefined) r.modelProvider = review.modelProvider;
  const { revision: _r, createdAt: _c, supersedes: _s, ...rest } = a;
  // compare-and-set on the revision reviewed: a review never applies to content registered after it was read
  const saved = await deps.specs.saveTestArtifact({ ...rest, approvalState: review.verdict === 'approve' ? 'approved' : 'draft', oracleReview: r, supersedes: a.revision }, ctx.eventContext);
  await deps.events.append([event(ctx.eventContext, EVENT_TYPES.testArtifactReviewed, 'test_artifact', artifactId, { artifactId, revision: saved.revision, verdict: review.verdict, reviewRecordId: review.recordId, reviewerAgentId: ctx.agentId, reviewerRole: ctx.role, approvalState: saved.approvalState })]);
  return { approvalState: saved.approvalState };
}

/** Test artifacts are read back from the ArtifactStore by digest (materialization into another worktree). */
export async function artifactContent(deps: ControlDeps, artifact: TestArtifact): Promise<Uint8Array> {
  return deps.artifacts.get(artifact.artifactDigest);
}
