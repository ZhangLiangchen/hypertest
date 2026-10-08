import type { JsonSchema } from '@hypertest/core';

/**
 * JSON Schemas for LLM-facing domain payloads (tool inputs). They are the typed contract between a
 * model's proposal and Hypertest's deterministic validation. Keep them strict (additionalProperties false).
 */

const severity = { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] } as const;
const stringArray = { type: 'array', items: { type: 'string' } } as const;
const refSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['run', 'record', 'evidence', 'artifact', 'work_item', 'plan', 'file', 'commit', 'url', 'oracle', 'experiment', 'test_artifact', 'system_model', 'operation', 'decision'] },
    id: { type: 'string', minLength: 1 },
    note: { type: 'string' },
  },
} as const;

const evidenceRequirement = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceType', 'minCount'],
  properties: {
    evidenceType: { type: 'string', minLength: 1 },
    minCount: { type: 'integer', minimum: 1 },
    description: { type: 'string' },
    critical: { type: 'boolean' },
  },
} as const;

const resourceClaim = {
  type: 'object',
  additionalProperties: false,
  required: ['resourceKey', 'mode'],
  properties: {
    resourceKey: { type: 'string', minLength: 1 },
    mode: { type: 'string', enum: ['read_shared', 'write_exclusive', 'fault_exclusive'] },
    quantity: { type: 'integer', minimum: 1 },
  },
} as const;

export const PLANNED_WORK_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['localId', 'title', 'objective', 'role', 'dependsOn', 'objectiveIds'],
  properties: {
    localId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    objective: { type: 'string', minLength: 1, maxLength: 4000 },
    role: { type: 'string', minLength: 1 },
    dependsOn: stringArray,
    objectiveIds: stringArray,
    inputRefs: { type: 'array', items: refSchema },
    expectedOutput: { type: 'object' },
    evidenceRequirements: { type: 'array', items: evidenceRequirement },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxTurns: { type: 'integer', minimum: 1 },
        maxTokens: { type: 'integer', minimum: 1 },
        maxCostUsd: { type: 'number', minimum: 0 },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxWallClockMs: { type: 'integer', minimum: 1 },
      },
    },
    priority: { type: 'integer', minimum: 0, maximum: 100 },
    toolPolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['allow'],
      properties: { allow: stringArray, deny: stringArray },
    },
    modelPolicy: { type: 'object' },
    resourceClaims: { type: 'array', items: resourceClaim },
  },
};

export const OBJECTIVE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objectiveId', 'description', 'priority'],
  properties: {
    objectiveId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    description: { type: 'string', minLength: 1 },
    priority: severity,
    riskRefs: stringArray,
    acceptanceCriteria: stringArray,
    status: { type: 'string', enum: ['open', 'satisfied', 'unsatisfiable', 'dropped'] },
  },
};

/** Input of `plan.propose_revision` (Lead only). */
export const PLAN_PROPOSAL_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rationale', 'objectives', 'workItems'],
  properties: {
    rationale: { type: 'string', minLength: 1 },
    objectives: { type: 'array', items: OBJECTIVE_SCHEMA },
    workItems: { type: 'array', items: PLANNED_WORK_ITEM_SCHEMA, maxItems: 50 },
    cancelWorkItems: stringArray,
    assumptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement'],
        properties: { statement: { type: 'string' }, status: { type: 'string', enum: ['unverified', 'verified', 'refuted'] } },
      },
    },
    readyForGate: { type: 'boolean' },
  },
};

/** Input of `blackboard.post_finding`. Evidence-first: product defects must cite evidence. */
export const FINDING_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'severity', 'category', 'evidenceRefs'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 300 },
    description: { type: 'string', minLength: 1 },
    severity,
    category: { type: 'string', enum: ['product_defect', 'test_defect', 'infrastructure', 'environment', 'performance', 'security', 'unknown'] },
    component: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    reproduction: { type: 'string' },
    testArtifactId: { type: 'string' },
    experimentId: { type: 'string' },
    oracleRef: {
      type: 'object',
      additionalProperties: false,
      required: ['oracleId', 'revision'],
      properties: { oracleId: { type: 'string' }, revision: { type: 'integer' }, assertionId: { type: 'string' } },
    },
    evidenceRefs: stringArray,
    /** Supersede an existing finding lineage (status update). */
    updatesRecordId: { type: 'string' },
    status: { type: 'string', enum: ['open', 'confirmed', 'rejected', 'fixed', 'verified_fixed', 'accepted_risk', 'duplicate'] },
    duplicateOf: { type: 'string' },
  },
};

export const HYPOTHESIS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['statement', 'confidence'],
  properties: {
    findingRecordId: { type: 'string' },
    statement: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['open', 'supported', 'refuted', 'inconclusive'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    suggestedChecks: stringArray,
    evidenceRefs: stringArray,
    updatesRecordId: { type: 'string' },
  },
};

export const COVERAGE_GAP_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'description'],
  properties: {
    area: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    relatedFindingRecordId: { type: 'string' },
    relatedRiskRecordId: { type: 'string' },
    evidenceRefs: stringArray,
    status: { type: 'string', enum: ['open', 'addressed', 'accepted'] },
    updatesRecordId: { type: 'string' },
  },
};

export const RISK_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'likelihood', 'impact', 'source'],
  properties: {
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    likelihood: { type: 'string', enum: ['low', 'medium', 'high'] },
    impact: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    componentRefs: stringArray,
    source: { type: 'string', enum: ['change_analysis', 'architecture', 'history', 'runtime', 'review', 'requirement'] },
    status: { type: 'string', enum: ['open', 'mitigated', 'verified', 'accepted'] },
    evidenceRefs: stringArray,
    updatesRecordId: { type: 'string' },
  },
};

export const REVIEW_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subjectRef', 'verdict', 'rationale', 'checkedEvidenceRefs'],
  properties: {
    subjectRef: refSchema,
    verdict: { type: 'string', enum: ['approve', 'reject', 'needs_more_evidence', 'unknown'] },
    rationale: { type: 'string', minLength: 1 },
    checkedEvidenceRefs: stringArray,
  },
};

export const ORACLE_ASSERTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['assertionId', 'description', 'kind', 'severity'],
  properties: {
    assertionId: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['deterministic_invariant', 'requirement', 'differential', 'metamorphic', 'statistical', 'llm_semantic'] },
    severity,
    check: { type: 'object' },
  },
};

export const ORACLE_CHANGE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['oracleId', 'fromRevision', 'proposedAssertions', 'rationale'],
  properties: {
    oracleId: { type: 'string' },
    fromRevision: { type: 'integer', minimum: 1 },
    proposedAssertions: { type: 'array', items: ORACLE_ASSERTION_SCHEMA },
    rationale: { type: 'string', minLength: 1 },
    relatedEvidenceRefs: stringArray,
  },
};

export const TEST_ARTIFACT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'sourceType', 'runner', 'oracleRefs'],
  properties: {
    path: { type: 'string', minLength: 1 },
    sourceType: { type: 'string', enum: ['existing', 'generated', 'repaired', 'mutated'] },
    runner: {
      type: 'object',
      additionalProperties: false,
      required: ['framework', 'selector'],
      properties: {
        framework: { type: 'string' },
        selector: { type: 'string' },
        command: stringArray,
        workingDirectory: { type: 'string' },
      },
    },
    oracleRefs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['oracleId', 'revision', 'assertionIds'],
        properties: { oracleId: { type: 'string' }, revision: { type: 'integer' }, assertionIds: stringArray },
      },
    },
    experimentId: { type: 'string' },
    supersedesArtifactId: { type: 'string' },
  },
};

export const SYSTEM_MODEL_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['components'],
  properties: {
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['componentId', 'name', 'kind', 'paths'],
        properties: {
          componentId: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['service', 'library', 'module', 'database', 'queue', 'ui', 'cli', 'external', 'other'] },
          paths: stringArray,
          description: { type: 'string' },
          riskTags: stringArray,
        },
      },
    },
    interfaces: { type: 'array', items: { type: 'object' } },
    dependencies: { type: 'array', items: { type: 'object' } },
    stateMachines: { type: 'array', items: { type: 'object' } },
    invariants: stringArray,
    // (additive, coverage-12) the design's dataAssets and securityBoundaries, and the model's provenance (sources)
    dataAssets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId', 'name', 'kind'],
        properties: {
          assetId: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ['database', 'table', 'collection', 'bucket', 'queue', 'topic', 'cache', 'file', 'secret', 'other'] },
          componentId: { type: 'string' },
          classification: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
          description: { type: 'string' },
        },
      },
    },
    securityBoundaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['boundaryId', 'name', 'kind', 'components'],
        properties: {
          boundaryId: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ['network', 'authentication', 'authorization', 'tenant', 'process', 'trust', 'other'] },
          components: stringArray,
          description: { type: 'string' },
        },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'id'],
        properties: { kind: { type: 'string', enum: ['evidence', 'file', 'commit', 'url', 'record', 'artifact'] }, id: { type: 'string', minLength: 1 }, note: { type: 'string' } },
      },
    },
    changedComponents: stringArray,
    riskTags: stringArray,
  },
};

/** Base schema for `complete_work`; the work item's expectedOutput (if any) validates `output`. */
export const WORK_COMPLETION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 8000 },
    output: {},
    evidenceRefs: stringArray,
    recordRefs: stringArray,
  },
};
