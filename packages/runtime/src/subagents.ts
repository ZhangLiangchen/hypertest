import { HypertestError, type JsonValue } from '@hypertest/core';
import { EVENT_TYPES, RISK_ORDER, eventFrom, type ActionCapability, type AgentInstance, type EventContext } from '@hypertest/domain';
import { resourcePatternCovers, toolPatternCovers, verifyCapability } from '@hypertest/policy';
import type { CreateSessionRequest, EngineSessionRef, SpawnRequest, SubagentDeps, SubagentResult, SubagentRuntime } from './contracts.ts';
import { SETTLED_TURN_STATUSES, selectAgent, setResumePending } from './agents.ts';
import { childModes } from './capabilities.ts';
import { validateBudget } from './runner.ts';
import { assertNonEmpty, jsonParam, parseJson, sameJson } from './util.ts';

type SettledRecord = Omit<SubagentResult, 'agentId' | 'status'> & { status: 'completed' | 'failed' | 'interrupted' };

const FINAL: ReadonlySet<AgentInstance['status']> = new Set(['completed', 'failed', 'disposed']);

function withAgent(ctx: EventContext, agentId: string): EventContext {
  return ctx.agentId === undefined ? { ...ctx, agentId } : ctx;
}

function assertStrings(v: unknown, what: string): asserts v is string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HypertestError('invalid_argument', `${what} must be an array of strings`);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * I2: the first grant of `child` that `parent` does not cover, or undefined when the child is a (non-strict)
 * attenuation of the parent. Patterns are compared with policy's sound cover relations; sets by inclusion; risk and
 * expiry by order. Malformed fields count as amplification (fail closed).
 */
export function capabilityAmplification(child: ActionCapability, parent: ActionCapability): string | undefined {
  if (child.runId !== parent.runId) return `run ${String(child.runId)} differs from the parent's run ${parent.runId}`;
  for (const f of ['tools', 'resourceScopes', 'allowedEffects', 'credentialScopes', 'environmentClasses'] as const) {
    if (!isStringList(child[f])) return `${f} is malformed`;
    if (!isStringList(parent[f])) return `the parent's ${f} is malformed`;
  }
  for (const t of child.tools) if (!parent.tools.some((p) => toolPatternCovers(p, t))) return `tool pattern ${t} is not covered by the parent's tools`;
  for (const r of child.resourceScopes) if (!parent.resourceScopes.some((p) => resourcePatternCovers(p, r))) return `resource scope ${r} is not covered by the parent's scopes`;
  for (const e of child.allowedEffects) if (!(parent.allowedEffects as string[]).includes(e)) return `effect ${e} is not allowed to the parent`;
  for (const c of child.credentialScopes) if (!parent.credentialScopes.includes(c)) return `credential scope ${c} is not held by the parent`;
  for (const c of child.environmentClasses) if (!parent.environmentClasses.includes(c)) return `environment class ${c} is not allowed to the parent`;
  if (!Object.hasOwn(RISK_ORDER, child.maxRiskClass) || !Object.hasOwn(RISK_ORDER, parent.maxRiskClass) || RISK_ORDER[child.maxRiskClass] > RISK_ORDER[parent.maxRiskClass]) {
    return `maxRiskClass ${String(child.maxRiskClass)} exceeds the parent's ${String(parent.maxRiskClass)}`;
  }
  const childExpiry = Date.parse(child.expiresAt);
  const parentExpiry = Date.parse(parent.expiresAt);
  if (!Number.isFinite(childExpiry) || !Number.isFinite(parentExpiry) || childExpiry > parentExpiry) {
    return `expiresAt ${String(child.expiresAt)} outlives the parent's ${String(parent.expiresAt)}`;
  }
  return undefined;
}

/**
 * Subagent semantics owned by Hypertest (not by an engine): identity, caps (I12), capability binding (I2),
 * task-only child context, interrupt cascade, and a result channel that carries only the settled summary/output/refs.
 */
export function createSubagentRuntime(deps: SubagentDeps): SubagentRuntime {
  const { db, agents, sessions, engines, ids, clock, logger } = deps;
  if (!Number.isSafeInteger(deps.maxAgentsPerRun) || deps.maxAgentsPerRun < 1) throw new HypertestError('invalid_argument', 'maxAgentsPerRun must be a positive integer');

  async function mustGet(agentId: string): Promise<AgentInstance> {
    const a = await agents.get(agentId);
    if (!a) throw new HypertestError('not_found', `agent ${agentId} not found`, { details: { agentId } });
    return a;
  }

  async function emit(ctx: EventContext, type: string, agent: AgentInstance, payload: Record<string, unknown>, tx?: unknown): Promise<void> {
    if (!deps.events) return;
    await deps.events.emit([eventFrom(withAgent(ctx, agent.agentId), type, 'agent', agent.agentId, payload)], tx);
  }

  /** The agent and all its descendants, children before parents (post-order). */
  async function subtree(root: AgentInstance): Promise<AgentInstance[]> {
    const out: AgentInstance[] = [];
    const seen = new Set<string>();
    const visit = async (a: AgentInstance): Promise<void> => {
      if (seen.has(a.agentId)) return;
      seen.add(a.agentId);
      for (const c of await agents.children(a.agentId)) await visit(c);
      out.push(a);
    };
    await visit(root);
    return out;
  }

  function ref(a: AgentInstance): EngineSessionRef {
    return { sessionId: a.sessionId, engineKind: a.engineKind };
  }

  async function recordedGrant(agentId: string): Promise<{ capability?: ActionCapability; maxDepth?: number }> {
    const r = await db.query<{ capability: unknown; max_depth: unknown }>(`SELECT capability, max_depth FROM ht_agents WHERE agent_id = $1`, [agentId]);
    const row = r.rows[0];
    const out: { capability?: ActionCapability; maxDepth?: number } = {};
    const capability = parseJson<ActionCapability>(row?.capability);
    if (capability !== undefined) out.capability = capability;
    if (row?.max_depth !== null && row?.max_depth !== undefined) out.maxDepth = Number(row.max_depth);
    return out;
  }

  return {
    async spawn(request: SpawnRequest, ctx: EventContext): Promise<AgentInstance> {
      assertNonEmpty(request?.runId, 'runId');
      assertNonEmpty(request.workItemId, 'workItemId');
      assertNonEmpty(request.role, 'role');
      assertNonEmpty(request.contextSnapshotId, 'contextSnapshotId');
      if (!Number.isSafeInteger(request.depth) || request.depth < 0) throw new HypertestError('invalid_argument', `depth must be a non-negative integer (got ${String(request.depth)})`);
      if (!Number.isSafeInteger(request.maxDepth) || request.maxDepth < 0) throw new HypertestError('invalid_argument', `maxDepth must be a non-negative integer`);
      if (!Array.isArray(request.initialMessages)) throw new HypertestError('invalid_argument', 'initialMessages must be an array');
      validateBudget(request.budget);
      // I12: depth cap before anything is created.
      if (request.depth > request.maxDepth) {
        throw new HypertestError('permission_denied', `agent depth ${request.depth} exceeds maxDepth ${request.maxDepth}`, { details: { depth: request.depth, maxDepth: request.maxDepth } });
      }
      let parent: AgentInstance | undefined;
      let parentGrant: { capability?: ActionCapability; maxDepth?: number } = {};
      // The depth cap in force: a child can never raise the cap its ancestors were spawned with (I12).
      let maxDepth = request.maxDepth;
      if (request.parentAgentId !== undefined) {
        parent = await mustGet(request.parentAgentId);
        if (parent.runId !== request.runId) throw new HypertestError('invalid_argument', `parent agent ${parent.agentId} belongs to run ${parent.runId}, not ${request.runId}`);
        if (request.depth !== parent.depth + 1) {
          throw new HypertestError('invalid_argument', `child depth must be parent depth + 1 (${parent.depth + 1}), got ${request.depth}`, { details: { parentDepth: parent.depth, depth: request.depth } });
        }
        if (parent.status === 'disposed' || parent.status === 'failed' || parent.status === 'interrupted') {
          throw new HypertestError('precondition_failed', `parent agent ${parent.agentId} is ${parent.status}; it cannot spawn children`);
        }
        parentGrant = await recordedGrant(parent.agentId);
        if (parentGrant.maxDepth !== undefined) maxDepth = Math.min(maxDepth, parentGrant.maxDepth);
        if (request.depth > maxDepth) {
          throw new HypertestError('permission_denied', `agent depth ${request.depth} exceeds the inherited maxDepth ${maxDepth}`, { details: { depth: request.depth, maxDepth, requested: request.maxDepth } });
        }
      }

      // The capability is bound to the agent it is granted to (no confused deputy): generate the id first.
      const agentId = ids.next('ag');
      let capability: ActionCapability;
      try {
        capability = typeof request.capability === 'function' ? request.capability(agentId) : request.capability;
      } catch (e) {
        throw new HypertestError('permission_denied', `capability factory failed for agent ${agentId}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (!capability || typeof capability !== 'object') throw new HypertestError('permission_denied', 'spawn requires a capability');
      if (capability.subjectAgentId !== agentId) {
        throw new HypertestError('permission_denied', `capability ${capability.capabilityId} is granted to ${capability.subjectAgentId}, not to the new agent ${agentId}`, {
          details: { capabilityId: capability.capabilityId, subjectAgentId: capability.subjectAgentId, agentId },
        });
      }
      if (capability.runId !== request.runId || capability.workItemId !== request.workItemId) {
        throw new HypertestError('permission_denied', `capability ${capability.capabilityId} is bound to ${capability.runId}/${capability.workItemId}, not ${request.runId}/${request.workItemId}`);
      }
      if (deps.capabilitySecret !== undefined && !verifyCapability(capability, deps.capabilitySecret)) {
        throw new HypertestError('permission_denied', `capability ${capability.capabilityId} has an invalid or missing signature`, { details: { capabilityId: capability.capabilityId } });
      }
      if (parent) {
        // I2: a child's capability must be attenuated from its parent's (policy.attenuateCapability sets parentCapabilityId)
        // and must not grant anything the parent's recorded capability does not (a matching id alone proves nothing).
        if (capability.parentCapabilityId !== parent.capabilityId) {
          throw new HypertestError('permission_denied', `capability ${capability.capabilityId} is not derived from the parent's capability ${parent.capabilityId}`, {
            details: { parentCapabilityId: capability.parentCapabilityId ?? null, expected: parent.capabilityId },
          });
        }
        const parentCapability = parentGrant.capability;
        if (!parentCapability || parentCapability.capabilityId !== parent.capabilityId) {
          throw new HypertestError('permission_denied', `the capability of parent agent ${parent.agentId} is not on record; a child grant cannot be verified as an attenuation (I2)`, {
            details: { parentAgentId: parent.agentId },
          });
        }
        const amplified = capabilityAmplification(capability, parentCapability);
        if (amplified !== undefined) {
          throw new HypertestError('permission_denied', `capability ${capability.capabilityId} amplifies the parent's capability ${parent.capabilityId}: ${amplified}`, {
            details: { capabilityId: capability.capabilityId, parentCapabilityId: parent.capabilityId, reason: amplified },
          });
        }
      }
      const engineKind = request.engineKind ?? deps.defaultEngineKind;
      const engine = engines.get(engineKind);
      // A[4]: the engine's capabilities choose how the child exists — what it lacks is emulated by the host, what cannot
      // be emulated is refused (precondition_failed, before anything is created)
      const modes = childModes(engine, { continuable: request.continuable === true, background: request.background === true });

      const agent = await db.transaction(async (tx) => {
        // I12: agent-count cap, serialized per run so concurrent spawns cannot overshoot it.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ht_agents:${request.runId}`]);
        const count = await tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM ht_agents WHERE run_id = $1`, [request.runId]);
        const n = Number(count.rows[0]?.n ?? 0);
        if (n >= deps.maxAgentsPerRun) {
          throw new HypertestError('budget_exhausted', `run ${request.runId} already has ${n} agents (maxAgentsPerRun ${deps.maxAgentsPerRun})`, {
            details: { runId: request.runId, agents: n, maxAgentsPerRun: deps.maxAgentsPerRun },
          });
        }
        // The child gets ONLY its task context (initialMessages) — never the parent's transcript.
        const child: CreateSessionRequest = { runId: request.runId, agentId, initialMessages: request.initialMessages };
        if (request.outputSchema !== undefined) child.outputSchema = request.outputSchema;
        const session = parent && parent.engineKind === engineKind ? (await engine.spawnChild({ parent: ref(parent), child })).session : await engine.createSession(child);
        const now = clock.isoNow();
        const instance: AgentInstance = {
          agentId,
          runId: request.runId,
          role: request.role,
          workItemId: request.workItemId,
          depth: request.depth,
          engineKind,
          sessionId: session.sessionId,
          status: 'active',
          capabilityId: capability.capabilityId,
          continuable: request.continuable === true,
          background: request.background === true,
          createdAt: now,
          updatedAt: now,
        };
        if (parent) instance.parentAgentId = parent.agentId;
        const created = await agents.create(instance);
        await tx.query(`UPDATE ht_agents SET capability = $2::jsonb, max_depth = $3 WHERE agent_id = $1`, [agentId, jsonParam(capability), maxDepth]);
        await emit(ctx, EVENT_TYPES.agentSpawned, created, {
          agentId,
          role: created.role,
          workItemId: created.workItemId,
          parentAgentId: created.parentAgentId ?? null,
          depth: created.depth,
          engineKind,
          sessionId: created.sessionId,
          capabilityId: created.capabilityId,
          contextSnapshotId: request.contextSnapshotId,
          continuable: created.continuable,
          background: created.background,
          budget: request.budget,
          modes,
        }, tx);
        return created;
      });
      logger.info('agent spawned', { agentId, role: agent.role, depth: agent.depth, parentAgentId: agent.parentAgentId });
      return agent;
    },

    async resume(agentId) {
      return db.transaction(async (tx) => {
        const agent = await selectAgent(tx, agentId, true);
        if (!agent) throw new HypertestError('not_found', `agent ${agentId} not found`, { details: { agentId } });
        if (agent.status === 'active') return agent;
        if (agent.status === 'disposed' || agent.status === 'failed') throw new HypertestError('precondition_failed', `agent ${agentId} is ${agent.status} and cannot be resumed`);
        if (agent.status === 'completed' && !agent.continuable) throw new HypertestError('precondition_failed', `agent ${agentId} is completed and not continuable`);
        // One transaction: the agent is reactivated, and the previous settled result is cleared — the continuation
        // settles a NEW result (collect never returns the stale one as current). A[4]: an engine with continuable
        // children reactivates its child session itself (engine.resumeChild at the agent's next step: resume_pending);
        // for an engine without them the host emulates it (the session is reactivated here).
        const engine = engines.get(agent.engineKind);
        const viaEngine = engine.capabilities?.continuableChild === true && typeof engine.resumeChild === 'function';
        if (!viaEngine) await sessions.setStatus(agent.sessionId, 'active');
        await tx.query(`UPDATE ht_agents SET result = NULL WHERE agent_id = $1`, [agentId]);
        // the session's last SETTLED turn now (an interrupted turn left mid-dispatch is not: the resume replays it): a
        // settled turn after it means the engine took the resume over (crash recovery, see the runner's pendingResume)
        let afterTurn: number | undefined;
        if (viaEngine) {
          const last = await sessions.lastTurn(agent.sessionId);
          afterTurn = last === undefined ? 0 : SETTLED_TURN_STATUSES.has(last.status) ? last.turn : Math.max(0, last.turn - 1);
        }
        await setResumePending(tx, agentId, viaEngine, afterTurn);
        const resumed = await agents.update(agentId, { status: 'active' });
        // (I10) the reactivation (e.g. a continuable child resumed for its parent's follow-up) is on L0 with the state change
        await emit(
          { runId: agent.runId, correlationId: agent.workItemId, actorId: 'system:runtime', workItemId: agent.workItemId },
          EVENT_TYPES.agentResumed,
          resumed,
          { agentId, from: agent.status, continuable: agent.continuable, background: agent.background, sessionId: agent.sessionId, via: viaEngine ? 'engine.resumeChild' : 'host_emulated' },
          tx,
        );
        return resumed;
      });
    },

    async message(agentId, message) {
      const agent = await mustGet(agentId);
      if (agent.status === 'disposed' || agent.status === 'failed' || (agent.status === 'completed' && !agent.continuable)) {
        throw new HypertestError('precondition_failed', `agent ${agentId} is ${agent.status}; it cannot receive messages`);
      }
      // A[4]: queued input reaches the model only through an engine that drains the session inbox (peerMessaging)
      if (engines.get(agent.engineKind).capabilities?.peerMessaging === false) {
        throw new HypertestError('precondition_failed', `agent ${agentId} runs on engine ${agent.engineKind}, which cannot receive messages (peerMessaging: false)`);
      }
      await sessions.enqueueInput(agent.sessionId, [message]);
    },

    async interrupt(agentId, reason, ctx) {
      const root = await mustGet(agentId);
      for (const a of await subtree(root)) {
        if (FINAL.has(a.status) || a.status === 'interrupted') continue;
        await engines.get(a.engineKind).interrupt({ session: ref(a), reason });
        // The status change and its L0 event commit together (a lost event would never be re-emitted: a retried
        // interrupt skips agents that are already interrupted).
        await db.transaction(async (tx) => {
          const updated = await agents.update(a.agentId, { status: 'interrupted' });
          await emit(ctx, EVENT_TYPES.agentInterrupted, updated, { agentId: a.agentId, reason, cascadedFrom: a.agentId === agentId ? null : agentId }, tx);
        });
      }
    },

    async collect(agentId) {
      const agent = await mustGet(agentId);
      const r = await db.query<{ result: unknown }>(`SELECT result FROM ht_agents WHERE agent_id = $1`, [agentId]);
      const settled = parseJson<SettledRecord>(r.rows[0]?.result);
      const out: SubagentResult = { agentId, status: agent.status, evidenceRefs: settled?.evidenceRefs ?? [], recordRefs: settled?.recordRefs ?? [] };
      if (settled?.summary !== undefined) out.summary = settled.summary;
      if (settled?.output !== undefined) out.output = settled.output;
      if (settled?.failure !== undefined) out.failure = settled.failure;
      return out;
    },

    async children(agentId) {
      await mustGet(agentId);
      return agents.children(agentId);
    },

    async capabilityOf(agentId) {
      await mustGet(agentId);
      return (await recordedGrant(agentId)).capability;
    },

    async dispose(agentId, ctx) {
      const root = await mustGet(agentId);
      for (const a of await subtree(root)) {
        if (a.status === 'disposed') continue;
        await engines.get(a.engineKind).dispose(ref(a));
        await db.transaction(async (tx) => {
          const updated = await agents.update(a.agentId, { status: 'disposed' });
          await emit(ctx, EVENT_TYPES.agentDisposed, updated, { agentId: a.agentId, cascadedFrom: a.agentId === agentId ? null : agentId }, tx);
        });
      }
    },

    async settle(agentId, result, ctx) {
      if (result?.status !== 'completed' && result?.status !== 'failed' && result?.status !== 'interrupted') {
        throw new HypertestError('invalid_argument', `settle status must be completed, failed or interrupted (got ${String(result?.status)})`);
      }
      assertStrings(result.evidenceRefs, 'evidenceRefs');
      assertStrings(result.recordRefs, 'recordRefs');
      // Only the result channel's fields are stored: nothing of the child's trace can leak through collect().
      const record: SettledRecord = { status: result.status, evidenceRefs: [...result.evidenceRefs], recordRefs: [...result.recordRefs] };
      if (result.summary !== undefined) record.summary = String(result.summary);
      if (result.output !== undefined) record.output = JSON.parse(JSON.stringify(result.output)) as JsonValue;
      if (result.failure !== undefined) record.failure = { reason: String(result.failure.reason), message: String(result.failure.message) };
      await db.transaction(async (tx) => {
        const agent = await selectAgent(tx, agentId, true);
        if (!agent) throw new HypertestError('not_found', `agent ${agentId} not found`, { details: { agentId } });
        const existing = await tx.query<{ result: unknown }>(`SELECT result FROM ht_agents WHERE agent_id = $1`, [agentId]);
        const prior = parseJson<SettledRecord>(existing.rows[0]?.result);
        if (prior !== undefined) {
          if (sameJson(prior, record)) return;
          throw new HypertestError('conflict', `agent ${agentId} is already settled with a different result`, { details: { agentId, status: prior.status } });
        }
        if (agent.status === 'disposed') throw new HypertestError('precondition_failed', `agent ${agentId} is disposed`);
        await tx.query(`UPDATE ht_agents SET result = $2::jsonb, status = $3, updated_at = $4 WHERE agent_id = $1`, [agentId, JSON.stringify(record), record.status, clock.isoNow()]);
      });
      logger.info('agent settled', { agentId, status: record.status, correlationId: ctx.correlationId });
    },
  };
}
