/**
 * A fake ControlPlane for the durable runtimes: the facade semantics the runtimes rely on (fenced executeTurn with
 * `expectedTurn` idempotency, waiting items polled through observeWaiting, recover requeueing claims this process did
 * not issue, lease expiry ⇒ requeue, cancel) over a "world" that plays the role of the SQL truth. The world lives in
 * memory (MemoryWorld) or in one row of a real database (SqlWorld: PGlite, or PostgreSQL with HYPERTEST_TEST_DB=postgres),
 * so two FakeControl instances over the same world model two processes over the same database: a crash loses only
 * the instance (its issued claims), never the world.
 */
import { HypertestError, MemoryLogger, SequentialIdGenerator, FixedClock, sleep, type BaseDeps, type Migration, type SqlDatabase } from '@hypertest/core';
import { DEFAULT_BUDGET, type QualityDecision, type TestRun } from '@hypertest/domain';
import type { ControlPlane, RunReport, TickResult, TurnOutcome } from '@hypertest/control';

export type ItemState = 'ready' | 'claimed' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface FakeItem {
  workItemId: string;
  state: ItemState;
  token?: number;
  /** Turns committed so far (the session's last completed turn). */
  committed: number;
  /** Turns the item needs; the last one completes it. */
  turns: number;
  /** After committing this turn the item waits on a long-running operation. */
  waitAfterTurn?: number;
  /** observeWaiting polls before the operation settles. */
  waitPolls: number;
  polls: number;
  attempts: number;
  leaseExpiresAt?: number;
  /** observeWaiting calls still answered `lease_lost` (another worker holds the waiting item's live lease). */
  observeLeaseLost?: number;
}

export interface FakeRun {
  runId: string;
  status: TestRun['status'];
  concurrency: number;
  items: Record<string, FakeItem>;
  decided?: boolean;
  createdAt: string;
}

export type WorldLog =
  | { kind: 'turn'; workItemId: string; turn: number; instance: string }
  | { kind: 'replay'; workItemId: string; expectedTurn: number; committed: number; instance: string }
  | { kind: 'requeue'; workItemId: string; reason: 'recover' | 'lease_expired'; instance: string }
  | { kind: 'retake'; workItemId: string; token: number; instance: string };

export interface World {
  nextToken: number;
  runs: Record<string, FakeRun>;
  log: WorldLog[];
}

export interface WorldStore {
  /** Atomically applies `fn` (synchronous) to the world. */
  mutate<T>(fn: (w: World) => T): Promise<T>;
  read(): Promise<World>;
}

export function emptyWorld(): World {
  return { nextToken: 0, runs: {}, log: [] };
}

export class MemoryWorld implements WorldStore {
  readonly #world: World;
  constructor(world: World = emptyWorld()) {
    this.#world = world;
  }
  async mutate<T>(fn: (w: World) => T): Promise<T> {
    return fn(this.#world);
  }
  async read(): Promise<World> {
    return structuredClone(this.#world);
  }
}

/** Test-only table of the fake world (one JSONB row per world, updated under a row lock). */
export const FAKE_WORLD_MIGRATIONS: Migration[] = [
  { id: 'durable/900-test-fake-world', sql: 'CREATE TABLE IF NOT EXISTS ht_durable_test_world (world_id text PRIMARY KEY, state jsonb NOT NULL)' },
];

export class SqlWorld implements WorldStore {
  readonly #db: SqlDatabase;
  readonly #id: string;
  private constructor(db: SqlDatabase, id: string) {
    this.#db = db;
    this.#id = id;
  }
  static async open(db: SqlDatabase, id: string, world: World = emptyWorld()): Promise<SqlWorld> {
    await db.query('INSERT INTO ht_durable_test_world (world_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (world_id) DO NOTHING', [id, JSON.stringify(world)]);
    return new SqlWorld(db, id);
  }
  async mutate<T>(fn: (w: World) => T): Promise<T> {
    return this.#db.transaction(async (tx) => {
      const r = await tx.query<{ state: unknown }>('SELECT state FROM ht_durable_test_world WHERE world_id = $1 FOR UPDATE', [this.#id]);
      const raw = r.rows[0]?.state;
      const w = (typeof raw === 'string' ? JSON.parse(raw) : raw) as World;
      const out = fn(w);
      await tx.query('UPDATE ht_durable_test_world SET state = $2::jsonb WHERE world_id = $1', [this.#id, JSON.stringify(w)]);
      return out;
    });
  }
  async read(): Promise<World> {
    const r = await this.#db.query<{ state: unknown }>('SELECT state FROM ht_durable_test_world WHERE world_id = $1', [this.#id]);
    const raw = r.rows[0]?.state;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as World;
  }
}

export interface ItemSpec {
  workItemId: string;
  turns: number;
  waitAfterTurn?: number;
  waitPolls?: number;
  observeLeaseLost?: number;
}

export async function addRun(store: WorldStore, runId: string, items: ItemSpec[], options: { concurrency?: number; status?: TestRun['status'] } = {}): Promise<void> {
  await store.mutate((w) => {
    const run: FakeRun = { runId, status: options.status ?? 'created', concurrency: options.concurrency ?? 8, items: {}, createdAt: '2026-09-01T00:00:00.000Z' };
    for (const s of items) {
      const item: FakeItem = { workItemId: s.workItemId, state: 'ready', committed: 0, turns: s.turns, waitPolls: s.waitPolls ?? 0, polls: 0, attempts: 0 };
      if (s.waitAfterTurn !== undefined) item.waitAfterTurn = s.waitAfterTurn;
      if (s.observeLeaseLost !== undefined) item.observeLeaseLost = s.observeLeaseLost;
      run.items[s.workItemId] = item;
    }
    w.runs[runId] = run;
  });
}

export function turnsOf(world: World, workItemId: string): number[] {
  return world.log.filter((e): e is Extract<WorldLog, { kind: 'turn' }> => e.kind === 'turn' && e.workItemId === workItemId).map((e) => e.turn);
}

export interface CallRecord {
  op: 'tick' | 'recover' | 'executeTurn' | 'observeWaiting' | 'cancelRun' | 'claimOf';
  runId?: string;
  workItemId?: string;
  fencingToken?: number;
  expectedTurn?: number;
  reason?: string;
  /** What the call returned (status) or threw (error code). */
  result?: string;
}

export interface FakeHooks {
  /** Runs at the start of executeTurn, before the claim is checked (e.g. the item is requeued and re-dispatched meanwhile). */
  beforeBegin?(call: CallRecord, signal: AbortSignal): Promise<void>;
  /** Runs inside the turn before it commits (e.g. block until aborted: a crash mid-turn). */
  beforeCommit?(workItemId: string, turn: number, signal: AbortSignal): Promise<void>;
  /** Runs after the turn committed, before the result is returned (a crash after the commit). */
  afterCommit?(workItemId: string, turn: number, signal: AbortSignal): Promise<void>;
  /** Called at the start of every call; throw to inject a fault. */
  inject?(call: CallRecord): void;
}

export interface FakeControlOptions {
  instance: string;
  store: WorldStore;
  turnMs?: number;
  idleMs?: number;
  leaseTtlMs?: number;
  /** observeWaiting re-takes the claim under a new token when it resumes the item (a lease lapsed while waiting). */
  retakeOnObserve?: boolean;
  hooks?: FakeHooks;
}

const TERMINAL: ReadonlySet<ItemState> = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_RUN: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export function decisionFor(runId: string): QualityDecision {
  return {
    decisionId: `dec_${runId}`,
    runId,
    revision: 1,
    gateId: 'fake-gate',
    scope: { description: 'fake', objectiveIds: [] },
    verdict: 'inconclusive',
    requiresHumanReview: false,
    oracleRevisions: {},
    experimentRevisions: {},
    evidenceRootHash: '0'.repeat(64),
    evidenceCount: 0,
    satisfiedCriteria: [],
    violatedCriteria: [],
    unknownCriteria: [],
    unresolvedFindings: [],
    unresolvedRisks: [],
    exceptions: [],
    reviewerDecisions: [],
    reasons: ['fake gate: no evidence'],
    runtimeManifestId: 'rm_fake',
    policyRevision: 'fake',
    decidedAt: '2026-09-01T00:00:00.000Z',
  };
}

export function testRunOf(r: FakeRun): TestRun {
  return {
    runId: r.runId,
    goal: `fake run ${r.runId}`,
    target: {},
    status: r.status,
    budget: DEFAULT_BUDGET,
    runtimeManifestId: 'rm_fake',
    policyRevision: 'fake',
    currentPlanRevision: 1,
    oracleRevisions: {},
    experimentIds: [],
    labels: {},
    createdAt: r.createdAt,
    updatedAt: r.createdAt,
    ...(r.decided ? { decisionId: `dec_${r.runId}` } : {}),
  };
}

function notFound(what: string, id: string): HypertestError {
  return new HypertestError('not_found', `${what} ${id} not found`, { details: { id } });
}

export class FakeControl implements ControlPlane {
  readonly deps: BaseDeps;
  readonly logger = new MemoryLogger();
  readonly calls: CallRecord[] = [];
  readonly instance: string;
  readonly store: WorldStore;
  readonly #issued = new Set<number>();
  readonly #turnMs: number;
  readonly #idleMs: number;
  readonly #leaseTtlMs: number | undefined;
  readonly #retake: boolean;
  readonly hooks: FakeHooks;
  inFlightTurns = 0;
  maxInFlightTurns = 0;

  constructor(options: FakeControlOptions) {
    this.instance = options.instance;
    this.store = options.store;
    this.#turnMs = options.turnMs ?? 2;
    this.#idleMs = options.idleMs ?? 20;
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#retake = options.retakeOnObserve ?? false;
    this.hooks = options.hooks ?? {};
    this.deps = { ids: new SequentialIdGenerator(), clock: new FixedClock('2026-09-01T00:00:00.000Z'), logger: this.logger };
  }

  #record(call: CallRecord): CallRecord {
    this.calls.push(call);
    try {
      this.hooks.inject?.(call);
    } catch (e) {
      call.result = e instanceof HypertestError ? `throw:${e.code}` : 'throw';
      throw e;
    }
    return call;
  }

  #lease(item: FakeItem): void {
    if (this.#leaseTtlMs !== undefined) item.leaseExpiresAt = Date.now() + this.#leaseTtlMs;
  }

  #claim(w: World, item: FakeItem): number {
    const token = ++w.nextToken;
    item.token = token;
    this.#issued.add(token);
    this.#lease(item);
    return token;
  }

  async listRuns(): Promise<TestRun[]> {
    const w = await this.store.read();
    return Object.values(w.runs).map(testRunOf);
  }

  async getRun(runId: string): Promise<TestRun | undefined> {
    const w = await this.store.read();
    const r = w.runs[runId];
    return r ? testRunOf(r) : undefined;
  }

  /** Lease expiry of a claimed/running item as the scheduler applies it (back to ready, token dropped, attempts + 1). */
  static requeue(w: World, workItemId: string): void {
    for (const run of Object.values(w.runs)) {
      const item = run.items[workItemId];
      if (!item) continue;
      item.state = 'ready';
      delete item.token;
      delete item.leaseExpiresAt;
      item.attempts++;
      w.log.push({ kind: 'requeue', workItemId, reason: 'lease_expired', instance: 'test' });
    }
  }

  /** resolveClaim hook: the token of the claim this instance holds (issued by it). */
  async claimOf(workItemId: string): Promise<number | undefined> {
    const call = this.#record({ op: 'claimOf', workItemId });
    const w = await this.store.read();
    for (const r of Object.values(w.runs)) {
      const item = r.items[workItemId];
      if (item && !TERMINAL.has(item.state) && item.token !== undefined && this.#issued.has(item.token)) {
        call.result = String(item.token);
        return item.token;
      }
    }
    call.result = 'none';
    return undefined;
  }

  async startRun(): Promise<TestRun> {
    throw new HypertestError('unsupported', 'FakeControl.startRun: use addRun()');
  }

  async tick(runId: string): Promise<TickResult> {
    const call = this.#record({ op: 'tick', runId });
    const out = await this.store.mutate((w): TickResult => {
      const run = w.runs[runId];
      if (!run) throw notFound('run', runId);
      const base = { runId, dispatched: [], waiting: [], replanScheduled: false } as const;
      if (TERMINAL_RUN.has(run.status)) {
        const r: TickResult = { ...base, dispatched: [], waiting: [], status: run.status, convergence: { state: 'drained', reason: 'ready_for_gate' }, final: true, idleMs: 0 };
        if (run.decided) r.decision = decisionFor(runId);
        return r;
      }
      let progressed = false;
      if (run.status === 'created') {
        run.status = 'running';
        progressed = true;
      }
      if (run.status === 'paused') return { ...base, dispatched: [], waiting: [], status: run.status, convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, final: false, idleMs: this.#idleMs };
      const items = Object.values(run.items).sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1));
      const now = Date.now();
      for (const item of items) {
        if ((item.state === 'claimed' || item.state === 'running') && item.leaseExpiresAt !== undefined && item.leaseExpiresAt < now) {
          item.state = 'ready';
          delete item.token;
          delete item.leaseExpiresAt;
          item.attempts++;
          w.log.push({ kind: 'requeue', workItemId: item.workItemId, reason: 'lease_expired', instance: this.instance });
          progressed = true;
        }
      }
      let active = items.filter((i) => i.state === 'claimed' || i.state === 'running').length;
      const dispatched: TickResult['dispatched'] = [];
      for (const item of items) {
        if (item.state !== 'ready' || active >= run.concurrency) continue;
        item.state = 'claimed';
        dispatched.push({ workItemId: item.workItemId, ownerId: this.instance, fencingToken: this.#claim(w, item) });
        active++;
        progressed = true;
      }
      const waiting = items.filter((i) => i.state === 'waiting').map((i) => ({ workItemId: i.workItemId, operationIds: [`op-${i.workItemId}`] }));
      if (items.length > 0 && items.every((i) => TERMINAL.has(i.state))) {
        run.status = 'completed';
        run.decided = true;
        return { ...base, dispatched: [], waiting: [], status: 'completed', convergence: { state: 'drained', reason: 'plan_drained' }, decision: decisionFor(runId), final: true, idleMs: 0 };
      }
      const running = items.filter((i) => i.state === 'claimed' || i.state === 'running').length;
      return {
        ...base,
        status: run.status,
        dispatched,
        waiting,
        convergence: { state: 'active', runnable: items.filter((i) => i.state === 'ready').length, running, waiting: waiting.length, pendingEvents: 0 },
        final: false,
        idleMs: progressed ? 0 : this.#idleMs,
      };
    });
    call.result = out.final ? `final:${out.status}` : `dispatched:${out.dispatched.map((d) => d.workItemId).join(',')}`;
    return out;
  }

  async executeTurn(workItemId: string, fencingToken: number, signal?: AbortSignal, options?: { expectedTurn?: number }): Promise<TurnOutcome> {
    const call: CallRecord = { op: 'executeTurn', workItemId, fencingToken };
    if (options?.expectedTurn !== undefined) call.expectedTurn = options.expectedTurn;
    this.#record(call);
    this.inFlightTurns++;
    this.maxInFlightTurns = Math.max(this.maxInFlightTurns, this.inFlightTurns);
    try {
      await this.hooks.beforeBegin?.(call, signal ?? new AbortController().signal);
      const out = await this.#executeTurn(workItemId, fencingToken, signal ?? new AbortController().signal, options?.expectedTurn);
      call.result = out.status;
      return out;
    } catch (e) {
      call.result = e instanceof HypertestError ? `throw:${e.code}` : 'throw';
      throw e;
    } finally {
      this.inFlightTurns--;
    }
  }

  async #executeTurn(workItemId: string, token: number, signal: AbortSignal, expectedTurn: number | undefined): Promise<TurnOutcome> {
    const begin = await this.store.mutate((w): TurnOutcome | { turn: number } => {
      const { run, item } = this.#find(w, workItemId);
      if (TERMINAL.has(item.state)) return { status: item.state as 'completed' | 'failed' | 'cancelled', workItemId };
      if (run.status === 'paused') return { status: 'paused', workItemId, reason: 'operator' };
      if (item.token !== token) return { status: 'lease_lost', workItemId };
      if (TERMINAL_RUN.has(run.status)) {
        item.state = 'cancelled';
        return { status: 'cancelled', workItemId };
      }
      if (item.state === 'waiting') return { status: 'waiting', workItemId, operationIds: [`op-${workItemId}`] };
      if (item.state === 'claimed') item.state = 'running';
      if (expectedTurn !== undefined && item.committed >= expectedTurn) {
        w.log.push({ kind: 'replay', workItemId, expectedTurn, committed: item.committed, instance: this.instance });
        return { status: 'continue', workItemId, turn: item.committed };
      }
      this.#lease(item);
      return { turn: item.committed + 1 };
    });
    if (!('turn' in begin) || 'status' in begin) return begin as TurnOutcome;
    const turn = begin.turn;
    try {
      await this.hooks.beforeCommit?.(workItemId, turn, signal);
      await sleep(this.#turnMs, signal);
    } catch (e) {
      if (e instanceof HypertestError && !signal.aborted) throw e; // an injected fault
      throw new HypertestError('cancelled', `turn ${turn} of ${workItemId} aborted`, { cause: e });
    }
    const out = await this.store.mutate((w): TurnOutcome => {
      const { item } = this.#find(w, workItemId);
      if (TERMINAL.has(item.state)) return { status: item.state as 'completed' | 'failed' | 'cancelled', workItemId };
      if (item.token !== token) return { status: 'lease_lost', workItemId };
      item.committed = turn;
      w.log.push({ kind: 'turn', workItemId, turn, instance: this.instance });
      this.#lease(item);
      if (turn >= item.turns) {
        item.state = 'completed';
        delete item.leaseExpiresAt;
        return { status: 'completed', workItemId };
      }
      if (item.waitAfterTurn === turn) {
        item.state = 'waiting';
        item.polls = 0;
        return { status: 'waiting', workItemId, operationIds: [`op-${workItemId}`] };
      }
      return { status: 'continue', workItemId, turn };
    });
    if (this.hooks.afterCommit) {
      try {
        await this.hooks.afterCommit(workItemId, turn, signal);
      } catch (e) {
        if (e instanceof HypertestError && !signal.aborted) throw e; // an injected fault
        throw new HypertestError('cancelled', `result of turn ${turn} of ${workItemId} lost`, { cause: e });
      }
    }
    return out;
  }

  #find(w: World, workItemId: string): { run: FakeRun; item: FakeItem } {
    for (const run of Object.values(w.runs)) {
      const item = run.items[workItemId];
      if (item) return { run, item };
    }
    throw notFound('work item', workItemId);
  }

  async observeWaiting(workItemId: string): Promise<TurnOutcome> {
    const call = this.#record({ op: 'observeWaiting', workItemId });
    const out = await this.store.mutate((w): TurnOutcome => {
      const { run, item } = this.#find(w, workItemId);
      if (TERMINAL.has(item.state)) return { status: item.state as 'completed' | 'failed' | 'cancelled', workItemId };
      if (TERMINAL_RUN.has(run.status)) {
        item.state = 'cancelled';
        return { status: 'cancelled', workItemId };
      }
      if (item.state !== 'waiting') return { status: 'continue', workItemId, turn: item.committed };
      if (item.observeLeaseLost !== undefined && item.observeLeaseLost > 0) {
        item.observeLeaseLost--;
        return { status: 'lease_lost', workItemId };
      }
      item.polls++;
      this.#lease(item);
      if (item.polls < item.waitPolls) return { status: 'waiting', workItemId, operationIds: [`op-${workItemId}`] };
      item.state = 'running';
      if (this.#retake) w.log.push({ kind: 'retake', workItemId, token: this.#claim(w, item), instance: this.instance });
      return { status: 'continue', workItemId, turn: item.committed };
    });
    call.result = out.status;
    return out;
  }

  async recover(runId: string): Promise<{ reconciled: number; requeued: string[] }> {
    const call = this.#record({ op: 'recover', runId });
    const out = await this.store.mutate((w) => {
      const run = w.runs[runId];
      if (!run) throw notFound('run', runId);
      const requeued: string[] = [];
      if (TERMINAL_RUN.has(run.status)) return { reconciled: 0, requeued };
      for (const item of Object.values(run.items)) {
        if (item.token === undefined || this.#issued.has(item.token)) continue;
        if (item.state === 'waiting') {
          w.log.push({ kind: 'retake', workItemId: item.workItemId, token: this.#claim(w, item), instance: this.instance });
        } else if (item.state === 'claimed' || item.state === 'running') {
          item.state = 'ready';
          delete item.token;
          delete item.leaseExpiresAt;
          item.attempts++;
          requeued.push(item.workItemId);
          w.log.push({ kind: 'requeue', workItemId: item.workItemId, reason: 'recover', instance: this.instance });
        }
      }
      return { reconciled: 0, requeued };
    });
    call.result = out.requeued.join(',');
    return out;
  }

  async cancelRun(runId: string, reason: string): Promise<void> {
    this.#record({ op: 'cancelRun', runId, reason });
    await this.store.mutate((w) => {
      const run = w.runs[runId];
      if (!run) throw notFound('run', runId);
      if (run.status === 'completed' || run.status === 'failed') return;
      run.status = 'cancelled';
      for (const item of Object.values(run.items)) if (!TERMINAL.has(item.state)) item.state = 'cancelled';
    });
  }

  async pauseRun(runId: string): Promise<void> {
    await this.store.mutate((w) => {
      const run = w.runs[runId];
      if (!run) throw notFound('run', runId);
      run.status = 'paused';
    });
  }

  async resumeRun(runId: string): Promise<void> {
    await this.store.mutate((w) => {
      const run = w.runs[runId];
      if (!run) throw notFound('run', runId);
      if (run.status === 'paused') run.status = 'running';
    });
  }

  async snapshot(): Promise<never> {
    throw new HypertestError('unsupported', 'FakeControl.snapshot');
  }

  async report(): Promise<RunReport> {
    throw new HypertestError('unsupported', 'FakeControl.report');
  }

  callsOf(op: CallRecord['op'], workItemId?: string): CallRecord[] {
    return this.calls.filter((c) => c.op === op && (workItemId === undefined || c.workItemId === workItemId));
  }
}

/** A gate the test opens; `wait(signal)` rejects when the signal aborts (a blocked turn aborted by a crash). */
export class Gate {
  #open!: () => void;
  readonly #opened: Promise<void>;
  entered = 0;
  readonly #enteredWaiters: Array<() => void> = [];
  constructor() {
    this.#opened = new Promise((r) => {
      this.#open = r;
    });
  }
  open(): void {
    this.#open();
  }
  async wait(signal: AbortSignal): Promise<void> {
    this.entered++;
    for (const w of this.#enteredWaiters.splice(0)) w();
    if (signal.aborted) throw new Error('aborted');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      void this.#opened.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
  /** Resolves once some turn waits at the gate. */
  reached(): Promise<void> {
    if (this.entered > 0) return Promise.resolve();
    return new Promise((r) => this.#enteredWaiters.push(r));
  }
}

/** Polls `cond` until true (or throws after `ms`). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`${what} not reached within ${ms}ms`);
    await sleep(10);
  }
}
