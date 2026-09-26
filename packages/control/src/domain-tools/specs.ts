import { readFile } from 'node:fs/promises';
import { canonicalJson, sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import {
  ORACLE_CHANGE_INPUT_SCHEMA, SYSTEM_MODEL_INPUT_SCHEMA, TEST_ARTIFACT_INPUT_SCHEMA,
  type ComponentModel, type DependencyEdge, type EnvironmentRef, type EvidenceRecord, type EvidenceRequirement, type ExperimentSpec, type FaultSpec,
  type InterfaceModel, type OracleAssertion, type ResourceClaim, type RunnerSpec, type StateMachineModel, type TestArtifact, type TestValidation,
  type WorkloadSpec,
} from '@hypertest/domain';
import type { ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { Caller, checkEvidence, domainTool, refuse, success } from './common.ts';

interface SystemModelInput {
  components: ComponentModel[];
  interfaces?: InterfaceModel[];
  dependencies?: DependencyEdge[];
  stateMachines?: StateMachineModel[];
  invariants?: string[];
  changedComponents?: string[];
  riskTags?: string[];
}

interface OracleChangeInput {
  oracleId: string;
  fromRevision: number;
  proposedAssertions: OracleAssertion[];
  rationale: string;
  relatedEvidenceRefs?: string[];
}

interface ExperimentInput {
  hypothesis: string;
  environmentId?: string;
  workload?: WorkloadSpec;
  faultPlan?: FaultSpec[];
  isolation?: ExperimentSpec['isolation'];
  evidenceRequirements?: EvidenceRequirement[];
  oracleRefs?: Array<{ oracleId: string; revision: number }>;
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
}

const EVIDENCE_REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceType', 'minCount'],
  properties: { evidenceType: { type: 'string', minLength: 1 }, minCount: { type: 'integer', minimum: 1 }, description: { type: 'string' }, critical: { type: 'boolean' } },
} as const;

const RESOURCE_CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resourceKey', 'mode'],
  properties: { resourceKey: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['read_shared', 'write_exclusive', 'fault_exclusive'] }, quantity: { type: 'integer', minimum: 1 } },
} as const;

function field(structured: JsonValue | undefined, key: string): JsonValue | undefined {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return undefined;
  return (structured as Record<string, JsonValue>)[key];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** Same file, allowing one side to be absolute or rooted elsewhere (`/ws/test/a.test.js` ≡ `test/a.test.js`). */
function sameFile(file: string, path: string): boolean {
  const f = normalizePath(file);
  const p = normalizePath(path);
  return f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`);
}

/** The python module path of a test file (`tests/test_x.py` → `tests.test_x`), as pytest's junit classname uses it. */
function pythonModule(path: string): string | undefined {
  const p = normalizePath(path);
  return p.endsWith('.py') ? p.slice(0, -3).replaceAll('/', '.') : undefined;
}

/** True when one test case of a test-result belongs to the artifact's file (exact path, never a name substring). */
function caseAboutArtifact(c: JsonValue, a: TestArtifact): boolean {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const rec = c as Record<string, JsonValue>;
  if (typeof rec['file'] === 'string') return sameFile(rec['file'], a.path);
  const id = typeof rec['id'] === 'string' ? rec['id'] : '';
  const sepAt = id.indexOf('::');
  if (sepAt > 0) {
    const head = id.slice(0, sepAt);
    const mod = pythonModule(a.path);
    return sameFile(head, a.path) || (mod !== undefined && (head === mod || head.endsWith(`.${mod}`) || mod.endsWith(`.${head}`)));
  }
  return false;
}

/**
 * conformance-10: what a validating test-result executed, from its tool-derived `workspaceDelta` (never a caller claim):
 * a changed copy of the artifact's file must be exactly the registered content (a known-bad run obtained with a
 * temporarily broken assertion proves nothing), and the run's tree digest identifies the code it ran on. Evidence
 * without a computed delta (legacy, unavailable) is judged as before.
 */
function executedAs(e: EvidenceRecord, a: TestArtifact): { ok: true; codeDigest?: string } | { ok: false; detail: string } {
  const delta = field(e.structured, 'workspaceDelta');
  if (!delta || typeof delta !== 'object' || Array.isArray(delta) || delta['status'] !== 'computed') return { ok: true };
  const files = Array.isArray(delta['testFiles']) ? (delta['testFiles'] as JsonValue[]) : [];
  const mine = files.find((f) => !!f && typeof f === 'object' && !Array.isArray(f) && f['path'] === a.path) as Record<string, JsonValue> | undefined;
  if (mine && mine['change'] !== 'deleted' && mine['sha256'] !== a.artifactDigest) {
    return { ok: false, detail: `test-result ${e.evidenceId} executed ${a.path} with content ${String(mine['sha256']).slice(0, 12)}…, not the registered artifact content ${a.artifactDigest.slice(0, 12)}…` };
  }
  return typeof delta['treeDigest'] === 'string' ? { ok: true, codeDigest: delta['treeDigest'] } : { ok: true };
}

/**
 * How a test-result record bears on an artifact: its cases of that artifact (by exact file), or — when the record
 * was produced for the artifact (`testArtifactId(s)`) and names no file per case — the whole run.
 */
function artifactOutcome(e: EvidenceRecord, a: TestArtifact): { about: false } | { about: true; passed: boolean; failed: number } {
  const s = e.structured;
  const ids = field(s, 'testArtifactIds');
  const linked = field(s, 'testArtifactId') === a.artifactId || (Array.isArray(ids) && ids.includes(a.artifactId));
  const cases = field(s, 'cases');
  const mine = Array.isArray(cases) ? cases.filter((c) => caseAboutArtifact(c, a)) : [];
  if (mine.length > 0) {
    const statuses = mine.map((c) => String((c as Record<string, JsonValue>)['status']));
    return { about: true, passed: statuses.every((x) => x === 'passed'), failed: statuses.filter((x) => x === 'failed').length };
  }
  const fileLess = Array.isArray(cases) && cases.every((c) => !c || typeof c !== 'object' || Array.isArray(c) || typeof (c as Record<string, JsonValue>)['file'] !== 'string');
  if (linked && fileLess) return { about: true, passed: field(s, 'passed') === true, failed: failedCases(e) };
  return { about: false };
}

function failedCases(e: EvidenceRecord): number {
  const totals = field(e.structured, 'totals');
  const failed = field(totals, 'failed');
  if (typeof failed === 'number') return failed;
  const cases = field(e.structured, 'cases');
  return Array.isArray(cases) ? cases.filter((c) => c && typeof c === 'object' && !Array.isArray(c) && (c as Record<string, JsonValue>)['status'] === 'failed').length : 0;
}

/** An id derived from the tool invocation: a replayed call (crash before the call settled) addresses the same object. */
function retryStableId(prefix: string, runId: string, invocationId: string): string {
  return `${prefix}_${sha256Hex(`${runId}\u0000${invocationId}`).slice(0, 26)}`;
}

export function specTools(deps: ControlDeps): ToolSpec[] {
  const { specs, runs, oracles, environments, artifacts, workspaces } = deps;

  return [
    domainTool<SystemModelInput>({
      id: 'system_model.record',
      title: 'Record the system model',
      description: 'Record (a new revision of) the run\'s SystemModel: components with their observed paths, interfaces, dependencies, state machines, invariants, changed components and risk tags. The system model informs planning; it is never an oracle.',
      inputSchema: SYSTEM_MODEL_INPUT_SCHEMA,
      area: 'system_model',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const run = await caller.run();
        const target = run.target;
        const model = await specs.saveSystemModel(
          {
            systemModelId: `sm_${run.runId}`,
            runId: run.runId,
            subject: { repoRefs: target.repoPath ? [target.repoPath] : [], commitDigests: target.commit ? [target.commit] : [], buildDigests: [] },
            components: input.components.map((c) => ({ ...c, riskTags: c.riskTags ?? [] })),
            interfaces: input.interfaces ?? [],
            dependencies: input.dependencies ?? [],
            stateMachines: input.stateMachines ?? [],
            invariants: input.invariants ?? [],
            changedComponents: input.changedComponents ?? [],
            riskTags: input.riskTags ?? [],
            sources: [],
            createdBy: ctx.agentId,
          },
          ctx.eventContext,
        );
        await runs.update(run.runId, { systemModelRevision: model.revision }, ctx.eventContext);
        return success({ systemModelId: model.systemModelId, revision: model.revision });
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
      description: 'Define an ExperimentSpec (hypothesis, environment, workload, fault plan, isolation with resource claims, evidence requirements, oracle refs) before any load, fault or performance run. Subjects come from the run target.',
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
        },
      } as JsonSchema,
      area: 'experiments',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const run = await caller.run();
        const envId = input.environmentId ?? run.target.environmentId;
        let environment: EnvironmentRef = { environmentId: envId ?? 'local', environmentClass: 'local', generation: 0 };
        if (envId !== undefined) {
          const env = environments.get(envId);
          if (!env) return refuse('not_found', `environment ${envId} is not registered`);
          environment = { environmentId: env.environmentId, environmentClass: env.environmentClass, generation: env.generation };
          if (env.buildDigest !== undefined) environment.buildDigest = env.buildDigest;
        }
        const oracleRefs = input.oracleRefs ?? Object.entries(run.oracleRevisions).map(([oracleId, revision]) => ({ oracleId, revision }));
        for (const ref of oracleRefs) {
          if (!(await specs.getOracle(ref.oracleId, ref.revision))) return refuse('not_found', `oracle ${ref.oracleId} revision ${ref.revision} does not exist`);
        }
        const subject: ExperimentSpec['subjects'][number] = { role: 'candidate', buildDigest: environment.buildDigest ?? run.target.commit ?? 'unknown' };
        if (run.target.commit !== undefined) subject.commit = run.target.commit;
        // retry-stable id: a replayed call returns the experiment it already defined
        const experimentId = retryStableId('exp', ctx.runId, ctx.invocationId);
        const known = await specs.getExperiment(experimentId);
        if (known) return success({ experimentId: known.experimentId, revision: known.revision, environment: known.environment });
        const spec: Omit<ExperimentSpec, 'revision' | 'createdAt' | 'supersedes'> = {
          experimentId,
          runId: run.runId,
          oracleRefs,
          hypothesis: input.hypothesis,
          subjects: [subject],
          environment,
          fixtures: [],
          faultPlan: input.faultPlan ?? [],
          randomSeeds: [],
          isolation: input.isolation ?? { mode: 'shared_readonly', resourceClaims: [] as ResourceClaim[] },
          evidenceRequirements: input.evidenceRequirements ?? [],
          stopConditions: [],
          contaminationRules: [],
          createdBy: ctx.agentId,
        };
        if (input.workload !== undefined) spec.workload = input.workload;
        if (run.systemModelRevision !== undefined) spec.systemModelRevision = run.systemModelRevision;
        const saved = await specs.saveExperiment(spec, ctx.eventContext);
        await runs.update(run.runId, { experimentIds: [...new Set([...run.experimentIds, saved.experimentId])] }, ctx.eventContext);
        return success({ experimentId: saved.experimentId, revision: saved.revision, environment: saved.environment });
      },
    }),

    domainTool<RegisterInput>({
      id: 'test_artifact.register',
      title: 'Register a test artifact',
      description:
        'Register a test file of your workspace as a TestArtifact (path, sourceType, runner {framework, selector, command?}, oracleRefs). Its content is stored content-addressed; it starts as a draft and becomes gate evidence only after test_artifact.validate proves its sensitivity.',
      inputSchema: TEST_ARTIFACT_INPUT_SCHEMA,
      area: 'test_artifacts',
      timeoutMs: 60_000,
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const path = normalizePath(input.path);
        const abs = await workspaces.resolvePath(ctx.workspace, path);
        let content: Buffer;
        try {
          content = await readFile(abs);
        } catch {
          return refuse('not_found', `test file ${path} does not exist in your workspace`);
        }
        const ref = await artifacts.put(content, { mimeType: 'text/plain' });
        const epoch = await caller.epoch();
        // A test written in this run is never "existing": designers' artifacts are generated (or repaired/mutated).
        const sourceType: TestArtifact['sourceType'] = ctx.role === 'test_designer' && input.sourceType === 'existing' ? 'generated' : input.sourceType;
        let artifactId = retryStableId('ta', ctx.runId, ctx.invocationId);
        if (input.supersedesArtifactId !== undefined) {
          const prev = await specs.getTestArtifact(input.supersedesArtifactId);
          if (!prev || prev.runId !== ctx.runId) return refuse('not_found', `test artifact ${input.supersedesArtifactId} does not exist in this run`);
          artifactId = prev.artifactId;
        }
        // a replayed registration (same invocation) that already stored this content returns it instead of a new revision
        const registered = await specs.getTestArtifact(artifactId);
        if (registered && registered.artifactDigest === ref.sha256 && registered.generatedBy?.agentId === ctx.agentId && registered.path === path && canonicalJson(registered.runner as unknown as JsonValue) === canonicalJson(input.runner as unknown as JsonValue)) {
          return success({ artifactId: registered.artifactId, revision: registered.revision, artifactDigest: registered.artifactDigest, sha256: sha256Hex(content), approvalState: registered.approvalState, sourceType: registered.sourceType });
        }
        const generatedBy: NonNullable<TestArtifact['generatedBy']> = { agentId: ctx.agentId };
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
        const run = await caller.run();
        if (run.systemModelRevision !== undefined) artifact.systemModelRevision = run.systemModelRevision;
        const saved = await specs.saveTestArtifact(artifact, ctx.eventContext);
        return success({ artifactId: saved.artifactId, revision: saved.revision, artifactDigest: saved.artifactDigest, sha256: sha256Hex(content), approvalState: saved.approvalState, sourceType: saved.sourceType });
      },
    }),

    domainTool<ValidateInput>({
      id: 'test_artifact.validate',
      title: 'Validate a test artifact',
      description:
        'Record the sensitivity validation of a registered test artifact from evidence of this run: knownGoodEvidenceId (test-result that passed), knownBadEvidenceId (test-result that failed with at least one failed case), mutationEvidenceId (mutation-result with ≥1 killed mutant). The artifact becomes validated only when sensitivity is proven; otherwise it stays a draft with the reasons.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['artifactId'],
        properties: {
          artifactId: { type: 'string', minLength: 1 },
          knownGoodEvidenceId: { type: 'string', minLength: 1 },
          knownBadEvidenceId: { type: 'string', minLength: 1 },
          mutationEvidenceId: { type: 'string', minLength: 1 },
        },
      },
      area: 'test_artifacts',
      async execute(input, ctx) {
        const artifact = await specs.getTestArtifact(input.artifactId);
        if (!artifact || artifact.runId !== ctx.runId) return refuse('not_found', `test artifact ${input.artifactId} does not exist in this run`);
        const cited = [input.knownGoodEvidenceId, input.knownBadEvidenceId, input.mutationEvidenceId].filter((x): x is string => x !== undefined);
        if (cited.length === 0) return refuse('evidence_required', 'cite at least one of knownGoodEvidenceId, knownBadEvidenceId, mutationEvidenceId');
        const ev = await checkEvidence(deps, ctx.runId, cited);
        if (!ev.ok) return refuse('unknown_evidence', `validation refused: ${ev.problems.join('; ')}`);
        const byId = new Map(ev.records.map((r) => [r.evidenceId, r]));
        const reasons: string[] = [];
        const validations: TestArtifact['validations'] = { ...artifact.validations };

        if (input.knownGoodEvidenceId !== undefined) {
          const e = byId.get(input.knownGoodEvidenceId)!;
          let v: TestValidation;
          const o = e.evidenceType === 'test-result' ? artifactOutcome(e, artifact) : undefined;
          const ran = executedAs(e, artifact);
          if (e.evidenceType !== 'test-result') v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `known-good evidence must be a test-result (got ${e.evidenceType})` };
          else if (!o?.about) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `test-result ${e.evidenceId} does not run artifact ${artifact.artifactId} (${artifact.path})` };
          else if (!ran.ok) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: ran.detail };
          else if (ran.codeDigest !== undefined && validations.knownBad?.status === 'passed' && validations.knownBad.codeDigest === ran.codeDigest) {
            v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `known-good and known-bad ran on the same code (tree ${ran.codeDigest.slice(0, 12)}…): sensitivity needs the defect in the code under test, not a different run of the same code` };
          } else if (o.passed) v = { status: 'passed', evidenceRefs: [e.evidenceId], detail: 'passed on known-good code', ...(ran.codeDigest ? { codeDigest: ran.codeDigest } : {}) };
          else v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: 'the test did not pass on the known-good code' };
          if (v.status !== 'passed') reasons.push(`known-good: ${v.detail}`);
          validations.knownGood = v;
        }
        if (input.knownBadEvidenceId !== undefined) {
          const e = byId.get(input.knownBadEvidenceId)!;
          let v: TestValidation;
          const o = e.evidenceType === 'test-result' ? artifactOutcome(e, artifact) : undefined;
          const ran = executedAs(e, artifact);
          const goodCode = validations.knownGood?.status === 'passed' ? validations.knownGood.codeDigest : undefined;
          if (e.evidenceType !== 'test-result') v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `known-bad evidence must be a test-result (got ${e.evidenceType})` };
          else if (!o?.about) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `test-result ${e.evidenceId} does not run artifact ${artifact.artifactId} (${artifact.path})` };
          else if (!ran.ok) v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: ran.detail };
          else if (goodCode !== undefined && ran.codeDigest === goodCode) {
            v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: `known-good and known-bad ran on the same code (tree ${goodCode.slice(0, 12)}…): sensitivity needs the defect in the code under test, not a different run of the same code` };
          } else if (!o.passed && o.failed >= 1) v = { status: 'passed', evidenceRefs: [e.evidenceId], detail: `failed on known-bad code (${o.failed} failed cases of this artifact)`, ...(ran.codeDigest ? { codeDigest: ran.codeDigest } : {}) };
          else v = { status: 'failed', evidenceRefs: [e.evidenceId], detail: 'the test did not fail with an assertion failure on the known-bad code (insensitive or harness error)' };
          if (v.status !== 'passed') reasons.push(`known-bad: ${v.detail}`);
          validations.knownBad = v;
        }
        if (input.mutationEvidenceId !== undefined) {
          const e = byId.get(input.mutationEvidenceId)!;
          const killed = field(e.structured, 'killed');
          const score = field(e.structured, 'score');
          if (e.evidenceType !== 'mutation-result') reasons.push(`mutation: evidence must be a mutation-result (got ${e.evidenceType})`);
          else if (typeof killed !== 'number' || killed < 1) reasons.push('mutation: no mutant was killed');
          else validations.mutationScore = typeof score === 'number' ? score : 0;
        }
        const sensitive = validations.knownBad?.status === 'passed' || (validations.mutationScore ?? 0) > 0;
        const good = validations.knownGood === undefined || validations.knownGood.status === 'passed';
        if (!sensitive) reasons.push('sensitivity not demonstrated (needs a failing known-bad run or a killed mutant)');
        const validated = sensitive && good;
        const { revision: _r, createdAt: _c, supersedes: _s, ...rest } = artifact;
        const saved = await specs.saveTestArtifact({ ...rest, validations, approvalState: validated ? 'validated' : 'draft' }, ctx.eventContext);
        return success({ artifactId: saved.artifactId, revision: saved.revision, approvalState: saved.approvalState, validations: saved.validations, reasons }, validated ? undefined : `artifact stays draft: ${reasons.join('; ')}`);
      },
    }),
  ];
}

/** Test artifacts are read back from the ArtifactStore by digest (materialization into another worktree). */
export async function artifactContent(deps: ControlDeps, artifact: TestArtifact): Promise<Uint8Array> {
  return deps.artifacts.get(artifact.artifactDigest);
}

