import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HypertestError, isHypertestError, sleep, type Logger, type SqlDatabase } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER, eventFrom, isTerminalRun, type DataClassification, type DomainEvent, type EventContext, type OperationStatus, type RuntimeEpoch, type RuntimeManifest,
  type TestRun,
} from '@hypertest/domain';
import type { Blackboard, EventStore, RunRepository } from '@hypertest/collab';
import type { LeaseService, OperationLedger, Reconciler } from '@hypertest/operation';
import type { ModelRouter } from '@hypertest/model';
import {
  GIT_SHA_RE, IMAGE_DIGEST_RE, runtimeCompatibility, type AgentRepository, type CanarySelection, type CompatibilitySuiteResult, type PromotionResult, type RecordSuiteInput,
  type RollbackResult, type RuntimeRelease, type RuntimeReleaseRegistry, type SchemaMigrationAllowance,
} from '@hypertest/runtime';
import type { RoleCatalogLike } from '@hypertest/agents';
import { ControlStore, workLeaseKey, type ControlPlane, type RunReport } from '@hypertest/control';
import type { DurableRuntime } from '@hypertest/durable';
import type { MigrateRunInput, RunMigrationResult, RuntimeReleaseService, RuntimeReleaseView } from './contracts.ts';

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
  return new Proxy(router, {
    get(target, prop) {
      if (prop === 'route') return route;
      if (prop === 'invoke') return invoke;
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
  options: { manifestId: string; registry: Pick<RuntimeReleaseRegistry, 'admit'>; requireActive: boolean; newRunId: () => string; getRun: (runId: string) => Promise<TestRun | undefined> },
): C {
  return {
    ...control,
    async startRun(input, ctx) {
      if (!input || typeof input !== 'object') return control.startRun(input, ctx);
      const runId = input.runId ?? options.newRunId();
      if (!(await options.getRun(runId))) {
        const admission = await options.registry.admit({ manifestId: options.manifestId, runId, labels: input.labels ?? {}, requireActive: options.requireActive });
        if (!admission.allowed) {
          throw new HypertestError('precondition_failed', `runtime release: ${admission.reason}`, {
            details: { runId, runtimeManifestId: options.manifestId, activeManifestId: admission.activeManifestId ?? null, state: admission.state ?? null },
          });
        }
      }
      return control.startRun({ ...input, runId }, ctx);
    },
    async resumeRun(runId) {
      const run = await options.getRun(runId);
      if (run?.status === 'paused' && (run.pauseReason === 'quarantined' || run.pauseReason === 'migrating')) {
        throw new HypertestError(
          'precondition_failed',
          run.pauseReason === 'quarantined'
            ? `run ${runId} is quarantined: the runtime release it is pinned to (${run.runtimeManifestId}) was rolled back — migrate it to a good release (hypertest runtime migrate) or cancel it`
            : `run ${runId} is held at the checkpoint of a runtime migration: complete it (hypertest runtime migrate ${runId} --to …) or cancel the run`,
          { details: { runId, pauseReason: run.pauseReason, runtimeManifestId: run.runtimeManifestId } },
        );
      }
      return control.resumeRun(runId);
    },
  };
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
  durable: Pick<DurableRuntime, 'startRun'>;
  /** Evicts a re-pinned run from the pin cache of this process's pinned control plane. */
  forgetPin: (runId: string) => void;
  clock: { isoNow(): string; nowMs(): number };
  logger: Logger;
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
  async function quarantine(run: TestRun, rb: RollbackResult, by: string, reason: string, tx?: Parameters<RunRepository['update']>[3]): Promise<boolean> {
    const ctx: EventContext = { runId: run.runId, correlationId: rb.transition.transitionId, actorId: by };
    const cur = await runs.get(run.runId);
    if (!cur || isTerminalRun(cur.status) || cur.runtimeManifestId !== rb.rolledBack.manifestId) return false;
    if (cur.status === 'paused' && cur.pauseReason === 'quarantined') return false;
    if (cur.status === 'paused') await runs.update(run.runId, { pauseReason: 'quarantined' }, ctx, tx);
    else {
      if (cur.status !== 'running') await runs.update(run.runId, { status: 'running' }, ctx, tx);
      await runs.update(run.runId, { status: 'paused', pauseReason: 'quarantined' }, ctx, tx);
    }
    const payload: Record<string, unknown> = {
      runId: run.runId, manifestId: rb.rolledBack.manifestId, transitionId: rb.transition.transitionId, previousStatus: cur.status, by, reason,
    };
    if (cur.pauseReason !== undefined) payload['previousPauseReason'] = cur.pauseReason;
    if (rb.restored) payload['restoredManifestId'] = rb.restored.manifestId;
    await events.append([eventFrom(ctx, 'run.quarantined', 'run', run.runId, payload)], tx);
    return true;
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

  const service: RuntimeReleaseService = {
    registry,
    resolve,

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
        const quarantined: string[] = [];
        for (const run of await liveRunsOf(rb.rolledBack.manifestId)) if (await quarantine(run, rb, by, reason, tx)) quarantined.push(run.runId);
        return { rb, quarantined };
      });
      // a run the rolled-back runtime created while the rollback committed is caught by a second sweep (idempotent)
      for (const run of await liveRunsOf(rb.rolledBack.manifestId)) if (await quarantine(run, rb, by, reason)) quarantined.push(run.runId);
      logger.warn('runtime release rolled back; its live runs are quarantined', { manifestId: rb.rolledBack.manifestId, restored: rb.restored?.manifestId, quarantined });
      return { ...rb, quarantined };
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
      // 1 checkpoint: pause (in-flight turns finish and give their claims back; nothing new is dispatched)
      let pausedHere = false;
      if (run0.status === 'running') {
        await runs.update(runId, { status: 'paused', pauseReason: 'migrating' }, ctx);
        pausedHere = true;
      }
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
        const waiting = await deps.blackboard.listWorkItems({ runId, states: ['waiting'] });
        if (waiting.length > 0) {
          throw new HypertestError('precondition_failed', `run ${runId} has work items waiting on operations or children (${waiting.map((w) => `${w.workItemId} on ${w.waitingOn.join('+') || '?'}`).join(', ')}): let them settle before migrating`, {
            details: { runId, workItems: waiting.map((w) => w.workItemId) },
          });
        }
        // 4 compatibility, with the engines the run's agents actually used by now
        const checks = runtimeCompatibility(source, (await registry.get(to))!, { usedEngines: await usedEngines(runId) });
        refuseIncompatible(checks, runId, to);
        // 5 re-pin + RuntimeEpoch + run.migrated + resume, in one transaction
        const result = await db.transaction(async (tx) => {
          // the run's locks in the repository's order (run lock, then its row): an empty update takes them and changes
          // nothing, so a concurrent status change of the run can never deadlock with this transaction
          await runs.update(runId, {}, ctx, tx);
          const row = (await tx.query<{ run: unknown }>('SELECT run FROM ht_runs WHERE run_id = $1 FOR UPDATE', [runId])).rows[0];
          const cur = row ? (typeof row.run === 'string' ? JSON.parse(row.run) : row.run) as TestRun : undefined;
          if (!cur) throw new HypertestError('not_found', `run ${runId} not found`);
          if (cur.runtimeManifestId !== source.manifestId) throw new HypertestError('conflict', `run ${runId} was re-pinned to ${cur.runtimeManifestId} concurrently`, { details: { runId } });
          if (cur.status !== 'paused') throw new HypertestError('conflict', `run ${runId} left its checkpoint (now ${cur.status}) during the migration`, { details: { runId, status: cur.status } });
          const held = await liveClaims(runId);
          if (held.length > 0) throw new HypertestError('conflict', `work items ${held.join(', ')} took a claim during the migration`, { details: { runId, workItems: held } });
          const now = deps.clock.isoNow();
          const after = await statusAfter(cur);
          await controlStore.putManifest(target.manifest, now, tx);
          const epoch: RuntimeEpoch = await registry.recordEpoch(
            {
              runId, fromManifestId: source.manifestId, toManifestId: to, snapshotId: snapshot.snapshotId,
              reconciliation: { examined: rec.examined, verified: rec.verified, notApplied: rec.notApplied, manualReview: rec.manualReview, stillPending: rec.stillPending, failed: rec.failed ?? [] },
              compatibility: checks, statusBefore: run0.status, statusAfter: after.status, migratedBy: by, reason,
            },
            tx,
          );
          const repinned: TestRun = JSON.parse(JSON.stringify({ ...cur, runtimeManifestId: to, updatedAt: now }));
          await tx.query('UPDATE ht_runs SET run = $2::jsonb, updated_at = $3 WHERE run_id = $1', [runId, JSON.stringify(repinned), now]);
          await events.append(
            [
              eventFrom({ ...ctx, correlationId: epoch.epochId }, 'run.migrated', 'run', runId, {
                runId, epochId: epoch.epochId, seq: epoch.seq, fromManifestId: source.manifestId, toManifestId: to, snapshotId: snapshot.snapshotId,
                reconciliation: epoch.reconciliation, compatibility: checks, statusBefore: run0.status, statusAfter: after.status, by, reason,
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
        if (input.drive === true && to === deps.manifest.manifestId && result.run.status === 'running') {
          await deps.durable.startRun(runId);
          driven = true;
        }
        logger.info('run migrated to another runtime release', { runId, from: source.manifestId, to, epochId: result.epoch.epochId, status: result.run.status, driven });
        return { ...result, driven };
      } catch (e) {
        // the checkpoint this migration took is released: the run continues where it was, on its own runtime
        if (pausedHere) {
          try {
            const cur = await runs.get(runId);
            if (cur && cur.status === 'paused' && cur.pauseReason === 'migrating' && cur.runtimeManifestId === run0.runtimeManifestId) await runs.update(runId, { status: 'running' }, ctx);
          } catch (restore) {
            logger.error('could not release the migration checkpoint of the run; it stays paused (migrating)', { runId, error: (restore as Error).message });
          }
        }
        throw e;
      }
    },

    epochs(runId) {
      return registry.epochs(runId);
    },
  };
  return service;
}
