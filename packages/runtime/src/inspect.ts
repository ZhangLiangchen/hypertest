import { isHypertestError } from '@hypertest/core';
import type { AgentInstance } from '@hypertest/domain';
import type { AgentRepository, EngineRegistryLike, EngineSessionState, EpochManager, ModelPause } from './contracts.ts';
import { capabilityModes, type CapabilityMode } from './capabilities.ts';

/** (A[4]) One agent of a run as `hypertest status` / GET /runs/:id/agents show it: identity, engine state, route, pause. */
export interface AgentView {
  agentId: string;
  role: string;
  workItemId: string;
  parentAgentId?: string;
  depth: number;
  status: AgentInstance['status'];
  continuable: boolean;
  background: boolean;
  engineKind: string;
  /** engine.inspect(): the engine's own view of the session (or why it could not be read). */
  engine: EngineSessionState | { error: string };
  /** How the host uses each of the engine's capabilities (engine / host_emulated / refused). */
  capabilities: Record<string, CapabilityMode | 'refused'>;
  /** The agent's current ModelEpoch. */
  epoch?: { epochId: string; routeId: string; provider: string; model: string; switchReason: string; startedAtTurn: number };
  /** A[0]: set while the agent is paused for model unavailability. */
  modelPause?: ModelPause;
}

/**
 * (A[4]) The run's agents through the AgentEngine ABI: each agent's session state comes from its engine's `inspect`
 * (never assumed from the host's own tables), with the engine capability modes, the current epoch and any model pause.
 */
export async function inspectAgents(deps: { agents: Pick<AgentRepository, 'list'>; engines: EngineRegistryLike; epochs?: Pick<EpochManager, 'current' | 'modelPause'> }, runId: string): Promise<AgentView[]> {
  const out: AgentView[] = [];
  for (const a of await deps.agents.list({ runId })) {
    let engineState: AgentView['engine'];
    let caps: AgentView['capabilities'] = {};
    try {
      const engine = deps.engines.get(a.engineKind);
      caps = capabilityModes(engine);
      engineState = await engine.inspect({ sessionId: a.sessionId, engineKind: a.engineKind });
    } catch (e) {
      if (!isHypertestError(e) && !(e instanceof Error)) throw e;
      engineState = { error: (e as Error).message };
    }
    const view: AgentView = {
      agentId: a.agentId, role: a.role, workItemId: a.workItemId, depth: a.depth, status: a.status, continuable: a.continuable, background: a.background, engineKind: a.engineKind,
      engine: engineState, capabilities: caps,
    };
    if (a.parentAgentId) view.parentAgentId = a.parentAgentId;
    const epoch = deps.epochs ? await deps.epochs.current(a.sessionId) : undefined;
    if (epoch) view.epoch = { epochId: epoch.epochId, routeId: epoch.routeId, provider: epoch.provider, model: epoch.model, switchReason: epoch.switchReason, startedAtTurn: epoch.startedAtTurn };
    const pause = deps.epochs?.modelPause ? await deps.epochs.modelPause(a.sessionId) : undefined;
    if (pause) view.modelPause = pause;
    out.push(view);
  }
  return out;
}
