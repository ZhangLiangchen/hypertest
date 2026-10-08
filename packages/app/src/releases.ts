import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HypertestError, canonicalJson, isHypertestError, sha256Hex, sleep, type JsonValue, type Logger, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER, eventFrom, isTerminalRun, type DataClassification, type DomainEvent, type EventContext, type OperationStatus, type QualityDecision, type RuntimeEpoch,
  type RuntimeManifest, type TestRun,
} from '@hypertest/domain';
import type { Blackboard, DecisionRepository, EventStore, RunRepository } from '@hypertest/collab';
import type { AdapterRegistryLike, LeaseService, OperationLedger, Reconciler, SideEffectAdapter } from '@hypertest/operation';
import type { ModelRouter } from '@hypertest/model';
import {
  GIT_SHA_RE, IMAGE_DIGEST_RE, RELEASE_GATE_SUITE_ID, SHADOW_OF_LABEL, canarySelects, runtimeCompatibility, type AgentRepository, type CanarySelection, type CompatibilitySuiteResult,
  type PromotionResult, type RecordSuiteInput, type RollbackResult, type RuntimeRelease, type RuntimeReleaseRegistry, type SchemaMigrationAllowance, type ShadowComparison,
} from '@hypertest/runtime';
import type { RoleCatalogLike } from '@hypertest/agents';
import { ControlStore, workLeaseKey, type ControlPlane, type RunReport, type StartRunInput } from '@hypertest/control';
import type { DurableRuntime } from '@hypertest/durable';
import type { MigrateRunInput, RunMigrationResult, RuntimeReleaseService, RuntimeReleaseView, ShadowMirrorResult } from './contracts.ts';

// ------------------------------------------------------------------------------------------------ runtime BOM inputs

const gitShas = new Map<string, string | undefined>();

/**
 * `hypertest.gitSha` of the RuntimeManifest: `git rev-parse HEAD` of the Hypertest installation — only when the
 * installation directory is itself the top level of a git checkout (a Hypertest installed inside some other repository,
 * e.g. under its node_modules, must not pin that repository's commit). Undefined without git or a checkout. Cached per
 * process and directory. `rootDir` defaults to this installation's root (the monorepo directory).
 */
export function hypertestGitSha(rootDir: string = fileURLToPath(new URL('../../../', import.meta.url)), exec: (args: string[]) => string = runGit): string | undefined {
  if (gitShas.has(rootDir)) return gitShas.get(rootDir);
  let sha: string | undefined;
  try {
    const [top, head] = exec(['-C', rootDir, 'rev-parse', '--show-toplevel', 'HEAD']).trim().split('\n').map((l) => l.trim());
    if (top && head && realpathSync(top) === realpathSync(rootDir) && GIT_SHA_RE.test(head)) sha = head;
  } catch {
    sha = undefined; // no git, not a checkout, or no commit yet
  }
  gitShas.set(rootDir, sha);
  return sha;
}

function runGit(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** Environment variable naming the OCI image digest the installation runs from (`sha256:<64 hex>`). */
export const IMAGE_DIGEST_ENV = 'HYPERTEST_IMAGE_DIGEST';

/**
 * `hypertest.imageDigest` of the RuntimeManifest from `HYPERTEST_IMAGE_DIGEST` (set by the image build / deployment).
 * Unset or empty ⇒ undefined; a malformed value is a deployment error (`invalid_argument`): a BOM must never pin a
 * runtime to an unverifiable image.
 */
export function imageDigestFrom(env: Record<string, string | undefined>): string | undefined {
  const v = env[IMAGE_DIGEST_ENV];
  if (v === undefined || v.trim() === '') return undefined;
  const digest = v.trim();
  if (!IMAGE_DIGEST_RE.test(digest)) throw new HypertestError('invalid_argument', `${IMAGE_DIGEST_ENV} must be an OCI image digest sha256:<64 lowercase hex> (got ${JSON.stringify(v)})`);
  return digest;
}

// ------------------------------------------------------------------------------------------------ privacy floor

/**
 * The model router the control plane uses, with a privacy floor for context condensation: a `condenser` request routes
 * with at least the data classification of the agent whose working context it condenses (its role's classification and
 * its effective model policy's privacyClass). Without it, the working context of a `local_private` agent (restricted
 * data, local models only) would be summarized on whatever route the condenser role may use — a hosted model. Every
 * other request is passed through unchanged (agents already route with their own classification); `invoke` re-validates
 * with the same raised classification, so a fallback can never leave the floor either.
 */
export function condenserPrivacyFloor(router: ModelRouter, classificationOf: (agentId: string) => Promise<DataClassification | undefined>): ModelRouter {
  const raise = async <R extends { role: string; agentId: string; dataClassification: DataClassification }>(request: R): Promise<R> => {
    if (!request || request.role !== 'condenser') return request;
    const floor = await classificationOf(request.agentId);
    if (floor === undefined || CLASSIFICATION_ORDER[floor] <= (CLASSIFICATION_ORDER[request.dataClassification] ?? -1)) return request;
    return { ...request, dataClassification: floor };
  };
  const route: ModelRouter['route'] = async (request, ctx) => router.route(await raise(request), ctx);
  const invoke: ModelRouter['invoke'] = async (request, routeRequest) => router.invoke(request, await raise(routeRequest));
  // A[3]: the boundary re-check of a switch sees the same raised classification as the call it precedes
  const validate: ModelRouter['validate'] = router.validate ? async (decision, routeRequest) => router.validate!(decision, await raise(routeRequest)) : undefined;
  return new Proxy(router, {
    get(target, prop) {
      if (prop === 'route') return route;
      if (prop === 'invoke') return invoke;
      if (prop === 'validate' && validate) return validate;
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The classification an agent's context carries: max(its role's dataClassification, its effective policy's privacyClass). */
export function agentClassification(deps: { controlStore: Pick<ControlStore, 'agentHost'>; agents: Pick<AgentRepository, 'get'>; roles: RoleCatalogLike }): (agentId: string) => Promise<DataClassification | undefined> {
  const cache = new Map<string, DataClassification | undefined>();
  return async (agentId) => {
    if (cache.has(agentId)) return cache.get(agentId);
    const host = await deps.controlStore.agentHost(agentId);
    const roleName = host?.role ?? (await deps.agents.get(agentId))?.role;
    if (roleName === undefined) return undefined; // unknown agent: nothing to raise (not cached: it may be persisted later)
    const role = deps.roles.get(roleName);
    const levels = [role?.dataClassification, role?.defaultModelPolicy.privacyClass, host?.modelPolicy.privacyClass].filter((c): c is DataClassification => c !== undefined && Object.hasOwn(CLASSIFICATION_ORDER, c));
    const out = levels.sort((a, b) => CLASSIFICATION_ORDER[b] - CLASSIFICATION_ORDER[a])[0];
    cache.set(agentId, out);
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
    return out;
  };
}

// ------------------------------------------------------------------------------------------------ admission

/**
 * The control plane new runs are created through: a run that does not exist yet is admitted by the runtime release
 * registry first — created only under the ACTIVE release, or a canary whose selection picks it (unmanaged installations,
 * where no release was ever activated, admit any runtime except a rolled-back one; `runtime.requireActiveRelease` makes
 * them refuse too). A refused start is `precondition_failed` and creates nothing. `resumeRun` of a run paused
 * `quarantined` (its release was rolled back) or `migrating` (an explicit migration holds its checkpoint) is refused:
 * such a run continues only through `hypertest runtime migrate` (or is cancelled).
 */
export function releaseGovernedControlPlane<C extends ControlPlane>(
  control: C,
  options: {
    manifestId: string;
    registry: Pick<RuntimeReleaseRegistry, 'admit'>;
    requireActive: boolean;
    newRunId: () => string;
    getRun: (runId: string) => Promise<TestRun | undefined>;
    /**
     * Re-checks a run this wrapper just admitted and created (admission and creation are not one transaction): true when
     * the run's release was rolled back meanwhile and the run is now quarantined (`RuntimeReleaseService
     * .quarantineIfRolledBack`). Either the rollback's sweep saw the run's commit or this re-check sees the rollback's.
     */
    afterCreate?: (runId: string) => Promise<boolean>;
    /**
     * (additive) The same re-check before a run is driven: before `recover` (the first step of every durable loop — a
     * start, `resumeIncomplete`, a migration's drive, a Temporal workflow) and before an operator's `resumeRun`. True when
     * the run's release is rolled back and the run is quarantined now. It closes the window `afterCreate` leaves: a run
     * created just before its release's rollback whose creator crashed (or failed) before re-checking it is never driven
     * by the rolled-back runtime — the first loop that would drive it quarantines it instead.
     */
    beforeDrive?: (runId: string) => Promise<boolean>;
    /**
     * (additive, F[1]) Called when this runtime's durable loop starts driving a run (after `beforeDrive`, before the
     * wrapped `recover`): records that the target runtime of a migration really drives the migrated run
     * (`run.migration_driven`, see RuntimeReleaseService.markDriven) — in whichever process the loop runs.
     */
    onDrive?: (runId: string) => Promise<void>;
  },
): C {
  return {
    ...control,
    async recover(runId, signal) {
      // a run of a rolled-back release is quarantined before this loop drives it (its ticks then find it paused)
      if (options.beforeDrive && typeof runId === 'string' && runId !== '') await options.beforeDrive(runId);
      if (options.onDrive && typeof runId === 'string' && runId !== '') await options.onDrive(runId);
      return control.recover(runId, signal);
    },
    async startRun(input, ctx) {
      if (!input || typeof input !== 'object') return control.startRun(input, ctx);
      const runId = input.runId ?? options.newRunId();
      let admitted = false;
      if (!(await options.getRun(runId))) {
        // (F[0]) a mirrored run (label hypertest.shadow_of) is admitted only by a shadow release (and dispatches no effect)
        const shadowOf = input.labels?.[SHADOW_OF_LABEL];
        const admission = await options.registry.admit({
          manifestId: options.manifestId, runId, labels: input.labels ?? {}, requireActive: options.requireActive, ...(typeof shadowOf === 'string' ? { shadowOf } : {}),
        });
        if (!admission.allowed) {
          throw new HypertestError('precondition_failed', `runtime release: ${admission.reason}`, {
            details: { runId, runtimeManifestId: options.manifestId, activeManifestId: admission.activeManifestId ?? null, state: admission.state ?? null },
          });
        }
        admitted = true;
      }
      const run = await control.startRun({ ...input, runId }, ctx);
      if (admitted && options.afterCreate && run.runtimeManifestId === options.manifestId && (await options.afterCreate(run.runId))) {
        throw new HypertestError(
          'precondition_failed',
          `runtime release: runtime ${options.manifestId} was rolled back while run ${run.runId} was being created — the run is quarantined (migrate it with hypertest runtime migrate, or cancel it)`,
          { details: { runId: run.runId, runtimeManifestId: options.manifestId, quarantined: true } },
        );
      }
      return run;
    },
    async resumeRun(runId) {
      const recheck = options.beforeDrive && typeof runId === 'string' && runId !== '' ? options.beforeDrive : undefined;
      // a paused run of a rolled-back release that escaped the rollback's sweep is quarantined (and refused below)
      if (recheck) await recheck(runId);
      const run = await options.getRun(runId);
      if (run?.status === 'paused' && (run.pauseReason === 'quarantined' || run.pauseReason === 'migrating')) throw refusedResume(runId, run);
      await control.resumeRun(runId);
      // the check above and the resume are not one transaction: a rollback whose sweep quarantined the run in between
      // was just undone by the resume — the run is quarantined again (its release is rolled back) and the resume refused
      if (recheck && (await recheck(runId))) {
        const pinned = (await options.getRun(runId))?.runtimeManifestId ?? run?.runtimeManifestId ?? 'unknown';
        throw refusedResume(runId, { pauseReason: 'quarantined', runtimeManifestId: pinned });
      }
    },
  };
}

function refusedResume(runId: string, run: Pick<TestRun, 'pauseReason' | 'runtimeManifestId'>): HypertestError {
  return new HypertestError(
    'precondition_failed',
    run.pauseReason === 'quarantined'
      ? `run ${runId} is quarantined: the runtime release it is pinned to (${run.runtimeManifestId}) was rolled back — migrate it to a good release (hypertest runtime migrate) or cancel it`
      : `run ${runId} is held at the checkpoint of a runtime migration: complete it (hypertest runtime migrate ${runId} --to …), release an abandoned checkpoint (hypertest runtime migrate ${runId} --abort) or cancel the run`,
    { details: { runId, pauseReason: run.pauseReason, runtimeManifestId: run.runtimeManifestId } },
  );
}

// ------------------------------------------------------------------------------------------------ report notes

/** One runtime-release note of a run (quarantine or migration) for its report, from its L0 events. */
export function runtimeReleaseNotes(events: readonly DomainEvent<unknown>[]): Array<{ at: string; detail: string }> {
  const notes: Array<{ at: string; detail: string }> = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.eventType === 'run.quarantined') {
      notes.push({
        at: e.occurredAt,
        detail: `QUARANTINED: runtime release ${String(p['manifestId'])} was rolled back by ${String(p['by'])} (${String(p['reason'])})${p['restoredManifestId'] ? `; the active release is ${String(p['restoredManifestId'])} again` : ''} — the run is paused until it is migrated or cancelled; anything it produced under the rolled-back runtime needs review`,
      });
    } else if (e.eventType === 'run.migrated') {
      notes.push({
        at: e.occurredAt,
        detail: `runtime migration (epoch ${String(p['seq'])}, ${String(p['epochId'])}) by ${String(p['by'])}: ${String(p['fromManifestId'])} → ${String(p['toManifestId'])} (${String(p['reason'])}); checkpoint snapshot ${String(p['snapshotId'])}, ${String(p['statusBefore'])} → ${String(p['statusAfter'])}`,
      });
    } else if (e.eventType === 'run.migration_released') {
      notes.push({
        at: e.occurredAt,
        detail: `abandoned runtime migration: its checkpoint was released by ${String(p['by'])} (${String(p['reason'])}); the run continued on ${String(p['manifestId'])}`,
      });
    } else if (e.eventType === 'run.migration_driven') {
      notes.push({ at: e.occurredAt, detail: `the target runtime ${String(p['manifestId'])} drives the migrated run (epoch ${String(p['seq'])}, ${String(p['epochId'])})` });
    }
  }
  return notes;
}

/** The report with its runtime-release notes: a markdown section, the notes in `recovery` (time order) and `json.runtimeRelease`. */
export function withRuntimeReleaseNotes(report: RunReport, run: TestRun | undefined, notes: ReadonlyArray<{ at: string; detail: string }>): RunReport {
  if (notes.length === 0) return report;
  const quarantined = run?.status === 'paused' && run.pauseReason === 'quarantined';
  const section = ['', '## Runtime release', ...(quarantined ? ['**This run is QUARANTINED**: the runtime release it is pinned to was rolled back.'] : []), ...notes.map((n) => `- ${n.at} ${n.detail}`), ''];
  const recovery = [...report.recovery, ...notes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const json = report.json !== null && typeof report.json === 'object' && !Array.isArray(report.json)
    ? { ...report.json, recovery: JSON.parse(JSON.stringify(recovery)), runtimeRelease: { quarantined, notes: JSON.parse(JSON.stringify(notes)) } }
    : report.json;
  return { ...report, recovery, markdown: `${report.markdown.replace(/\n*$/, '\n')}${section.join('\n')}`, json };
}

// ------------------------------------------------------------------------------------------------ shadow (F[0])

/** Why a dry-run operation was not applied (`not_applied` reason prefix). */
export const DRY_RUN_REASON = 'dry_run';

/**
 * (F[0]) The adapters the SideEffectGateway (and the reconciler) dispatch through, with a DRY-RUN mode for mirrored runs:
 * every operation of a run that `isDryRun` names (a shadow run: label `hypertest.shadow_of`) is prepared without touching
 * the target (desired state = the request, hashed), never dispatched (the receipt is `accepted: false`, so the operation
 * is recorded `not_applied` with reason `dry_run: …` — the ledger keeps what WOULD have been done), observed absent and
 * never compensated. Every other run goes to the real adapter. Every external effect passes the gateway (http writes,
 * environment control, load jobs, fault injection, sandbox egress through the relay), so a shadow run changes nothing
 * outside Hypertest; safe reads are not effects and still happen.
 */
export function shadowDryRunAdapters(inner: AdapterRegistryLike, isDryRun: (runId: string) => Promise<boolean>): AdapterRegistryLike {
  const wrapped = new Map<string, SideEffectAdapter>();
  const reason = (runId: string) => `${DRY_RUN_REASON}: run ${runId} mirrors a production run on a shadow release — external effects are recorded, never dispatched`;
  function wrap(real: SideEffectAdapter): SideEffectAdapter {
    const dry = (op: { operation: { runId: string } }) => isDryRun(op.operation.runId);
    return {
      adapterId: real.adapterId,
      capabilities: real.capabilities,
      async prepare(op, input) {
        if (!(await dry(op))) return real.prepare(op, input);
        const desiredState = { dryRun: true, adapterId: real.adapterId, input: (input ?? null) as JsonValue };
        return { desiredState, desiredStateHash: sha256Hex(canonicalJson(desiredState as unknown as JsonValue)), target: op.operation.target };
      },
      async dispatch(prepared, op) {
        if (!(await dry(op))) return real.dispatch(prepared, op);
        return { accepted: false, notAppliedReason: reason(op.operation.runId) };
      },
      async observe(op) {
        if (!(await dry(op))) return real.observe(op);
        return { state: 'absent' };
      },
      async verify(observation, desiredStateHash, op) {
        if (!(await dry(op))) return real.verify(observation, desiredStateHash, op);
        return { status: 'failed', reason: reason(op.operation.runId) };
      },
      ...(real.compensate
        ? {
            async compensate(op: Parameters<NonNullable<SideEffectAdapter['compensate']>>[0]) {
              if (!(await dry(op))) return real.compensate!(op);
              return { compensated: true, detail: `${DRY_RUN_REASON}: nothing was dispatched` };
            },
          }
        : {}),
    };
  }
  return {
    has: (adapterId) => inner.has(adapterId),
    get(adapterId) {
      const real = inner.get(adapterId);
      let w = wrapped.get(adapterId);
      if (!w || (w as { real?: SideEffectAdapter }).real !== real) {
        w = Object.assign(wrap(real), { real });
        wrapped.set(adapterId, w);
      }
      return w;
    },
  };
}

/** True for a mirrored (shadow) run: it carries `hypertest.shadow_of` (cached per run: labels never change). */
export function shadowRunLookup(getRun: (runId: string) => Promise<TestRun | undefined>): (runId: string) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (runId) => {
    const hit = cache.get(runId);
    if (hit !== undefined) return hit;
    const run = await getRun(runId);
    if (!run) return false; // unknown run: not cached (it may be created later)
    const shadow = typeof run.labels?.[SHADOW_OF_LABEL] === 'string';
    cache.set(runId, shadow);
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
    return shadow;
  };
}

/**
 * (F[0]) The divergences of a mirrored run from the production run it mirrors (empty = equivalent): run outcome, verdict,
 * violated and unknown criteria, human review. Ids, timestamps and evidence differ by construction and are not compared.
 */
export function shadowDivergences(source: { run: TestRun; decision?: QualityDecision }, shadow: { run: TestRun; decision?: QualityDecision }): string[] {
  const out: string[] = [];
  if (source.run.status !== shadow.run.status) out.push(`run status ${source.run.status} → ${shadow.run.status}`);
  const sv = source.decision?.verdict ?? null;
  const tv = shadow.decision?.verdict ?? null;
  if (sv !== tv) out.push(`verdict ${sv ?? 'none'} → ${tv ?? 'none'}`);
  const ids = (d: QualityDecision | undefined, f: 'violatedCriteria' | 'unknownCriteria') => [...new Set((d?.[f] ?? []).map((c) => c.criterionId))].sort();
  for (const f of ['violatedCriteria', 'unknownCriteria'] as const) {
    const a = ids(source.decision, f);
    const b = ids(shadow.decision, f);
    if (a.join(',') !== b.join(',')) out.push(`${f === 'violatedCriteria' ? 'violated' : 'unknown'} criteria [${a.join(', ')}] → [${b.join(', ')}]`);
  }
  if (source.decision && shadow.decision && source.decision.requiresHumanReview !== shadow.decision.requiresHumanReview) {
    out.push(`requiresHumanReview ${source.decision.requiresHumanReview} → ${shadow.decision.requiresHumanReview}`);
  }
  return out;
}

/**
 * (F[1]) The control plane a HANDOVER worker serves on the source runtime's task queue (Temporal) while a migrated run's
 * previous workflow is still open there and no worker of the source runtime polls it: every call about the migrated run
 * is refused `precondition_failed` (non-retryable: that workflow fails and closes — the run itself is untouched and the
 * target runtime starts its own workflow), every other call is `unavailable` (retryable; a run workflow stands by on it),
 * so the workflows of runs still pinned to the source runtime are never failed by the handover.
 */
export function handoverControlPlane(base: ControlPlane, runId: string, toManifestId: string): ControlPlane {
  const refuse = async (first: unknown): Promise<never> => {
    if (first === runId) {
      throw new HypertestError('precondition_failed', `run ${runId} was migrated to runtime ${toManifestId}: its previous workflow is handed over (I11) — the target runtime drives the run`, {
        details: { runId, runtimeManifestId: toManifestId },
      });
    }
    throw new HypertestError('unavailable', 'this worker only hands over a migrated run: the runtime that owns this task queue drives every other run');
  };
  return new Proxy(base, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (prop === 'deps' || typeof v !== 'function') return v;
      return (first: unknown) => refuse(first);
    },
  });
}

/** The deterministic id of the mirror of `sourceRunId` on shadow manifest `manifestId` (a repeated mirror reuses it). */
export function shadowRunId(sourceRunId: string, manifestId: string): string {
  return `${sourceRunId.slice(0, 90)}.shadow-${manifestId.replace(/^rm_/, '').slice(0, 16)}`;
}

/**
 * (F[0], e2e[5]) The manifests an eval SuiteResult's trials ran under: the binding of a compatibility / release-gate result.
 * A trial without a recorded manifest (an infra error before its run existed, a hand-written file) makes it unbindable.
 */
export function evalTrialManifests(result: unknown): { manifestIds: string[]; unbound: string[] } {
  const trials = (result as { trials?: unknown } | null)?.trials;
  if (!Array.isArray(trials)) throw new HypertestError('invalid_argument', 'not an eval suite result (trials)');
  const manifestIds = new Set<string>();
  const unbound: string[] = [];
  trials.forEach((t, i) => {
    const x = (t ?? {}) as { runtimeManifestId?: unknown; taskId?: unknown; armId?: unknown; trial?: unknown };
    if (typeof x.runtimeManifestId === 'string' && x.runtimeManifestId !== '') manifestIds.add(x.runtimeManifestId);
    else unbound.push(typeof x.taskId === 'string' ? `${x.taskId}/${String(x.armId)}#${String(x.trial)}` : `trials[${i}]`);
  });
  return { manifestIds: [...manifestIds].sort(), unbound };
}

// ------------------------------------------------------------------------------------------------ release service

const SETTLED_OPERATIONS: ReadonlySet<OperationStatus> = new Set(['verified', 'not_applied', 'compensated', 'failed']);
const LIVE_STATUSES: TestRun['status'][] = ['created', 'running', 'paused', 'converging', 'gating'];
/** Default wait for a run's in-flight turns to give their claims back after the checkpoint (lease TTL + margin). */
export const DEFAULT_CHECKPOINT_TIMEOUT_MS = 90_000;
const CHECKPOINT_POLL_MS = 200;

export interface ReleaseServiceDeps {
  db: SqlDatabase;
  registry: RuntimeReleaseRegistry;
  manifest: RuntimeManifest;
  runs: RunRepository;
  events: EventStore;
  blackboard: Pick<Blackboard, 'listWorkItems'>;
  leases: Pick<LeaseService, 'current'>;
  ledger: Pick<OperationLedger, 'list'>;
  reconciler: Reconciler;
  agents: Pick<AgentRepository, 'list'>;
  /** The un-governed control plane (snapshot). */
  control: Pick<ControlPlane, 'snapshot'>;
  /** (additive: awaitCompletion, signal — shadow runs and the migration's drive) */
  durable: Pick<DurableRuntime, 'startRun'> & Partial<Pick<DurableRuntime, 'awaitCompletion' | 'signal'>>;
  /** (additive, F[0]) Decisions of mirrored and production runs (shadow comparisons). */
  decisions?: Pick<DecisionRepository, 'get'>;
  /** (additive, F[0]) Starts a run on this runtime (the instance's `start`: preflight, governed admission, durable loop). */
  startRun?: (input: StartRunInput) => Promise<TestRun>;
  /** (additive, F[0]) `runtime.shadow` of the configuration: which production runs a shadow release mirrors. */
  shadow?: ShadowSettings;
  /** (additive, F[1]) How long migrate(drive) waits for this runtime's loop to take the migrated run over (default 30 000). */
  driveTimeoutMs?: number;
  /**
   * (additive, F[1]) Temporal only: serves the SOURCE manifest's task queue for a moment with handoverControlPlane, so a
   * migrated run's previous workflow ends even when no worker of the source runtime is left (closed by the caller).
   */
  handover?: (input: { runId: string; fromManifestId: string; toManifestId: string }) => Promise<{ close(): Promise<void> }>;
  /** Evicts a re-pinned run from the pin cache of this process's pinned control plane. */
  forgetPin: (runId: string) => void;
  clock: { isoNow(): string; nowMs(): number };
  logger: Logger;
}

/** (additive, F[0]) `runtime.shadow`: the production runs a shadow release mirrors and the production-replay threshold. */
export interface ShadowSettings {
  /** Share (0–100) of finished production runs mirrored (deterministic bucket of the run id). */
  percentage?: number;
  /** Runs carrying every one of these labels are mirrored. */
  labels?: Record<string, string>;
  /** Mirrored runs a production replay needs (default 1). A passing production replay has NO diverging mirrored run. */
  minRuns?: number;
  /** How long one mirrored run may take (default 600 000 ms; then it is cancelled and counts as diverged). */
  timeoutMs?: number;
}

/** The default wait for one mirrored run. */
export const DEFAULT_SHADOW_TIMEOUT_MS = 600_000;
/** Default wait of migrate(drive) for the target runtime's loop to take the migrated run over. */
export const DEFAULT_DRIVE_TIMEOUT_MS = 30_000;

/** The rollback a quarantine belongs to: the rolled-back release, its transition, actor and reason, the restored release. */
interface RollbackRef {
  manifestId: string;
  transitionId: string;
  by: string;
  reason: string;
  restoredManifestId?: string;
}

function actorOf(by: unknown, what: string): string {
  if (typeof by !== 'string' || !/^[a-z][a-z0-9_-]*:\S.{0,200}$/.test(by)) throw new HypertestError('invalid_argument', `${what}: by must name the actor as <kind>:<id> (e.g. human:alice), got ${JSON.stringify(by)}`);
  return by;
}

function reasonOf(reason: unknown, what: string): string {
  if (typeof reason !== 'string' || reason.trim() === '') throw new HypertestError('invalid_argument', `${what}: a reason is required`);
  return reason.trim();
}

/** The runtime release service behind `HypertestInstance.releases` and `hypertest runtime …`. */
export function createReleaseService(deps: ReleaseServiceDeps): RuntimeReleaseService {
  const { db, registry, runs, events, logger } = deps;
  const controlStore = new ControlStore(db);

  async function liveRunsOf(manifestId: string): Promise<TestRun[]> {
    return (await runs.list({ status: LIVE_STATUSES })).filter((r) => r.runtimeManifestId === manifestId);
  }

  async function resolve(ref: string): Promise<string> {
    if (typeof ref !== 'string' || ref.trim() === '') throw new HypertestError('invalid_argument', 'a runtime manifest id (or `current`) is required');
    const r = ref.trim();
    if (r === 'current') return deps.manifest.manifestId;
    if (await registry.get(r)) return r;
    const matches = (await registry.list()).map((x) => x.manifestId).filter((id) => id.startsWith(r.startsWith('rm_') ? r : `rm_${r}`));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new HypertestError('invalid_argument', `manifest id prefix ${r} is ambiguous: ${matches.join(', ')}`);
    if (r === deps.manifest.manifestId) return r;
    throw new HypertestError('not_found', `runtime release ${r} is not registered (hypertest runtime list)`, { details: { manifestId: r } });
  }

  async function retireDrained(by: string): Promise<string[]> {
    const retired: string[] = [];
    for (const r of await registry.list({ states: ['retiring'] })) {
      if ((await liveRunsOf(r.manifestId)).length > 0) continue;
      try {
        await registry.retire(r.manifestId, { by, reason: 'no live run is pinned to it any more' });
        retired.push(r.manifestId);
      } catch (e) {
        if (!isHypertestError(e, 'precondition_failed')) throw e; // retired or restored concurrently
      }
    }
    return retired;
  }

  /**
   * Quarantines one live run of a rolled-back release (inside the rollback transaction when `tx` is given): it is paused
   * with pauseReason `quarantined` (a converging/gating/created run goes through `running` first, the only legal path to
   * `paused`) and `run.quarantined` is recorded with what it was before. Already quarantined ⇒ nothing.
   */
  async function quarantine(runId: string, rb: RollbackRef, tx?: SqlExecutor): Promise<boolean> {
    const ctx: EventContext = { runId, correlationId: rb.transitionId, actorId: rb.by };
    if (!(await runs.get(runId))) return false;
    const locked = async (q: SqlExecutor): Promise<boolean> => {
      // the run's lock first (an empty update takes it and returns the run as stored, changing nothing): two quarantines
      // of one run (the rollback's sweep and the creator's re-check) are serialized — the second finds it quarantined
      const cur = await runs.update(runId, {}, ctx, q);
      if (isTerminalRun(cur.status) || cur.runtimeManifestId !== rb.manifestId) return false;
      if (cur.status === 'paused' && cur.pauseReason === 'quarantined') return false;
      if (cur.status === 'paused') await runs.update(runId, { pauseReason: 'quarantined' }, ctx, q);
      else {
        if (cur.status !== 'running') await runs.update(runId, { status: 'running' }, ctx, q);
        await runs.update(runId, { status: 'paused', pauseReason: 'quarantined' }, ctx, q);
      }
      const payload: Record<string, unknown> = { runId, manifestId: rb.manifestId, transitionId: rb.transitionId, previousStatus: cur.status, by: rb.by, reason: rb.reason };
      if (cur.pauseReason !== undefined) payload['previousPauseReason'] = cur.pauseReason;
      if (rb.restoredManifestId !== undefined) payload['restoredManifestId'] = rb.restoredManifestId;
      await events.append([eventFrom(ctx, 'run.quarantined', 'run', runId, payload)], q);
      return true;
    };
    return tx ? locked(tx) : db.transaction(locked);
  }

  function rollbackRef(rb: RollbackResult, by: string, reason: string): RollbackRef {
    const ref: RollbackRef = { manifestId: rb.rolledBack.manifestId, transitionId: rb.transition.transitionId, by, reason };
    if (rb.restored) ref.restoredManifestId = rb.restored.manifestId;
    return ref;
  }

  /** Work items holding a live claim (a turn in flight or about to start): their lease is live with the claim's token. */
  async function liveClaims(runId: string): Promise<string[]> {
    const out: string[] = [];
    for (const w of await deps.blackboard.listWorkItems({ runId, states: ['claimed', 'running'] })) {
      if (!w.claim) continue;
      const lease = await deps.leases.current(workLeaseKey(w.workItemId));
      if (lease && lease.fencingToken === w.claim.fencingToken) out.push(w.workItemId);
    }
    return out;
  }

  async function sourceManifest(manifestId: string): Promise<RuntimeManifest | undefined> {
    return (await registry.get(manifestId))?.manifest ?? (await controlStore.getManifest(manifestId));
  }

  async function usedEngines(runId: string): Promise<string[]> {
    return [...new Set((await deps.agents.list({ runId })).map((a) => a.engineKind))].sort();
  }

  function refuseIncompatible(checks: ReturnType<typeof runtimeCompatibility>, runId: string, to: string): void {
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      throw new HypertestError('precondition_failed', `run ${runId} cannot be migrated to ${to}: ${failed.map((c) => `${c.check}: ${c.detail}`).join('; ')}`, {
        details: { runId, to, compatibility: failed },
      });
    }
  }

  /** The status the run returns to after the re-pin (never lifting a pause that belongs to other governance). */
  async function statusAfter(run: TestRun): Promise<{ status: 'running' } | { status: 'paused'; pauseReason: NonNullable<TestRun['pauseReason']> }> {
    if (run.status !== 'paused' || run.pauseReason === 'migrating') return { status: 'running' };
    if (run.pauseReason === 'quarantined') {
      const q = (await events.read(run.runId, { types: ['run.quarantined'] })).at(-1);
      const p = (q?.payload ?? {}) as Record<string, unknown>;
      const prev = p['previousPauseReason'];
      if (p['previousStatus'] === 'paused' && typeof prev === 'string' && prev !== 'quarantined' && prev !== 'migrating') return { status: 'paused', pauseReason: prev as NonNullable<TestRun['pauseReason']> };
      return { status: 'running' };
    }
    return { status: 'paused', pauseReason: run.pauseReason ?? 'operator' };
  }

  /** Whether this runtime's loop took over epoch `epochId` of the run (`run.migration_driven`, any process). */
  async function drivenEvent(runId: string, epochId: string): Promise<boolean> {
    return (await events.read(runId, { types: ['run.migration_driven'] })).some((e) => (e.payload as { epochId?: unknown } | null)?.epochId === epochId);
  }

  /**
   * (F[1]) Starts this runtime's durable loop on a migrated run and waits until the loop really drives it — its first
   * `recover` records `run.migration_driven` for the epoch (onDrive → markDriven, in whichever process the loop runs). A
   * durable runtime whose previous loop of the run is still open (Temporal: the run workflow on the SOURCE manifest's task
   * queue — startRun of the same workflow id is then a no-op) is woken (its next tick on a worker of the source runtime is
   * refused by the pin and ends it) and startRun is retried until the deadline. Never reports a drive that did not happen.
   */
  async function driveMigrated(runId: string, epoch: RuntimeEpoch, fromManifestId: string, timeoutMs: number, signal: AbortSignal): Promise<{ driven: boolean; problem?: string }> {
    const deadline = deps.clock.nowMs() + Math.max(0, timeoutMs);
    let handover: { close(): Promise<void> } | undefined;
    let handoverProblem: string | undefined;
    try {
      for (let attempt = 1; ; attempt++) {
        await deps.durable.startRun(runId);
        const until = Math.min(deadline, deps.clock.nowMs() + 2000);
        while (deps.clock.nowMs() < until) {
          if (await drivenEvent(runId, epoch.epochId)) return { driven: true };
          if (signal.aborted) break;
          await sleep(100);
        }
        if (await drivenEvent(runId, epoch.epochId)) return { driven: true };
        if (signal.aborted || deps.clock.nowMs() >= deadline) break;
        // the previous loop of the run may still be open: wake it so its next tick (refused: the run is pinned here now)
        // ends it; when no worker of the source runtime is left to run that tick, serve its queue for the handover
        if (attempt >= 2 && !handover && !handoverProblem && deps.handover) {
          try {
            handover = await deps.handover({ runId, fromManifestId, toManifestId: deps.manifest.manifestId });
            logger.info('serving the source runtime\'s task queue to hand the migrated run\'s previous workflow over', { runId, fromManifestId });
          } catch (e) {
            handoverProblem = (e as Error).message;
          }
        }
        if (deps.durable.signal) await deps.durable.signal(runId, { type: 'wake' }).catch(() => undefined);
        if (attempt % 5 === 0) logger.info('waiting for the previous durable loop of the migrated run to close', { runId, attempt });
      }
    } finally {
      if (handover) await handover.close().catch((e: unknown) => logger.warn('the handover worker could not be stopped cleanly', { runId, error: (e as Error).message }));
    }
    return {
      driven: false,
      problem: `run ${runId} was re-pinned to ${deps.manifest.manifestId} (epoch ${epoch.seq}) but this runtime's durable loop did not take it over within ${timeoutMs} ms: its previous loop is probably still open (Temporal: workflow run-${runId} on the task queue of ${fromManifestId}${handoverProblem ? `; the handover worker could not start: ${handoverProblem}` : ''}; it ends at its next tick on a worker of that runtime — otherwise terminate it, e.g. \`temporal workflow terminate --workflow-id run-${runId}\`) — then run \`hypertest resume\` on this runtime`,
    };
  }

  const service: RuntimeReleaseService = {
    registry,
    resolve,

    async markDriven(runId) {
      if (typeof runId !== 'string' || runId === '') return false;
      const last = (await registry.epochs(runId)).at(-1);
      if (!last || last.toManifestId !== deps.manifest.manifestId) return false;
      if (await drivenEvent(runId, last.epochId)) return false;
      const ctx: EventContext = { runId, correlationId: last.epochId, actorId: 'system:hypertest' };
      return db.transaction(async (tx) => {
        // under the run's lock: two loops recovering the run at once record one event
        await runs.update(runId, {}, ctx, tx);
        const seen = (await events.read(runId, { types: ['run.migration_driven'] })).some((e) => (e.payload as { epochId?: unknown } | null)?.epochId === last.epochId);
        if (seen) return false;
        await events.append([eventFrom(ctx, 'run.migration_driven', 'run', runId, { runId, epochId: last.epochId, seq: last.seq, manifestId: deps.manifest.manifestId })], tx);
        return true;
      });
    },

    async list() {
      await retireDrained('system:hypertest');
      const pointer = await registry.activePointer();
      const live = await runs.list({ status: LIVE_STATUSES });
      const views: RuntimeReleaseView[] = (await registry.list()).map((r) => ({
        ...r,
        active: pointer?.manifestId === r.manifestId,
        current: r.manifestId === deps.manifest.manifestId,
        liveRuns: live.filter((x) => x.runtimeManifestId === r.manifestId).length,
      }));
      return views;
    },

    async register(input) {
      const by = actorOf(input?.by, 'register');
      const allowed: SchemaMigrationAllowance[] = input.allowedMigrations ?? [];
      return registry.register(input.manifest ?? deps.manifest, { by, allowedMigrations: allowed });
    },

    async recordSuite(input: RecordSuiteInput): Promise<CompatibilitySuiteResult> {
      actorOf(input?.by, 'record-suite');
      return registry.recordSuiteResult(input);
    },

    async promote(manifestId, input) {
      const by = actorOf(input?.by, 'promote');
      const reason = reasonOf(input.reason, 'promote');
      const id = await resolve(manifestId);
      const promotion: { by: string; reason: string; canary?: CanarySelection } = { by, reason };
      if (input.canary !== undefined) promotion.canary = input.canary;
      const result: PromotionResult = await registry.promote(id, promotion);
      const retired = await retireDrained(by);
      return { ...result, retired };
    },

    async rollback(input) {
      const by = actorOf(input?.by, 'rollback');
      const reason = reasonOf(input.reason, 'rollback');
      const target = input.manifestId !== undefined ? await resolve(input.manifestId) : undefined;
      // the pointer move and the quarantine of the rolled-back release's live runs commit together
      const { rb, quarantined } = await db.transaction(async (tx) => {
        const rb = await registry.rollback({ by, reason, ...(target !== undefined ? { manifestId: target } : {}) }, tx);
        const ref = rollbackRef(rb, by, reason);
        const quarantined: string[] = [];
        for (const run of await liveRunsOf(rb.rolledBack.manifestId)) if (await quarantine(run.runId, ref, tx)) quarantined.push(run.runId);
        return { rb, quarantined };
      });
      // a run the rolled-back runtime created while the rollback committed is caught by a second sweep (idempotent); one
      // committed after this sweep is caught by its creator's re-check (quarantineIfRolledBack, releaseGovernedControlPlane)
      const ref = rollbackRef(rb, by, reason);
      for (const run of await liveRunsOf(rb.rolledBack.manifestId)) if (await quarantine(run.runId, ref)) quarantined.push(run.runId);
      logger.warn('runtime release rolled back; its live runs are quarantined', { manifestId: rb.rolledBack.manifestId, restored: rb.restored?.manifestId, quarantined });
      return { ...rb, quarantined };
    },

    async quarantineIfRolledBack(runId) {
      if (typeof runId !== 'string' || runId.trim() === '') throw new HypertestError('invalid_argument', 'quarantineIfRolledBack: runId is required');
      const run = await runs.get(runId);
      if (!run || isTerminalRun(run.status)) return false;
      const release = await registry.get(run.runtimeManifestId);
      if (!release?.rolledBack) return false;
      // the rollback that retired the release (its actor and reason are the quarantine's)
      const t = (await registry.history(release.manifestId)).filter((x) => x.action === 'rollback').at(-1);
      if (!t) throw new HypertestError('integrity_violation', `runtime release ${release.manifestId} is rolled back but its rollback transition is missing`, { details: { manifestId: release.manifestId } });
      const ref: RollbackRef = { manifestId: release.manifestId, transitionId: t.transitionId, by: t.actor, reason: t.reason ?? 'rolled back' };
      const restored = t.details['restored'];
      if (typeof restored === 'string') ref.restoredManifestId = restored;
      const done = await quarantine(runId, ref);
      if (done) logger.warn('a run created while its runtime release was rolled back is quarantined', { runId, manifestId: release.manifestId, transitionId: t.transitionId });
      return done;
    },

    async migrate(runId: string, input: MigrateRunInput): Promise<RunMigrationResult> {
      const by = actorOf(input?.by, 'migrate');
      const reason = reasonOf(input.reason, 'migrate');
      const timeoutMs = input.checkpointTimeoutMs ?? DEFAULT_CHECKPOINT_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new HypertestError('invalid_argument', 'migrate: checkpointTimeoutMs must be ≥ 0');
      const signal = input.signal ?? new AbortController().signal;
      const to = await resolve(input.to);
      const run0 = await runs.get(runId);
      if (!run0) throw new HypertestError('not_found', `run ${runId} not found`);
      if (isTerminalRun(run0.status)) throw new HypertestError('precondition_failed', `run ${runId} is ${run0.status}: only a live run is migrated`, { details: { runId, status: run0.status } });
      if (run0.status !== 'running' && run0.status !== 'paused') {
        throw new HypertestError('precondition_failed', `run ${runId} is ${run0.status}: migrate a running or paused run (let it finish its ${run0.status} step first)`, { details: { runId, status: run0.status } });
      }
      const target: RuntimeRelease | undefined = await registry.get(to);
      if (!target) throw new HypertestError('not_found', `runtime release ${to} is not registered`, { details: { manifestId: to } });
      const source = await sourceManifest(run0.runtimeManifestId);
      if (!source) throw new HypertestError('precondition_failed', `run ${runId} is pinned to manifest ${run0.runtimeManifestId}, which is not stored: it cannot be checked for compatibility`, { details: { runId } });
      // refuse early (nothing touched) when the target can never take the run
      refuseIncompatible(runtimeCompatibility(source, target, { usedEngines: await usedEngines(runId) }), runId, to);

      const ctx: EventContext = { runId, correlationId: `migrate:${runId}:${to}`, actorId: by };
      // 1 checkpoint: pause (in-flight turns finish and give their claims back; nothing new is dispatched). Decided under
      // the run's lock on the run as it is NOW: a pause of an already paused run would only overwrite its pause reason —
      // a quarantine or operator pause that committed after run0 was read would be lost (and resumed by a failed migration)
      const checkpoint = await db.transaction(async (tx) => {
        const cur = await runs.update(runId, {}, ctx, tx);
        if (cur.runtimeManifestId !== run0.runtimeManifestId) throw new HypertestError('conflict', `run ${runId} was re-pinned to ${cur.runtimeManifestId} concurrently`, { details: { runId } });
        if (cur.status === 'running') return { statusBefore: cur.status, pausedHere: true, pauseReason: (await runs.update(runId, { status: 'paused', pauseReason: 'migrating' }, ctx, tx)).pauseReason };
        if (cur.status === 'paused') return { statusBefore: cur.status, pausedHere: false, pauseReason: cur.pauseReason };
        throw new HypertestError('precondition_failed', `run ${runId} is ${cur.status}: migrate a running or paused run`, { details: { runId, status: cur.status } });
      });
      let pausedHere = checkpoint.pausedHere;
      try {
        const deadline = deps.clock.nowMs() + timeoutMs;
        for (;;) {
          const held = await liveClaims(runId);
          if (held.length === 0) break;
          if (signal.aborted) throw new HypertestError('cancelled', `migration of run ${runId} aborted at the checkpoint`);
          if (deps.clock.nowMs() >= deadline) {
            throw new HypertestError('timeout', `run ${runId} did not reach a checkpoint within ${timeoutMs} ms: work items ${held.join(', ')} still hold live claims (their turns are running)`, { details: { runId, workItems: held } });
          }
          await sleep(CHECKPOINT_POLL_MS);
        }
        // 2 the canonical snapshot of the checkpoint (under the source manifest)
        const snapshot = await deps.control.snapshot(runId);
        // 3 operation reconciliation: every external effect of the run must be settled before another runtime takes it
        const rec = await deps.reconciler.reconcile({ runId }, signal);
        const unsettled = (await deps.ledger.list({ runId })).filter((op) => !SETTLED_OPERATIONS.has(op.status));
        if (unsettled.length > 0) {
          throw new HypertestError('precondition_failed', `run ${runId} has unsettled operations (${unsettled.map((op) => `${op.operationId} ${op.status}`).join(', ')}): settle them (resume the run on its runtime, or resolve manual reviews) before migrating`, {
            details: { runId, operations: unsettled.map((op) => ({ operationId: op.operationId, status: op.status })) },
          });
        }
        // (item 17) an item waiting ONLY on a model pause (`model:<agentId>`) holds no turn in flight and no external effect:
        // it migrates, its pause (ht_model_pauses, keyed by its session) carries over to the new epoch; every other wait
        // (operations, children, approvals) must settle first
        const waitingItems = await deps.blackboard.listWorkItems({ runId, states: ['waiting'] });
        const modelPaused = waitingItems.filter((w) => w.waitingOn.length > 0 && w.waitingOn.every((x) => x.startsWith('model:')));
        const waiting = waitingItems.filter((w) => !modelPaused.includes(w));
        if (waiting.length > 0) {
          throw new HypertestError('precondition_failed', `run ${runId} has work items waiting on operations or children (${waiting.map((w) => `${w.workItemId} on ${w.waitingOn.join('+') || '?'}`).join(', ')}): let them settle before migrating`, {
            details: { runId, workItems: waiting.map((w) => w.workItemId) },
          });
        }
        const carriedModelPauses = modelPaused.map((w) => w.workItemId).sort();
        // 4 compatibility, with the engines the run's agents actually used by now (refuse before the transaction)
        refuseIncompatible(runtimeCompatibility(source, (await registry.get(to))!, { usedEngines: await usedEngines(runId) }), runId, to);
        // the pause that holds the checkpoint: the migration's own, or the one the run already had (a rollback of the
        // source release may turn either into `quarantined` meanwhile — the migration off it is the remedy)
        const heldBy = checkpoint.pauseReason;
        // 5 compatibility again + re-pin + RuntimeEpoch + run.migrated + resume, in one transaction
        const result = await db.transaction(async (tx) => {
          // the registry's lock first, then the target as it is now: no rollback or promotion of the target can commit
          // between this check and the re-pin (a rollback committing after it finds the re-pinned run in its sweep and
          // quarantines it). Lock order as the rollback's: registry lock, then run locks.
          await registry.lock(tx);
          const targetNow = await registry.get(to, tx);
          if (!targetNow) throw new HypertestError('not_found', `runtime release ${to} is not registered`, { details: { manifestId: to } });
          const checks = runtimeCompatibility(source, targetNow, { usedEngines: await usedEngines(runId) });
          refuseIncompatible(checks, runId, to);
          // the run's locks in the repository's order (run lock, then its row): an empty update takes them and changes
          // nothing, so a concurrent status change of the run can never deadlock with this transaction
          await runs.update(runId, {}, ctx, tx);
          const row = (await tx.query<{ run: unknown }>('SELECT run FROM ht_runs WHERE run_id = $1 FOR UPDATE', [runId])).rows[0];
          const cur = row ? (typeof row.run === 'string' ? JSON.parse(row.run) : row.run) as TestRun : undefined;
          if (!cur) throw new HypertestError('not_found', `run ${runId} not found`);
          if (cur.runtimeManifestId !== source.manifestId) throw new HypertestError('conflict', `run ${runId} was re-pinned to ${cur.runtimeManifestId} concurrently`, { details: { runId } });
          if (cur.status !== 'paused') throw new HypertestError('conflict', `run ${runId} left its checkpoint (now ${cur.status}) during the migration`, { details: { runId, status: cur.status } });
          // resumed and paused again meanwhile (another pause): it ran after the snapshot, which no longer is its checkpoint
          if (cur.pauseReason !== heldBy && cur.pauseReason !== 'quarantined') {
            throw new HypertestError('conflict', `run ${runId} left its checkpoint during the migration (paused ${String(cur.pauseReason)}, not ${String(heldBy)}): migrate it again`, {
              details: { runId, pauseReason: cur.pauseReason ?? null, expected: heldBy ?? null },
            });
          }
          const held = await liveClaims(runId);
          if (held.length > 0) throw new HypertestError('conflict', `work items ${held.join(', ')} took a claim during the migration`, { details: { runId, workItems: held } });
          const now = deps.clock.isoNow();
          const after = await statusAfter(cur);
          await controlStore.putManifest(targetNow.manifest, now, tx);
          // a model-paused item that settled meanwhile is not carried; one that started waiting on something else refuses
          const stillWaiting = await deps.blackboard.listWorkItems({ runId, states: ['waiting'] });
          const otherWait = stillWaiting.filter((w) => !(w.waitingOn.length > 0 && w.waitingOn.every((x) => x.startsWith('model:'))));
          if (otherWait.length > 0) throw new HypertestError('conflict', `work items ${otherWait.map((w) => w.workItemId).join(', ')} started waiting on operations or children during the migration`, { details: { runId } });
          const carried = carriedModelPauses.filter((id) => stillWaiting.some((w) => w.workItemId === id));
          const epoch: RuntimeEpoch = await registry.recordEpoch(
            {
              runId, fromManifestId: source.manifestId, toManifestId: to, snapshotId: snapshot.snapshotId,
              reconciliation: { examined: rec.examined, verified: rec.verified, notApplied: rec.notApplied, manualReview: rec.manualReview, stillPending: rec.stillPending, failed: rec.failed ?? [] },
              compatibility: checks, statusBefore: checkpoint.statusBefore, statusAfter: after.status, migratedBy: by, reason,
              ...(carried.length > 0 ? { carriedModelPauses: carried } : {}),
            },
            tx,
          );
          const repinned: TestRun = JSON.parse(JSON.stringify({ ...cur, runtimeManifestId: to, updatedAt: now }));
          await tx.query('UPDATE ht_runs SET run = $2::jsonb, updated_at = $3 WHERE run_id = $1', [runId, JSON.stringify(repinned), now]);
          await events.append(
            [
              eventFrom({ ...ctx, correlationId: epoch.epochId }, 'run.migrated', 'run', runId, {
                runId, epochId: epoch.epochId, seq: epoch.seq, fromManifestId: source.manifestId, toManifestId: to, snapshotId: snapshot.snapshotId,
                reconciliation: epoch.reconciliation, compatibility: checks, statusBefore: checkpoint.statusBefore, statusAfter: after.status, by, reason,
                ...(carried.length > 0 ? { carriedModelPauses: carried } : {}),
              }),
            ],
            tx,
          );
          const resumed = after.status === 'running'
            ? await runs.update(runId, { status: 'running' }, { ...ctx, correlationId: epoch.epochId }, tx)
            : await runs.update(runId, { pauseReason: after.pauseReason }, { ...ctx, correlationId: epoch.epochId }, tx);
          return { epoch, run: resumed };
        });
        pausedHere = false;
        deps.forgetPin(runId);
        let driven = false;
        let driveProblem: string | undefined;
        if (input.drive === true && to === deps.manifest.manifestId && result.run.status === 'running') {
          const d = await driveMigrated(runId, result.epoch, source.manifestId, input.driveTimeoutMs ?? deps.driveTimeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS, signal);
          driven = d.driven;
          if (d.problem) driveProblem = d.problem;
        }
        logger.info('run migrated to another runtime release', { runId, from: source.manifestId, to, epochId: result.epoch.epochId, status: result.run.status, driven });
        if (driveProblem) logger.warn('the migrated run is not driven by this runtime yet', { runId, problem: driveProblem });
        return { ...result, driven, ...(driveProblem ? { driveProblem } : {}) };
      } catch (e) {
        // the checkpoint this migration took is released: the run continues where it was, on its own runtime
        if (pausedHere) {
          try {
            // under the run's lock: a quarantine (or any other pause) that replaced the checkpoint meanwhile is kept
            await db.transaction(async (tx) => {
              const cur = await runs.update(runId, {}, ctx, tx);
              if (cur.status === 'paused' && cur.pauseReason === 'migrating' && cur.runtimeManifestId === run0.runtimeManifestId) await runs.update(runId, { status: 'running' }, ctx, tx);
            });
          } catch (restore) {
            logger.error('could not release the migration checkpoint of the run; it stays paused (migrating)', { runId, error: (restore as Error).message });
          }
        }
        throw e;
      }
    },

    async releaseCheckpoint(runId, input) {
      const by = actorOf(input?.by, 'release-checkpoint');
      const reason = reasonOf(input.reason, 'release-checkpoint');
      if (typeof runId !== 'string' || runId.trim() === '') throw new HypertestError('invalid_argument', 'release-checkpoint: runId is required');
      if (!(await runs.get(runId))) throw new HypertestError('not_found', `run ${runId} not found`);
      // a checkpoint of a run whose release was rolled back is never released onto that runtime: the run is quarantined
      if (await service.quarantineIfRolledBack(runId)) {
        throw new HypertestError('precondition_failed', `run ${runId} is quarantined: the runtime release it is pinned to was rolled back — migrate it to a good release or cancel it`, {
          details: { runId, pauseReason: 'quarantined' },
        });
      }
      const ctx: EventContext = { runId, correlationId: `migrate-abort:${runId}`, actorId: by };
      const released = await db.transaction(async (tx) => {
        // under the run's lock: a migration of the run committing concurrently is either seen (re-pinned and resumed:
        // nothing to release) or fails afterwards (the run left its checkpoint)
        const cur = await runs.update(runId, {}, ctx, tx);
        if (cur.status !== 'paused' || cur.pauseReason !== 'migrating') {
          throw new HypertestError('precondition_failed', `run ${runId} is ${cur.status}${cur.pauseReason ? ` (${cur.pauseReason})` : ''}: only a run held at a migration checkpoint (paused migrating) is released`, {
            details: { runId, status: cur.status, pauseReason: cur.pauseReason ?? null },
          });
        }
        await events.append([eventFrom(ctx, 'run.migration_released', 'run', runId, { runId, manifestId: cur.runtimeManifestId, by, reason })], tx);
        return runs.update(runId, { status: 'running' }, ctx, tx);
      });
      logger.warn('the checkpoint of an abandoned runtime migration was released; the run continues on its own runtime', { runId, manifestId: released.runtimeManifestId, by });
      return released;
    },

    epochs(runId) {
      return registry.epochs(runId);
    },

    // ---------------------------------------------------------------------------------------------- (F[0]) stage gates

    async recordEvalSuite(input) {
      const by = actorOf(input?.by, 'record-suite');
      const manifestId = await resolve(input.manifestId);
      if (input.kind !== 'compatibility') throw new HypertestError('invalid_argument', `recordEvalSuite: an eval SuiteResult records a compatibility result (the release gate: recordReleaseGate), not ${String(input.kind)}`);
      const doc = input.result as { suiteId?: unknown; revision?: unknown; trials?: unknown } | null;
      if (!doc || typeof doc.suiteId !== 'string' || !Array.isArray(doc.trials)) throw new HypertestError('invalid_argument', 'recordEvalSuite: not an eval suite result (suiteId, trials)');
      const trials = doc.trials as Array<{ result?: unknown }>;
      const failed = trials.filter((t) => t?.result !== 'pass').length;
      const { manifestIds, unbound } = evalTrialManifests(doc);
      const bound = unbound.length === 0 && manifestIds.length === 1 && manifestIds[0] === manifestId;
      const passed = trials.length > 0 && failed === 0;
      if (passed && !bound) {
        throw new HypertestError('precondition_failed', `the eval result does not certify ${manifestId}: ${unbound.length > 0 ? `trials without a recorded runtime manifest (${unbound.slice(0, 5).join(', ')})` : `its trials ran under ${manifestIds.join(', ') || 'no manifest'}`} — run the suite on this runtime (eval run --arms deployment) and record that result`, {
          details: { manifestId, trialManifests: manifestIds, unbound },
        });
      }
      const record: RecordSuiteInput = {
        manifestId, kind: 'compatibility', suiteId: doc.suiteId, passed, by,
        summary: { total: trials.length, failed, ...(input.detail ? { detail: input.detail } : {}) },
        reportDigest: input.digest,
        ...(typeof doc.revision === 'string' && doc.revision !== '' ? { suiteRevision: doc.revision } : {}),
        ...(bound ? { binding: { kind: 'eval_trials' as const, manifestIds } } : {}),
      };
      return registry.recordSuiteResult(record);
    },

    async recordReleaseGate(input) {
      const by = actorOf(input?.by, 'record-suite');
      const manifestId = await resolve(input.manifestId);
      const doc = input.candidate as { suiteId?: unknown; revision?: unknown; trials?: unknown } | null;
      if (!doc || typeof doc.suiteId !== 'string' || !Array.isArray(doc.trials)) throw new HypertestError('invalid_argument', 'recordReleaseGate: the candidate is not an eval suite result (suiteId, trials)');
      // F[13]: every runtime release runs the CORE eval — no other suite opens canary → active
      if (doc.suiteId !== RELEASE_GATE_SUITE_ID) {
        throw new HypertestError('precondition_failed', `the release gate runs the core eval: candidate suite ${JSON.stringify(doc.suiteId)} does not count (eval run ${RELEASE_GATE_SUITE_ID} …)`, { details: { suiteId: doc.suiteId } });
      }
      const report = input.report;
      if (!report || typeof report.pass !== 'boolean' || report.suiteId !== doc.suiteId) throw new HypertestError('invalid_argument', 'recordReleaseGate: the gate report does not belong to the candidate (suiteId, pass)');
      const { manifestIds, unbound } = evalTrialManifests(doc);
      if (unbound.length > 0 || manifestIds.length !== 1 || manifestIds[0] !== manifestId) {
        throw new HypertestError('precondition_failed', `the core eval candidate does not certify ${manifestId}: ${unbound.length > 0 ? `trials without a recorded runtime manifest (${unbound.slice(0, 5).join(', ')})` : `its trials ran under ${manifestIds.join(', ') || 'no manifest'}`} — run the core eval on this runtime (eval run core --arms deployment)`, {
          details: { manifestId, trialManifests: manifestIds, unbound },
        });
      }
      for (const [k, v] of [['candidateDigest', input.candidateDigest], ['baselineDigest', input.baselineDigest]] as const) {
        if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new HypertestError('invalid_argument', `recordReleaseGate: ${k} must be a sha256 hex digest`);
      }
      const trials = doc.trials as Array<{ result?: unknown }>;
      const failedTrials = trials.filter((t) => t?.result !== 'pass').length;
      const failedChecks = (report.checks ?? []).filter((c) => !c.pass).map((c) => c.checkId);
      const passed = report.pass && trials.length > 0 && failedTrials === 0;
      const detail = [failedTrials > 0 ? `${failedTrials} candidate trial(s) did not pass` : '', failedChecks.length > 0 ? `gate checks failed: ${failedChecks.join(', ')}` : ''].filter(Boolean).join('; ') || 'every check and trial passed';
      return registry.recordSuiteResult({
        manifestId, kind: 'release_gate', suiteId: doc.suiteId, passed, by,
        ...(typeof doc.revision === 'string' && doc.revision !== '' ? { suiteRevision: doc.revision } : {}),
        summary: { total: trials.length, failed: passed ? 0 : Math.max(1, failedTrials), detail },
        reportDigest: sha256Hex(canonicalJson(report as unknown as JsonValue)),
        binding: { kind: 'eval_gate', manifestIds, candidateDigest: input.candidateDigest, baselineDigest: input.baselineDigest },
      });
    },

    async mirror(sourceRunId, input) {
      const by = actorOf(input?.by, 'shadow');
      if (!deps.startRun || !deps.decisions || !deps.durable.awaitCompletion) throw new HypertestError('unsupported', 'this instance cannot mirror runs (no run starter / decisions / durable completion)');
      const manifestId = deps.manifest.manifestId;
      const release = await registry.get(manifestId);
      if (!release || release.state !== 'shadow' || release.rolledBack) {
        throw new HypertestError('precondition_failed', `this runtime (${manifestId}) is ${release ? `a ${release.state}${release.rolledBack ? ' (rolled back)' : ''} release` : 'not a registered release'}: only a shadow release mirrors production runs`, {
          details: { manifestId, state: release?.state ?? null },
        });
      }
      const source = await runs.get(sourceRunId);
      if (!source) throw new HypertestError('not_found', `run ${sourceRunId} not found`);
      if (typeof source.labels?.[SHADOW_OF_LABEL] === 'string') throw new HypertestError('precondition_failed', `run ${sourceRunId} is itself a shadow run: mirror production runs only`);
      if (source.runtimeManifestId === manifestId) throw new HypertestError('precondition_failed', `run ${sourceRunId} ran on this shadow release: mirror runs of the production (active) release`);
      if (!isTerminalRun(source.status)) throw new HypertestError('precondition_failed', `run ${sourceRunId} is ${source.status}: mirror a finished production run (its decision is the reference)`, { details: { runId: sourceRunId, status: source.status } });
      const existing = (await registry.shadowComparisons(manifestId)).find((c) => c.sourceRunId === sourceRunId);
      if (existing) return { comparison: existing, shadowRunId: existing.shadowRunId, created: false };
      const id = shadowRunId(sourceRunId, manifestId);
      let shadow = await runs.get(id);
      if (!shadow) {
        shadow = await deps.startRun({
          runId: id, goal: source.goal, target: source.target, budget: { ...source.budget },
          labels: { ...source.labels, [SHADOW_OF_LABEL]: sourceRunId, 'hypertest.shadow_manifest': manifestId },
          ...(Object.keys(source.oracleRevisions).length > 0 ? { oracleIds: Object.keys(source.oracleRevisions).sort() } : {}),
        });
      } else if (!isTerminalRun(shadow.status)) {
        await deps.durable.startRun(id); // a mirror interrupted by a restart continues
      }
      const timeoutMs = input.timeoutMs ?? deps.shadow?.timeoutMs ?? DEFAULT_SHADOW_TIMEOUT_MS;
      let timedOut = false;
      try {
        await deps.durable.awaitCompletion(id, { timeoutMs });
      } catch (e) {
        if (!isHypertestError(e, 'timeout')) throw e;
        timedOut = true;
        await deps.durable.signal?.(id, { type: 'cancel', reason: `shadow mirror did not finish within ${timeoutMs} ms` }).catch(() => undefined);
      }
      const shadowNow = (await runs.get(id))!;
      const decisionOf = async (r: TestRun) => (r.decisionId ? deps.decisions!.get(r.decisionId) : undefined);
      const sourceDecision = await decisionOf(source);
      const shadowDecision = await decisionOf(shadowNow);
      const divergences = shadowDivergences({ run: source, ...(sourceDecision ? { decision: sourceDecision } : {}) }, { run: shadowNow, ...(shadowDecision ? { decision: shadowDecision } : {}) });
      if (timedOut) divergences.unshift(`the shadow run did not finish within ${timeoutMs} ms (cancelled)`);
      const comparison = await registry.recordShadowComparison({
        manifestId, sourceRunId, sourceManifestId: source.runtimeManifestId, shadowRunId: id,
        sourceVerdict: sourceDecision?.verdict ?? null, shadowVerdict: shadowDecision?.verdict ?? null, divergences, recordedBy: by,
      });
      logger.info('production run mirrored on the shadow release', { sourceRunId, shadowRunId: id, diverged: comparison.diverged });
      return { comparison, shadowRunId: id, created: true };
    },

    async shadowCandidates(input = {}) {
      const manifestId = deps.manifest.manifestId;
      const pointer = await registry.activePointer();
      if (!pointer) return [];
      const mirrored = new Set((await registry.shadowComparisons(manifestId)).map((c) => c.sourceRunId));
      const selection = deps.shadow ?? {};
      const hasSelection = (selection.percentage ?? 0) > 0 || Object.keys(selection.labels ?? {}).length > 0;
      const finished = await runs.list({ status: ['completed', 'failed', 'cancelled'] });
      return finished
        .filter((r) => r.runtimeManifestId === pointer.manifestId && typeof r.labels?.[SHADOW_OF_LABEL] !== 'string' && !mirrored.has(r.runId) && r.decisionId !== undefined)
        .filter((r) => !hasSelection || canarySelects({ ...(selection.percentage !== undefined ? { percentage: selection.percentage } : {}), ...(selection.labels ? { labels: selection.labels } : {}) }, { runId: r.runId, labels: r.labels }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, input.limit ?? 10)
        .map((r) => r.runId);
    },

    async recordProductionReplay(input) {
      const by = actorOf(input?.by, 'record-suite');
      const manifestId = await resolve(input.manifestId ?? 'current');
      const comparisons: ShadowComparison[] = await registry.shadowComparisons(manifestId);
      const minRuns = input.minRuns ?? deps.shadow?.minRuns ?? 1;
      if (!Number.isSafeInteger(minRuns) || minRuns < 1) throw new HypertestError('invalid_argument', 'production replay: minRuns must be an integer ≥ 1');
      // fail closed: one diverging mirrored run fails the production replay (a divergence is explained by a fix, not a quota)
      const diverged = comparisons.filter((c) => c.diverged).length;
      const passed = comparisons.length >= minRuns && diverged === 0;
      const detail = comparisons.length < minRuns
        ? `${comparisons.length} mirrored run(s), ${minRuns} required (hypertest runtime shadow on the shadow release)`
        : `${diverged}/${comparisons.length} mirrored run(s) diverged${diverged > 0 ? `: ${comparisons.filter((c) => c.diverged).slice(0, 3).map((c) => `${c.sourceRunId} ${c.divergences.join(', ')}`).join('; ')}` : ''}`;
      return registry.recordSuiteResult({
        manifestId, kind: 'production_replay', suiteId: 'shadow-mirror', passed, by,
        summary: { total: comparisons.length, failed: diverged, detail: detail.slice(0, 2000) },
        binding: { kind: 'shadow_comparisons', comparisonIds: comparisons.map((c) => c.comparisonId) },
      });
    },
  };
  return service;
}
