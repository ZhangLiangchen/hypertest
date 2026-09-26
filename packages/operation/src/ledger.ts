import { HypertestError, fromJsonColumn, toIso, toNumber, type SqlExecutor, type SqlParam } from '@hypertest/core';
import { canTransitionOperation, eventFrom, type EventContext, type OperationRecord, type OperationStatus, type ResourceRef } from '@hypertest/domain';
import type { LedgerOperationRecord, OperationDeps, OperationLedger, PrepareOperationInput } from './contracts.ts';

/** Statuses whose external outcome is not settled yet (reconciled before any new dispatch). */
export const UNSETTLED_OPERATION_STATUSES: readonly OperationStatus[] = ['dispatching', 'acknowledged', 'outcome_unknown', 'reconciling'];

const COLUMNS = `operation_id, run_id, work_item_id, agent_id, tool_invocation_id, operation_type, adapter_id, target,
  desired_state_hash, input_hash, idempotency_key, lease, status, external_job_id, external_receipt, attempt, result,
  (result IS NOT NULL) AS has_result, last_error, evidence_refs, created_at, updated_at, experiment_id`;

interface OperationRow {
  operation_id: string;
  run_id: string;
  work_item_id: string;
  agent_id: string | null;
  tool_invocation_id: string | null;
  operation_type: string;
  adapter_id: string;
  target: unknown;
  desired_state_hash: string;
  input_hash: string;
  idempotency_key: string;
  lease: unknown;
  status: OperationStatus;
  external_job_id: string | null;
  external_receipt: string | null;
  attempt: unknown;
  result: unknown;
  has_result: boolean;
  last_error: string | null;
  evidence_refs: unknown;
  created_at: unknown;
  updated_at: unknown;
  experiment_id: string | null;
}

/** (additive, conformance-6) The experiment an operation was prepared for (undefined: none recorded). */
export function operationExperimentId(op: OperationRecord): string | undefined {
  const id = (op as LedgerOperationRecord).experimentId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function rowToRecord(r: OperationRow): OperationRecord {
  const rec: LedgerOperationRecord = {
    operationId: r.operation_id,
    runId: r.run_id,
    workItemId: r.work_item_id,
    operationType: r.operation_type,
    adapterId: r.adapter_id,
    target: fromJsonColumn<ResourceRef>(r.target),
    desiredStateHash: r.desired_state_hash,
    inputHash: r.input_hash,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    attempt: toNumber(r.attempt),
    evidenceRefs: fromJsonColumn<string[]>(r.evidence_refs) ?? [],
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
  if (r.agent_id !== null) rec.agentId = r.agent_id;
  if (r.tool_invocation_id !== null) rec.toolInvocationId = r.tool_invocation_id;
  const lease = r.lease === null ? null : fromJsonColumn<OperationRecord['lease'] | null>(r.lease);
  if (lease) rec.lease = lease;
  if (r.external_job_id !== null) rec.externalJobId = r.external_job_id;
  if (r.external_receipt !== null) rec.externalReceipt = r.external_receipt;
  // jsonb 'null' is not SQL NULL: a recorded null result is preserved as null.
  if (r.has_result) rec.result = fromJsonColumn<unknown>(r.result);
  if (r.last_error !== null) rec.lastError = r.last_error;
  if (r.experiment_id !== null && r.experiment_id !== undefined) rec.experimentId = r.experiment_id;
  return rec;
}

/** JSON text for a jsonb parameter (arrays and scalars included); undefined ⇒ SQL NULL. */
export function jsonParam(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

/**
 * Event type emitted for a ledger transition. Catalog names are used where they exist
 * (prepared/dispatched/verified/outcome_unknown/reconciled/manual_review); the remaining transitions
 * use the same `operation.<status>` naming so every state change is auditable (I10).
 */
export function operationEventType(from: OperationStatus | undefined, to: OperationStatus): string {
  if (from === undefined) return 'operation.prepared';
  if (from === 'reconciling' && (to === 'acknowledged' || to === 'not_applied')) return 'operation.reconciled';
  switch (to) {
    case 'dispatching':
      return 'operation.dispatched';
    default:
      return `operation.${to}`;
  }
}

function requireText(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new HypertestError('invalid_argument', `${name} must be a non-empty string`);
}

export function createOperationLedger(deps: OperationDeps): OperationLedger {
  const { db, clock, ids, logger } = deps;
  const inTx = <T>(tx: SqlExecutor | undefined, fn: (x: SqlExecutor) => Promise<T>): Promise<T> => (tx ? fn(tx) : db.transaction(fn));

  async function emit(x: SqlExecutor, ctx: EventContext, rec: OperationRecord, from: OperationStatus | undefined): Promise<void> {
    if (!deps.events) return;
    const payload: Record<string, unknown> = {
      operationId: rec.operationId,
      operationType: rec.operationType,
      adapterId: rec.adapterId,
      resourceKey: rec.target.resourceKey,
      idempotencyKey: rec.idempotencyKey,
      from: from ?? null,
      to: rec.status,
      attempt: rec.attempt,
    };
    if (rec.toolInvocationId !== undefined) payload['toolInvocationId'] = rec.toolInvocationId;
    if (rec.externalJobId !== undefined) payload['externalJobId'] = rec.externalJobId;
    if (rec.externalReceipt !== undefined) payload['externalReceipt'] = rec.externalReceipt;
    if (rec.lease) payload['fencingToken'] = rec.lease.fencingToken;
    const experimentId = operationExperimentId(rec);
    if (experimentId !== undefined) payload['experimentId'] = experimentId;
    if (rec.lastError !== undefined && rec.status !== 'verified' && rec.status !== 'dispatching') payload['reason'] = rec.lastError;
    const event = eventFrom(ctx, operationEventType(from, rec.status), 'operation', rec.operationId, payload);
    // The operation's own run/work item win over the caller context so per-run streams stay correct.
    event.runId = rec.runId;
    event.workItemId = ctx.workItemId ?? rec.workItemId;
    const agentId = ctx.agentId ?? rec.agentId;
    if (agentId !== undefined) event.agentId = agentId;
    await deps.events.emit([event], x);
  }

  async function selectOne(x: SqlExecutor, where: string, params: SqlParam[], lock = false): Promise<OperationRecord | undefined> {
    const r = await x.query<OperationRow>(`SELECT ${COLUMNS} FROM ht_operations WHERE ${where}${lock ? ' FOR UPDATE' : ''}`, params);
    return r.rows[0] ? rowToRecord(r.rows[0]) : undefined;
  }

  const ledger: OperationLedger = {
    async prepare(input: PrepareOperationInput, ctx: EventContext, tx?: SqlExecutor): Promise<OperationRecord> {
      requireText(input.runId, 'runId');
      requireText(input.workItemId, 'workItemId');
      requireText(input.operationType, 'operationType');
      requireText(input.adapterId, 'adapterId');
      requireText(input.desiredStateHash, 'desiredStateHash');
      requireText(input.inputHash, 'inputHash');
      if (!input.target || typeof input.target.resourceKey !== 'string' || input.target.resourceKey.length === 0) {
        throw new HypertestError('invalid_argument', 'target.resourceKey must be a non-empty string');
      }
      if (input.toolInvocationId !== undefined) requireText(input.toolInvocationId, 'toolInvocationId');
      if (input.experimentId !== undefined) requireText(input.experimentId, 'experimentId');
      const operationId = input.operationId ?? ids.next('op');
      const idempotencyKey = input.idempotencyKey ?? operationId;
      requireText(operationId, 'operationId');
      requireText(idempotencyKey, 'idempotencyKey');
      const now = clock.isoNow();
      return inTx(tx, async (x) => {
        const inserted = await x.query<OperationRow>(
          `INSERT INTO ht_operations (operation_id, run_id, work_item_id, agent_id, tool_invocation_id, operation_type, adapter_id, target,
             desired_state_hash, input_hash, idempotency_key, lease, status, attempt, evidence_refs, created_at, updated_at, experiment_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, 'prepared', 0, '[]'::jsonb, $13, $13, $14)
           ON CONFLICT DO NOTHING
           RETURNING ${COLUMNS}`,
          [
            operationId,
            input.runId,
            input.workItemId,
            input.agentId ?? null,
            input.toolInvocationId ?? null,
            input.operationType,
            input.adapterId,
            jsonParam(input.target),
            input.desiredStateHash,
            input.inputHash,
            idempotencyKey,
            jsonParam(input.lease),
            now,
            input.experimentId ?? null,
          ],
        );
        if (inserted.rows[0]) {
          const rec = rowToRecord(inserted.rows[0]);
          await emit(x, ctx, rec, undefined);
          return rec;
        }
        // Idempotent path: the same key, id, or (toolInvocationId, operationType) already exists.
        const existing = await selectOne(
          x,
          `idempotency_key = $1 OR operation_id = $2 OR (tool_invocation_id = $3 AND operation_type = $4)
           ORDER BY CASE WHEN idempotency_key = $1 THEN 0 WHEN operation_id = $2 THEN 1 ELSE 2 END, created_at, operation_id LIMIT 1`,
          [idempotencyKey, operationId, input.toolInvocationId ?? null, input.operationType],
        );
        if (!existing) throw new HypertestError('internal', `operation insert conflicted but no existing record was found (${operationId})`);
        if (
          existing.runId !== input.runId ||
          existing.operationType !== input.operationType ||
          existing.adapterId !== input.adapterId ||
          existing.inputHash !== input.inputHash
        ) {
          throw new HypertestError('conflict', 'idempotency key / tool invocation reused for a different operation', {
            details: {
              existingOperationId: existing.operationId,
              existing: { runId: existing.runId, operationType: existing.operationType, adapterId: existing.adapterId, inputHash: existing.inputHash },
              requested: { runId: input.runId, operationType: input.operationType, adapterId: input.adapterId, inputHash: input.inputHash },
            },
          });
        }
        logger.debug('operation prepare deduplicated', { operationId: existing.operationId, idempotencyKey });
        return existing;
      });
    },

    get(operationId: string): Promise<OperationRecord | undefined> {
      return selectOne(db, 'operation_id = $1', [operationId]);
    },

    findByIdempotencyKey(key: string): Promise<OperationRecord | undefined> {
      return selectOne(db, 'idempotency_key = $1', [key]);
    },

    findByToolInvocation(toolInvocationId: string, operationType?: string): Promise<OperationRecord | undefined> {
      if (operationType !== undefined) return selectOne(db, 'tool_invocation_id = $1 AND operation_type = $2', [toolInvocationId, operationType]);
      return selectOne(db, 'tool_invocation_id = $1 ORDER BY created_at, operation_id LIMIT 1', [toolInvocationId]);
    },

    async transition(operationId, to, patch, ctx, options = {}): Promise<OperationRecord> {
      return inTx(options.tx, async (x) => {
        const current = await selectOne(x, 'operation_id = $1', [operationId], true);
        if (!current) throw new HypertestError('not_found', `operation ${operationId} not found`);
        const from = current.status;
        if (options.expectedFrom && !options.expectedFrom.includes(from)) {
          throw new HypertestError('conflict', `operation ${operationId} is ${from}, expected ${options.expectedFrom.join('|')}`, {
            details: { operationId, expected: options.expectedFrom, actual: from, to },
          });
        }
        if (options.expectedAttempt !== undefined && options.expectedAttempt !== current.attempt) {
          throw new HypertestError('conflict', `operation ${operationId} is at attempt ${current.attempt}, expected ${options.expectedAttempt}`, {
            details: { operationId, expectedAttempt: options.expectedAttempt, actualAttempt: current.attempt, status: from, to },
          });
        }
        if (!canTransitionOperation(from, to)) {
          throw new HypertestError('precondition_failed', `illegal operation transition ${from} → ${to}`, { details: { operationId, from, to } });
        }
        const next: OperationRecord = { ...current, status: to, updatedAt: clock.isoNow() };
        if (to === 'dispatching') {
          next.attempt = current.attempt + 1;
          // externalJobId/externalReceipt describe the CURRENT attempt: a new dispatch has no receipt yet.
          // Keeping the previous attempt's job id would let reconciliation observe (and attach to) the
          // wrong job. The previous values stay in the operation's event history.
          delete next.externalJobId;
          delete next.externalReceipt;
        }
        if (patch.externalJobId !== undefined) next.externalJobId = patch.externalJobId;
        if (patch.externalReceipt !== undefined) next.externalReceipt = patch.externalReceipt;
        if (patch.result !== undefined) next.result = patch.result;
        if (patch.lastError !== undefined) next.lastError = patch.lastError;
        if (patch.lease !== undefined) next.lease = patch.lease;
        if (patch.evidenceRefs !== undefined) {
          // Evidence references are append-only (I6): a patch can add refs, never drop them.
          next.evidenceRefs = [...current.evidenceRefs, ...patch.evidenceRefs.filter((r) => !current.evidenceRefs.includes(r))].filter(
            (r, i, all) => all.indexOf(r) === i,
          );
        }
        const updated = await x.query<OperationRow>(
          `UPDATE ht_operations SET status = $2, attempt = $3, external_job_id = $4, external_receipt = $5, result = $6::jsonb,
             last_error = $7, evidence_refs = $8::jsonb, lease = $9::jsonb, updated_at = $10
           WHERE operation_id = $1
           RETURNING ${COLUMNS}`,
          [
            operationId,
            next.status,
            next.attempt,
            next.externalJobId ?? null,
            next.externalReceipt ?? null,
            'result' in next ? jsonParam(next.result ?? null) : null,
            next.lastError ?? null,
            jsonParam(next.evidenceRefs),
            jsonParam(next.lease),
            next.updatedAt,
          ],
        );
        const rec = rowToRecord(updated.rows[0]!);
        await emit(x, ctx, rec, from);
        return rec;
      });
    },

    async list(filter): Promise<OperationRecord[]> {
      const where = ['run_id = $1'];
      const params: SqlParam[] = [filter.runId];
      if (filter.workItemId !== undefined) {
        params.push(filter.workItemId);
        where.push(`work_item_id = $${params.length}`);
      }
      if (filter.status !== undefined) {
        params.push(filter.status);
        where.push(`status = ANY($${params.length}::text[])`);
      }
      if (filter.experimentId !== undefined) {
        params.push(filter.experimentId);
        where.push(`experiment_id = $${params.length}`);
      }
      const r = await db.query<OperationRow>(`SELECT ${COLUMNS} FROM ht_operations WHERE ${where.join(' AND ')} ORDER BY created_at, operation_id`, params);
      return r.rows.map(rowToRecord);
    },

    async listUnsettled(runId?: string): Promise<OperationRecord[]> {
      const params: SqlParam[] = [[...UNSETTLED_OPERATION_STATUSES]];
      let where = 'status = ANY($1::text[])';
      if (runId !== undefined) {
        params.push(runId);
        where += ' AND run_id = $2';
      }
      const r = await db.query<OperationRow>(`SELECT ${COLUMNS} FROM ht_operations WHERE ${where} ORDER BY created_at, operation_id`, params);
      return r.rows.map(rowToRecord);
    },
  };
  return ledger;
}
