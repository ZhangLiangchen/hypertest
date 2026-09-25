import { HypertestError, type Migration, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import type {
  ActionCapability, DomainEvent, DomainEventInput, DomainEventSink, EventContext, OracleChangeProposal, OracleSpec, QualityDecision,
} from '@hypertest/domain';
import type { ActionRequest, DecisionInvalidationPort, OracleStorePort } from '../src/index.ts';
import { policyMigrations } from '../src/index.ts';

export const SECRET = 'test-capability-secret';
export const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
export const NOW = '2026-01-01T00:00:00.000Z';

/** Deterministic PRNG (mulberry32) for property tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cap(overrides: Partial<ActionCapability> = {}): ActionCapability {
  return {
    capabilityId: 'cap_root',
    runId: 'run_1',
    subjectAgentId: 'agent_1',
    workItemId: 'wi_1',
    tools: ['*'],
    resourceScopes: ['**'],
    allowedEffects: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'],
    credentialScopes: [],
    maxRiskClass: 'critical',
    environmentClasses: ['local', 'sandbox', 'staging', 'production'],
    expiresAt: FAR_FUTURE,
    ...overrides,
  };
}

export function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    requestId: 'req_1',
    runId: 'run_1',
    workItemId: 'wi_1',
    agentId: 'agent_1',
    role: 'executor',
    tool: 'fs.read',
    effect: 'read',
    riskClass: 'low',
    resources: ['workspace/wt_1/src/a.ts'],
    capability: cap(),
    ...overrides,
  };
}

/** Test-only events table + a DomainEventSink writing into it through the transaction it is handed. */
export const testEventMigration: Migration = {
  id: 'policy-test/001-events',
  sql: `CREATE TABLE IF NOT EXISTS test_policy_events (
    event_id text PRIMARY KEY, run_id text NOT NULL, event_type text NOT NULL, aggregate_id text NOT NULL,
    actor_id text NOT NULL, correlation_id text NOT NULL, payload jsonb NOT NULL)`,
};
export const migrations: Migration[] = [...policyMigrations, testEventMigration];

export class SqlEventSink implements DomainEventSink {
  readonly #db: SqlDatabase;
  #n = 0;
  failNext = false;
  constructor(db: SqlDatabase) {
    this.#db = db;
  }
  async emit(events: DomainEventInput<unknown>[], tx?: unknown): Promise<DomainEvent<unknown>[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('sink failure (injected)');
    }
    const ex = (tx as SqlExecutor | undefined) ?? this.#db;
    const out: DomainEvent<unknown>[] = [];
    for (const e of events) {
      const eventId = e.eventId ?? `evt_policy_${String(++this.#n).padStart(6, '0')}_${Math.random().toString(36).slice(2, 8)}`;
      await ex.query(
        `INSERT INTO test_policy_events (event_id, run_id, event_type, aggregate_id, actor_id, correlation_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [eventId, e.runId, e.eventType, e.aggregateId, e.actorId, e.correlationId, JSON.stringify(e.payload)],
      );
      out.push({ ...e, eventId, schemaVersion: '1', occurredAt: NOW });
    }
    return out;
  }
  async rows(runId: string): Promise<Array<{ event_type: string; aggregate_id: string; payload: Record<string, unknown> }>> {
    const r = await this.#db.query<{ event_type: string; aggregate_id: string; payload: unknown }>(
      'SELECT event_type, aggregate_id, payload FROM test_policy_events WHERE run_id = $1 ORDER BY event_id',
      [runId],
    );
    return r.rows.map((x) => ({ event_type: x.event_type, aggregate_id: x.aggregate_id, payload: (typeof x.payload === 'string' ? JSON.parse(x.payload) : x.payload) as Record<string, unknown> }));
  }
}

/**
 * In-memory OracleStorePort with @hypertest/collab SpecRepository semantics: a save of an existing id creates
 * revision+1 superseding the latest; an explicit `revision` must be exactly the next one (conflict otherwise —
 * the optimistic compare-and-set OracleGovernance relies on); a proposal is created pending and decided
 * exactly once (precondition_failed otherwise). Critical sections are synchronous (no interleaving).
 */
export class MemoryOracleStore implements OracleStorePort {
  readonly oracles: OracleSpec[] = [];
  readonly proposals = new Map<string, OracleChangeProposal>();
  failNextSave = false;
  failNextProposalSave = false;
  /** Artificial latency before each write (lets tests interleave concurrent callers). */
  delayMs = 0;
  #t = 0;
  #latest(oracleId: string): OracleSpec | undefined {
    return this.oracles.filter((o) => o.oracleId === oracleId).sort((a, b) => b.revision - a.revision)[0];
  }
  async #pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }
  async saveOracle(spec: Omit<OracleSpec, 'revision' | 'createdAt' | 'supersedes'> & { revision?: number }, _ctx: EventContext): Promise<OracleSpec> {
    await this.#pause();
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('store failure (injected)');
    }
    const latest = this.#latest(spec.oracleId);
    const next = (latest?.revision ?? 0) + 1;
    if (spec.revision !== undefined && spec.revision !== next) {
      throw new HypertestError('conflict', `oracle ${spec.oracleId}: revision ${spec.revision} requested but the next revision is ${next}`);
    }
    const { revision: _r, ...rest } = spec;
    const saved: OracleSpec = { ...structuredClone(rest), revision: next, createdAt: new Date(Date.parse(NOW) + ++this.#t * 1000).toISOString() };
    if (latest) saved.supersedes = latest.revision;
    this.oracles.push(saved);
    return structuredClone(saved);
  }
  async getOracle(oracleId: string, revision?: number): Promise<OracleSpec | undefined> {
    const o = revision === undefined ? this.#latest(oracleId) : this.oracles.find((x) => x.oracleId === oracleId && x.revision === revision);
    return o ? structuredClone(o) : undefined;
  }
  async saveOracleProposal(p: OracleChangeProposal, _ctx: EventContext): Promise<OracleChangeProposal> {
    await this.#pause();
    if (this.failNextProposalSave) {
      this.failNextProposalSave = false;
      throw new Error('proposal store failure (injected)');
    }
    const cur = this.proposals.get(p.proposalId);
    if (!cur && p.status !== 'pending') throw new HypertestError('invalid_argument', `proposal ${p.proposalId} must be created pending`);
    if (cur && cur.status !== 'pending') throw new HypertestError('precondition_failed', `proposal ${p.proposalId} is already ${cur.status}`);
    if (cur) {
      const content = (x: OracleChangeProposal) => {
        const { status: _s, decidedBy: _d, decisionRationale: _r, decidedAt: _a, ...rest } = x;
        return JSON.stringify(rest);
      };
      if (content(cur) !== content(p)) throw new HypertestError('conflict', `proposal ${p.proposalId} content is immutable`);
    }
    this.proposals.set(p.proposalId, structuredClone(p));
    return structuredClone(p);
  }
  async getOracleProposal(proposalId: string): Promise<OracleChangeProposal | undefined> {
    const p = this.proposals.get(proposalId);
    return p ? structuredClone(p) : undefined;
  }
}

export class MemoryDecisions implements DecisionInvalidationPort {
  readonly decisions: Array<QualityDecision> = [];
  readonly marked = new Map<string, string>();
  async findByOracleRevision(oracleId: string, revision: number): Promise<QualityDecision[]> {
    return this.decisions.filter((d) => d.oracleRevisions[oracleId] === revision);
  }
  failNextMark = false;
  async markNeedsReassessment(decisionId: string, reason: string): Promise<void> {
    if (this.failNextMark) {
      this.failNextMark = false;
      throw new Error('decision store failure (injected)');
    }
    this.marked.set(decisionId, reason);
  }
}
