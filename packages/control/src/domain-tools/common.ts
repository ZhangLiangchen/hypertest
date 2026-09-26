import { HypertestError, isHypertestError, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { AgentInstance, EvidenceRecord, TestRun, WorkItem } from '@hypertest/domain';
import type { ToolContext, ToolOutcome, ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { notFound } from '../util.ts';

/** Domain tools are record/read tools scoped to `run/<runId>/<area>` (capability scope `run/<runId>/**`). */
export interface DomainToolDef<I> {
  id: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** 'record' unless the tool only reads (read tools are parallel-safe). */
  effect?: 'read' | 'record';
  area: string;
  timeoutMs?: number;
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome>;
}

export function domainTool<I>(def: DomainToolDef<I>): ToolSpec<I> {
  const spec: ToolSpec<I> = {
    id: def.id,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    effect: def.effect ?? 'record',
    riskClass: 'low',
    resources: (_input, ctx) => [`run/${ctx.runId}/${def.area}`],
    timeoutMs: def.timeoutMs ?? 30_000,
    execute: async (input, ctx) => {
      try {
        return await def.execute(input, ctx);
      } catch (e) {
        // Domain refusals thrown by lower layers (conflict, not_found, permission_denied, …) are model-visible
        // failed outcomes; anything else propagates as a tool fault (the runtime reports it as failed/internal).
        if (isHypertestError(e) && e.code !== 'internal' && e.code !== 'unavailable' && e.code !== 'timeout') {
          return refuse(e.code, e.message, Object.keys(e.details).length ? (e.details as JsonValue) : undefined);
        }
        throw e;
      }
    },
  };
  if (def.outputSchema) spec.outputSchema = def.outputSchema;
  return spec;
}

/** A successful domain result; an explanatory text is followed by the structured JSON (the model always sees the ids). */
export function success(structured: Record<string, unknown>, text?: string, evidenceRefs?: string[]): ToolOutcome {
  const json = JSON.parse(JSON.stringify(structured)) as JsonValue;
  const out: ToolOutcome = { status: 'success', structured: json };
  if (text !== undefined) out.text = `${text}\n${JSON.stringify(json)}`;
  if (evidenceRefs && evidenceRefs.length > 0) out.evidenceRefs = evidenceRefs;
  return out;
}

/** A refused domain action: the model sees the reason and can correct itself (the call is not a fault). */
export function refuse(code: string, message: string, structured?: JsonValue): ToolOutcome {
  const out: ToolOutcome = { status: 'failed', error: { code, message } };
  if (structured !== undefined) out.structured = structured;
  return out;
}

/** The calling agent, its work item and its run (loaded on demand, all bound to the tool context). */
export class Caller {
  readonly #deps: ControlDeps;
  readonly ctx: ToolContext;
  #agent?: AgentInstance;
  #item?: WorkItem;
  #run?: TestRun;

  constructor(deps: ControlDeps, ctx: ToolContext) {
    this.#deps = deps;
    this.ctx = ctx;
  }

  get runId(): string {
    return this.ctx.runId;
  }
  get agentId(): string {
    return this.ctx.agentId;
  }
  get role(): string {
    return this.ctx.role;
  }

  async agent(): Promise<AgentInstance> {
    if (!this.#agent) {
      const a = await this.#deps.agents.get(this.ctx.agentId);
      if (!a || a.runId !== this.ctx.runId) throw new HypertestError('permission_denied', `agent ${this.ctx.agentId} is not an agent of run ${this.ctx.runId}`);
      this.#agent = a;
    }
    return this.#agent;
  }

  async item(): Promise<WorkItem> {
    if (!this.#item) {
      const w = await this.#deps.blackboard.getWorkItem(this.ctx.workItemId);
      if (!w || w.runId !== this.ctx.runId) throw notFound('work item', this.ctx.workItemId);
      this.#item = w;
    }
    return this.#item;
  }

  async run(): Promise<TestRun> {
    if (!this.#run) {
      const r = await this.#deps.runs.get(this.ctx.runId);
      if (!r) throw notFound('run', this.ctx.runId);
      this.#run = r;
    }
    return this.#run;
  }

  /** The model provider/route of the agent's current epoch (reviewer heterogeneity, oracle proposals). */
  async epoch(): Promise<{ provider?: string; routeId?: string; epochId?: string }> {
    const agent = await this.agent();
    const e = await this.#deps.epochs.current(agent.sessionId);
    return e ? { provider: e.provider, routeId: e.routeId, epochId: e.epochId } : {};
  }
}

/** Evidence-first: every cited evidence id must exist in THIS run's ledger. */
export async function checkEvidence(deps: ControlDeps, runId: string, refs: readonly string[]): Promise<{ ok: true; records: EvidenceRecord[] } | { ok: false; problems: string[] }> {
  const unique = [...new Set(refs)];
  if (unique.length === 0) return { ok: true, records: [] };
  const records = await deps.evidence.getMany(unique);
  const byId = new Map(records.map((r) => [r.evidenceId, r]));
  const problems: string[] = [];
  for (const id of unique) {
    const r = byId.get(id);
    if (!r) problems.push(`evidence ${id} does not exist`);
    else if (r.runId !== runId) problems.push(`evidence ${id} belongs to another run`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, records };
}

/** Blackboard records cited by id must exist in this run. */
export async function checkRecords(deps: ControlDeps, runId: string, refs: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const id of new Set(refs)) {
    const r = await deps.blackboard.getRecord(id);
    if (!r) problems.push(`record ${id} does not exist`);
    else if (r.runId !== runId) problems.push(`record ${id} belongs to another run`);
  }
  return problems;
}

export const STRING_LIST_SCHEMA = { type: 'array', items: { type: 'string', minLength: 1 } } as const;
