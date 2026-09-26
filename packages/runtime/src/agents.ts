import { HypertestError, toIso, toNumber, type SqlExecutor } from '@hypertest/core';
import type { AgentInstance, AgentStatus } from '@hypertest/domain';
import type { AgentRepository, RuntimeDeps } from './contracts.ts';
import { assertNonEmpty } from './util.ts';

const AGENT_STATUSES: readonly AgentStatus[] = ['active', 'waiting', 'completed', 'failed', 'interrupted', 'disposed'];

interface AgentRow {
  agent_id: string;
  run_id: string;
  role: string;
  work_item_id: string;
  parent_agent_id: string | null;
  depth: unknown;
  engine_kind: string;
  session_id: string;
  status: AgentStatus;
  capability_id: string;
  continuable: boolean;
  background: boolean;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = 'agent_id, run_id, role, work_item_id, parent_agent_id, depth, engine_kind, session_id, status, capability_id, continuable, background, created_at, updated_at';

export function rowToAgent(r: AgentRow): AgentInstance {
  const a: AgentInstance = {
    agentId: r.agent_id,
    runId: r.run_id,
    role: r.role,
    workItemId: r.work_item_id,
    depth: toNumber(r.depth),
    engineKind: r.engine_kind,
    sessionId: r.session_id,
    status: r.status,
    capabilityId: r.capability_id,
    continuable: r.continuable === true,
    background: r.background === true,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
  if (r.parent_agent_id) a.parentAgentId = r.parent_agent_id;
  return a;
}

export async function selectAgent(x: SqlExecutor, agentId: string, lock = false): Promise<AgentInstance | undefined> {
  const r = await x.query<AgentRow>(`SELECT ${COLUMNS} FROM ht_agents WHERE agent_id = $1${lock ? ' FOR UPDATE' : ''}`, [agentId]);
  return r.rows[0] ? rowToAgent(r.rows[0]) : undefined;
}

function validate(agent: AgentInstance): void {
  assertNonEmpty(agent?.agentId, 'agentId');
  assertNonEmpty(agent.runId, 'runId');
  assertNonEmpty(agent.role, 'role');
  assertNonEmpty(agent.workItemId, 'workItemId');
  assertNonEmpty(agent.engineKind, 'engineKind');
  assertNonEmpty(agent.sessionId, 'sessionId');
  assertNonEmpty(agent.capabilityId, 'capabilityId');
  if (!Number.isSafeInteger(agent.depth) || agent.depth < 0) throw new HypertestError('invalid_argument', `depth must be a non-negative integer (got ${String(agent.depth)})`);
  if (!AGENT_STATUSES.includes(agent.status)) throw new HypertestError('invalid_argument', `unknown agent status ${String(agent.status)}`);
}

/** SQL AgentRepository over ht_agents. A disposed agent is terminal (any other status ⇒ conflict). */
export function createAgentRepository(deps: RuntimeDeps): AgentRepository {
  const { db, clock } = deps;
  return {
    async create(agent) {
      validate(agent);
      await db.query(
        `INSERT INTO ht_agents (agent_id, run_id, role, work_item_id, parent_agent_id, depth, engine_kind, session_id, status, capability_id, continuable, background, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          agent.agentId, agent.runId, agent.role, agent.workItemId, agent.parentAgentId ?? null, agent.depth, agent.engineKind, agent.sessionId, agent.status,
          agent.capabilityId, agent.continuable === true, agent.background === true, agent.createdAt, agent.updatedAt,
        ],
      );
      return (await selectAgent(db, agent.agentId))!;
    },

    async get(agentId) {
      return selectAgent(db, agentId);
    },

    async byWorkItem(workItemId) {
      const r = await db.query<AgentRow>(`SELECT ${COLUMNS} FROM ht_agents WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1`, [workItemId]);
      return r.rows[0] ? rowToAgent(r.rows[0]) : undefined;
    },

    async update(agentId, patch) {
      if (patch.status !== undefined && !AGENT_STATUSES.includes(patch.status)) throw new HypertestError('invalid_argument', `unknown agent status ${String(patch.status)}`);
      if (patch.sessionId !== undefined) assertNonEmpty(patch.sessionId, 'sessionId');
      return db.transaction(async (tx) => {
        const current = await selectAgent(tx, agentId, true);
        if (!current) throw new HypertestError('not_found', `agent ${agentId} not found`, { details: { agentId } });
        if (current.status === 'disposed' && patch.status !== undefined && patch.status !== 'disposed') {
          throw new HypertestError('conflict', `agent ${agentId} is disposed`, { details: { agentId, requested: patch.status } });
        }
        await tx.query(`UPDATE ht_agents SET status = $2, session_id = $3, updated_at = $4 WHERE agent_id = $1`, [
          agentId,
          patch.status ?? current.status,
          patch.sessionId ?? current.sessionId,
          patch.updatedAt ?? clock.isoNow(),
        ]);
        return (await selectAgent(tx, agentId))!;
      });
    },

    async children(parentAgentId) {
      const r = await db.query<AgentRow>(`SELECT ${COLUMNS} FROM ht_agents WHERE parent_agent_id = $1 ORDER BY seq`, [parentAgentId]);
      return r.rows.map(rowToAgent);
    },

    async list(filter) {
      assertNonEmpty(filter?.runId, 'runId');
      const statuses = filter.status;
      if (statuses !== undefined) {
        if (!Array.isArray(statuses)) throw new HypertestError('invalid_argument', 'status filter must be an array');
        for (const s of statuses) if (!AGENT_STATUSES.includes(s)) throw new HypertestError('invalid_argument', `unknown agent status ${String(s)}`);
        if (statuses.length === 0) return [];
        const r = await db.query<AgentRow>(`SELECT ${COLUMNS} FROM ht_agents WHERE run_id = $1 AND status = ANY($2::text[]) ORDER BY seq`, [filter.runId, statuses]);
        return r.rows.map(rowToAgent);
      }
      const r = await db.query<AgentRow>(`SELECT ${COLUMNS} FROM ht_agents WHERE run_id = $1 ORDER BY seq`, [filter.runId]);
      return r.rows.map(rowToAgent);
    },
  };
}
