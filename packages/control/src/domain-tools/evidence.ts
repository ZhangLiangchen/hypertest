import { sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EvidenceRecord, ReportClaim } from '@hypertest/domain';
import { resolveClaim } from '@hypertest/evidence';
import type { ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { ControlStore } from '../store.ts';
import { clip } from '../util.ts';
import { cleared, roleClassification } from '../clearance.ts';
import { domainTool, refuse, success } from './common.ts';

interface ClaimInput {
  statement: string;
  value?: JsonValue;
  evidenceRefs: string[];
  critical?: boolean;
  evidenceQuery?: ReportClaim['evidenceQuery'];
}

const TEXTUAL = /^(text\/|application\/(json|xml|x-ndjson|yaml))/;

export function evidenceSummary(e: EvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: e.evidenceId,
    evidenceType: e.evidenceType,
    summary: e.summary,
    workItemId: e.workItemId,
    agentId: e.agentId,
    toolInvocationId: e.toolInvocationId,
    operationId: e.operationId,
    capturedAt: e.capturedAt,
    artifact: { uri: e.artifact.uri, sha256: e.artifact.sha256, size: e.artifact.size, mimeType: e.artifact.mimeType },
  };
}

export function evidenceTools(deps: ControlDeps): ToolSpec[] {
  const { evidence, artifacts, clock } = deps;
  const store = new ControlStore(deps.db);

  return [
    domainTool<{ evidenceId: string; maxBytes?: number }>({
      id: 'evidence.get',
      title: 'Get evidence',
      description: 'Read one evidence record of this run: metadata, structured payload and a bounded preview of its artifact text. Judge recorded outputs, not narratives.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceId'],
        properties: { evidenceId: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 64, maximum: 65536 } },
      },
      effect: 'read',
      area: 'evidence',
      async execute(input, ctx) {
        const e = await evidence.get(input.evidenceId);
        if (!e || e.runId !== ctx.runId) return refuse('not_found', `evidence ${input.evidenceId} does not exist in this run`);
        const clearance = roleClassification(deps.roles, ctx.role);
        if (!cleared(clearance, e.classification)) {
          return refuse('permission_denied', `evidence ${input.evidenceId} is classified ${e.classification}, above this agent's clearance (${clearance}); cite its id, but its content is withheld`);
        }
        let preview: string | undefined;
        if (TEXTUAL.test(e.artifact.mimeType)) {
          try {
            preview = await artifacts.getText(e.artifact, input.maxBytes ?? 4000);
          } catch (err) {
            preview = `[artifact unreadable: ${(err as Error).message}]`;
          }
        }
        const out: Record<string, unknown> = { ...evidenceSummary(e), parentEvidenceIds: e.parentEvidenceIds, provenance: e.provenance, recordHash: e.recordHash };
        if (e.structured !== undefined) out['structured'] = e.structured;
        if (preview !== undefined) out['preview'] = preview;
        return success(out);
      },
    }),

    domainTool<{ evidenceType?: string; workItemId?: string; limit?: number }>({
      id: 'evidence.query',
      title: 'Query evidence',
      description: 'List evidence records of this run (id, type, summary, producer), optionally filtered by evidence type and work item.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { evidenceType: { type: 'string', minLength: 1 }, workItemId: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
      effect: 'read',
      area: 'evidence',
      async execute(input, ctx) {
        const q: Parameters<typeof evidence.query>[0] = { runId: ctx.runId, limit: input.limit ?? 50 };
        if (input.evidenceType !== undefined) q.evidenceType = input.evidenceType;
        if (input.workItemId !== undefined) q.workItemId = input.workItemId;
        const all = await evidence.query(q);
        const clearance = roleClassification(deps.roles, ctx.role);
        const records = all.filter((e) => cleared(clearance, e.classification));
        const out: Record<string, unknown> = { evidence: records.map((e) => ({ ...evidenceSummary(e), summary: clip(e.summary, 500) })), count: records.length };
        if (records.length < all.length) out['withheld'] = { count: all.length - records.length, reason: `classified above this agent's clearance (${clearance})` };
        return success(out);
      },
    }),

    domainTool<ClaimInput>({
      id: 'evidence.claim',
      title: 'Record a claim',
      description:
        'Record a report claim (statement, optional value) backed by evidence ids of this run. The claim is stored only when every cited evidence exists, is intact, matches the evidenceQuery (type / work item / structured field) and — when a value is stated — the value EVALUATES true: evidenceQuery.field read from each cited record, reduced by evidenceQuery.aggregation (value (default: all equal), count, sum, avg, min, max, first, last, p50, p90, p95, p99) and compared with value (numbers within 0.5 %, strings/booleans exactly). Critical claims gate the QualityDecision (C9 re-evaluates them) and must state a value with evidenceQuery.field: a statement alone is not machine-verifiable (e.g. {statement: "avg TPS 103215", value: 103215, critical: true, evidenceQuery: {evidenceType: "metric", field: "avg_tps", aggregation: "avg"}}).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['statement', 'evidenceRefs'],
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 4000 },
          value: {},
          evidenceRefs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          critical: { type: 'boolean' },
          evidenceQuery: {
            type: 'object',
            additionalProperties: false,
            properties: { evidenceType: { type: 'string' }, workItemId: { type: 'string' }, field: { type: 'string' }, aggregation: { type: 'string' } },
          },
        },
      } as JsonSchema,
      area: 'claims',
      async execute(input, ctx) {
        // area-C-0: a critical claim gates the verdict, so it must be machine-verifiable — a number or fact only in the prose
        // of the statement is what the report must never assert as evidence-backed (technology-selection §Evidence Store)
        if (input.critical === true && (input.value === undefined || typeof input.evidenceQuery?.field !== 'string' || input.evidenceQuery.field === '')) {
          return refuse('unsupported_claim', `a critical claim must state its value with evidenceQuery.field (and an aggregation when several records or values are reduced), so that it is evaluated against the evidence: ${input.value === undefined ? 'no value is stated' : 'evidenceQuery.field is missing'} — a statement alone is not machine-verifiable`);
        }
        const claim: ReportClaim = {
          // retry-stable: a replayed call stores nothing twice (ht_claims ignores a known claim id)
          claimId: `clm_${sha256Hex(`${ctx.runId}\u0000${ctx.invocationId}`).slice(0, 26)}`,
          statement: input.statement,
          evidenceQuery: input.evidenceQuery ?? {},
          evidenceRefs: [...new Set(input.evidenceRefs)],
          critical: input.critical ?? false,
        };
        if (input.value !== undefined) claim.value = input.value;
        // area-C-0: the claim is EVALUATED (evidenceQuery aggregation over its evidence vs its value), not only referenced
        const resolution = await resolveClaim(evidence, claim, { runId: ctx.runId, artifacts });
        if (!resolution.supported) return refuse('unsupported_claim', `claim not supported by its evidence: ${resolution.problems.join('; ')}`, { problems: resolution.problems });
        await store.putClaim(ctx.runId, claim, clock.isoNow());
        return success({ claimId: claim.claimId, supported: true, evidenceRefs: claim.evidenceRefs, critical: claim.critical, evaluation: resolution.evaluation?.detail });
      },
    }),
  ];
}
