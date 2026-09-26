import { sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EvidenceRecord, ReportClaim } from '@hypertest/domain';
import { resolveClaim } from '@hypertest/evidence';
import type { ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { ControlStore } from '../store.ts';
import { clip } from '../util.ts';
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
        const records = await evidence.query(q);
        return success({ evidence: records.map((e) => ({ ...evidenceSummary(e), summary: clip(e.summary, 500) })), count: records.length });
      },
    }),

    domainTool<ClaimInput>({
      id: 'evidence.claim',
      title: 'Record a claim',
      description:
        'Record a report claim (statement, optional value) backed by evidence ids of this run. The claim is stored only when every cited evidence exists, is intact and matches the evidenceQuery (type / work item / structured field). Critical claims gate the QualityDecision.',
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
        const claim: ReportClaim = {
          // retry-stable: a replayed call stores nothing twice (ht_claims ignores a known claim id)
          claimId: `clm_${sha256Hex(`${ctx.runId}\u0000${ctx.invocationId}`).slice(0, 26)}`,
          statement: input.statement,
          evidenceQuery: input.evidenceQuery ?? {},
          evidenceRefs: [...new Set(input.evidenceRefs)],
          critical: input.critical ?? false,
        };
        if (input.value !== undefined) claim.value = input.value;
        const resolution = await resolveClaim(evidence, claim, { runId: ctx.runId });
        if (!resolution.supported) return refuse('unsupported_claim', `claim not supported by its evidence: ${resolution.problems.join('; ')}`, { problems: resolution.problems });
        await store.putClaim(ctx.runId, claim, clock.isoNow());
        return success({ claimId: claim.claimId, supported: true, evidenceRefs: claim.evidenceRefs, critical: claim.critical });
      },
    }),
  ];
}
