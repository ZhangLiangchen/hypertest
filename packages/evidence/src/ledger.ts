import { HypertestError, fromJsonColumn, toIso, toNumber, type SqlExecutor, type SqlParam } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER,
  EVENT_TYPES,
  type DataClassification,
  type DomainEventInput,
  type EnvironmentRef,
  type EvidenceInput,
  type EvidenceProducer,
  type EvidenceRecord,
  type EvidenceSeal,
  type Provenance,
} from '@hypertest/domain';
import type { JsonValue } from '@hypertest/core';
import type { EvidenceEventOptions, EvidenceLedger, EvidenceLedgerDeps, EvidenceQuery, EvidenceVerification, EvidenceVerifyOptions } from './contracts.ts';
import { casUri, isSha256Hex, merkleRootUnchecked, parseArtifactLocator } from './hash.ts';
import { storableJson, storableString } from './normalize.ts';
import { computeMetadataHash, computeRecordHash, sealMessage, verifyEvidenceRecords } from './records.ts';
import { verifyEd25519 } from './signer.ts';

export const DEFAULT_CLASSIFICATION: DataClassification = 'internal';
export const DEFAULT_RETENTION_POLICY = 'default';

const SELECT_COLUMNS = `evidence_id, run_id, seq, evidence_type, artifact_uri, artifact_sha256, artifact_size, artifact_mime_type,
  summary, structured::text AS structured_text, work_item_id, agent_id, tool_invocation_id, operation_id, environment,
  parent_evidence_ids, classification, retention_policy, producer, provenance, trace_id, captured_at, metadata_hash,
  previous_record_hash, record_hash`;

const SEAL_COLUMNS = 'seal_id, run_id, seal_no, root_hash, record_count, last_seq, key_id, algorithm, signature, sealed_at';

interface EvidenceRow {
  evidence_id: string;
  run_id: string;
  seq: unknown;
  evidence_type: string;
  artifact_uri: string;
  artifact_sha256: string;
  artifact_size: unknown;
  artifact_mime_type: string;
  summary: string;
  structured_text: string | null;
  work_item_id: string | null;
  agent_id: string | null;
  tool_invocation_id: string | null;
  operation_id: string | null;
  environment: unknown;
  parent_evidence_ids: unknown;
  classification: string;
  retention_policy: string;
  producer: unknown;
  provenance: unknown;
  trace_id: string | null;
  captured_at: unknown;
  metadata_hash: string;
  previous_record_hash: string | null;
  record_hash: string;
}

interface SealRow {
  seal_id: string;
  run_id: string;
  seal_no: unknown;
  root_hash: string;
  record_count: unknown;
  last_seq: unknown;
  key_id: string;
  algorithm: string;
  signature: string;
  sealed_at: unknown;
}

function rowToRecord(row: EvidenceRow): EvidenceRecord {
  const record: EvidenceRecord = {
    evidenceId: row.evidence_id,
    runId: row.run_id,
    seq: toNumber(row.seq),
    evidenceType: row.evidence_type,
    artifact: { uri: row.artifact_uri, sha256: row.artifact_sha256, size: toNumber(row.artifact_size), mimeType: row.artifact_mime_type },
    summary: row.summary,
    parentEvidenceIds: fromJsonColumn<string[]>(row.parent_evidence_ids) ?? [],
    classification: row.classification as DataClassification,
    retentionPolicy: row.retention_policy,
    producer: fromJsonColumn<EvidenceProducer>(row.producer),
    provenance: fromJsonColumn<Provenance>(row.provenance),
    capturedAt: toIso(row.captured_at),
    metadataHash: row.metadata_hash,
    recordHash: row.record_hash,
  };
  // structured is read as text so a JSON `null` payload stays distinguishable from an absent one.
  if (row.structured_text !== null && row.structured_text !== undefined) record.structured = JSON.parse(row.structured_text) as JsonValue;
  if (row.work_item_id !== null) record.workItemId = row.work_item_id;
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.tool_invocation_id !== null) record.toolInvocationId = row.tool_invocation_id;
  if (row.operation_id !== null) record.operationId = row.operation_id;
  if (row.environment !== null && row.environment !== undefined) record.environment = fromJsonColumn<EnvironmentRef>(row.environment);
  if (row.trace_id !== null) record.traceId = row.trace_id;
  if (row.previous_record_hash !== null) record.previousRecordHash = row.previous_record_hash;
  return record;
}

function rowToSeal(row: SealRow): EvidenceSeal {
  return {
    runId: row.run_id,
    rootHash: row.root_hash,
    count: toNumber(row.record_count),
    lastSeq: toNumber(row.last_seq),
    keyId: row.key_id,
    algorithm: row.algorithm as 'ed25519',
    signature: row.signature,
    sealedAt: toIso(row.sealed_at),
  };
}

function invalid(message: string, details?: Record<string, unknown>): HypertestError {
  return new HypertestError('invalid_argument', message, details ? { details } : {});
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw invalid(`evidence ${name} must be a${allowEmpty ? '' : ' non-empty'} string`);
  return storableString(value, name);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertRunId(runId: unknown): string {
  return requireString(runId, 'runId');
}

/**
 * The stored uri must locate the same content as the ref's digest: a ref whose uri names another
 * digest (or cannot be resolved by any ArtifactStore) would make the hashed lineage point at bytes
 * other than the ones that were checked. Absent/empty ⇒ the store-neutral `cas://sha256/<hex>`.
 */
function artifactUri(uri: unknown, sha256: string): string {
  if (uri === undefined || uri === null || uri === '') return casUri(sha256);
  if (typeof uri !== 'string') throw invalid('evidence artifact.uri must be a string');
  let located: string;
  try {
    located = parseArtifactLocator(uri);
  } catch {
    throw invalid(`evidence artifact.uri is not a content address (cas://sha256/<hex> or s3://<bucket>/<prefix>sha256/<hex>): ${uri.slice(0, 120)}`);
  }
  if (located !== sha256) {
    throw new HypertestError('integrity_violation', `evidence artifact.uri names sha256:${located} but the ref declares sha256:${sha256}`, { details: { uri, sha256, uriSha256: located } });
  }
  return storableString(uri, 'artifact.uri');
}

interface NormalizedInput {
  base: Omit<EvidenceRecord, 'evidenceId' | 'seq' | 'capturedAt' | 'metadataHash' | 'previousRecordHash' | 'recordHash'>;
}

function normalizeInput(input: EvidenceInput): NormalizedInput {
  if (!isPlainObject(input)) throw invalid('evidence input must be an object');
  const runId = assertRunId(input.runId);
  const evidenceType = requireString(input.evidenceType, 'evidenceType');
  const summary = requireString(input.summary, 'summary', true);
  const a = input.artifact;
  if (!isPlainObject(a)) throw invalid('evidence artifact ref is required');
  const sha256 = typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
  if (!isSha256Hex(sha256)) throw invalid('evidence artifact.sha256 must be a sha256 hex digest', { sha256: a.sha256 });
  if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 0) throw invalid('evidence artifact.size must be a non-negative integer');
  const mimeType = requireString(a.mimeType, 'artifact.mimeType');
  const uri = artifactUri(a.uri, sha256);
  if (!isPlainObject(input.producer)) throw invalid('evidence producer is required');
  requireString(input.producer.workerId, 'producer.workerId');
  requireString(input.producer.runtimeManifestId, 'producer.runtimeManifestId');
  if (!isPlainObject(input.provenance)) throw invalid('evidence provenance is required');
  const classification = input.classification ?? DEFAULT_CLASSIFICATION;
  // Object.hasOwn, not `in`: inherited names such as 'toString' are not classifications.
  if (typeof classification !== 'string' || !Object.hasOwn(CLASSIFICATION_ORDER, classification)) throw invalid(`unknown data classification ${String(classification)}`);
  const retentionPolicy = input.retentionPolicy === undefined ? DEFAULT_RETENTION_POLICY : requireString(input.retentionPolicy, 'retentionPolicy');
  const parents: string[] = [];
  if (input.parentEvidenceIds !== undefined && input.parentEvidenceIds !== null) {
    if (!Array.isArray(input.parentEvidenceIds)) throw invalid('evidence parentEvidenceIds must be an array');
    for (const p of input.parentEvidenceIds) {
      const id = requireString(p, 'parentEvidenceIds[]');
      if (!parents.includes(id)) parents.push(id);
    }
  }
  const base: NormalizedInput['base'] = {
    runId,
    evidenceType,
    artifact: { uri, sha256, size: a.size, mimeType },
    summary,
    parentEvidenceIds: parents,
    classification,
    retentionPolicy,
    producer: storableJson(input.producer, 'producer'),
    provenance: storableJson(input.provenance, 'provenance'),
  };
  if (input.structured !== undefined) base.structured = storableJson(input.structured, 'structured');
  if (input.environment !== undefined && input.environment !== null) {
    if (!isPlainObject(input.environment)) throw invalid('evidence environment must be an object');
    base.environment = storableJson(input.environment, 'environment');
  }
  const workItemId = optionalString(input.workItemId, 'workItemId');
  if (workItemId !== undefined) base.workItemId = workItemId;
  const agentId = optionalString(input.agentId, 'agentId');
  if (agentId !== undefined) base.agentId = agentId;
  const toolInvocationId = optionalString(input.toolInvocationId, 'toolInvocationId');
  if (toolInvocationId !== undefined) base.toolInvocationId = toolInvocationId;
  const operationId = optionalString(input.operationId, 'operationId');
  if (operationId !== undefined) base.operationId = operationId;
  const traceId = optionalString(input.traceId, 'traceId');
  if (traceId !== undefined) base.traceId = traceId;
  return { base };
}

function isSignedBy(seal: EvidenceSeal, keyId: string, publicKeyPem: string): boolean {
  return seal.keyId === keyId && seal.algorithm === 'ed25519' && verifyEd25519(publicKeyPem, sealMessage(seal), seal.signature);
}

function jsonParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

class SqlEvidenceLedger implements EvidenceLedger {
  readonly #deps: EvidenceLedgerDeps;

  constructor(deps: EvidenceLedgerDeps) {
    if (!deps?.db || !deps.artifacts) throw invalid('EvidenceLedger requires db and artifacts');
    this.#deps = deps;
  }

  async append(input: EvidenceInput, tx?: SqlExecutor, options: EvidenceEventOptions = {}): Promise<EvidenceRecord> {
    const { base } = normalizeInput(input);
    await this.#assertArtifactStored(base.artifact.sha256, base.artifact.size);
    const run = (ex: SqlExecutor) => this.#appendLocked(ex, base, options);
    return tx ? run(tx) : this.#deps.db.transaction(run);
  }

  async #assertArtifactStored(sha256: string, size: number): Promise<void> {
    const store = this.#deps.artifacts;
    if (store.head) {
      const head = await store.head(sha256);
      if (!head) throw new HypertestError('integrity_violation', `artifact sha256:${sha256} is not in the ${store.kind} artifact store`, { details: { sha256 } });
      if (head.size !== size) {
        throw new HypertestError('integrity_violation', `artifact sha256:${sha256} is stored with ${head.size} bytes but the ref declares ${size}`, {
          details: { sha256, size, storedSize: head.size },
        });
      }
      return;
    }
    if (!(await store.exists(sha256))) throw new HypertestError('integrity_violation', `artifact sha256:${sha256} is not in the ${store.kind} artifact store`, { details: { sha256 } });
  }

  async #appendLocked(ex: SqlExecutor, base: NormalizedInput['base'], options: EvidenceEventOptions): Promise<EvidenceRecord> {
    const { ids, clock, logger, events } = this.#deps;
    await ex.query('SELECT pg_advisory_xact_lock(hashtext($1))', [base.runId]);

    if (base.parentEvidenceIds.length > 0) {
      const found = await ex.query<{ evidence_id: string }>(
        'SELECT evidence_id FROM ht_evidence WHERE evidence_id IN (SELECT jsonb_array_elements_text($1::jsonb))',
        [JSON.stringify(base.parentEvidenceIds)],
      );
      const have = new Set(found.rows.map((r) => r.evidence_id));
      const missing = base.parentEvidenceIds.filter((p) => !have.has(p));
      if (missing.length > 0) {
        throw new HypertestError('integrity_violation', `parent evidence not found: ${missing.join(', ')}`, { details: { missing } });
      }
    }

    const last = await ex.query<{ seq: unknown; record_hash: string }>('SELECT seq, record_hash FROM ht_evidence WHERE run_id = $1 ORDER BY seq DESC LIMIT 1', [base.runId]);
    const lastRow = last.rows[0];
    const seq = lastRow ? toNumber(lastRow.seq) + 1 : 1;
    const previousRecordHash = lastRow?.record_hash;
    const evidenceId = ids.next('ev');
    // Normalized through Date so the value survives the timestamptz round trip byte-for-byte.
    const capturedAt = new Date(clock.isoNow()).toISOString();

    const record: EvidenceRecord = { ...base, evidenceId, seq, capturedAt, metadataHash: '', recordHash: '' };
    record.metadataHash = computeMetadataHash(record);
    if (previousRecordHash !== undefined) record.previousRecordHash = previousRecordHash;
    record.recordHash = computeRecordHash(record.metadataHash, record.artifact.sha256, previousRecordHash);

    const params: SqlParam[] = [
      record.evidenceId,
      record.runId,
      record.seq,
      record.evidenceType,
      record.artifact.uri,
      record.artifact.sha256,
      record.artifact.size,
      record.artifact.mimeType,
      record.summary,
      jsonParam(record.structured),
      record.workItemId ?? null,
      record.agentId ?? null,
      record.toolInvocationId ?? null,
      record.operationId ?? null,
      jsonParam(record.environment),
      JSON.stringify(record.parentEvidenceIds),
      record.classification,
      record.retentionPolicy,
      JSON.stringify(record.producer),
      JSON.stringify(record.provenance),
      record.traceId ?? null,
      record.capturedAt,
      record.metadataHash,
      record.previousRecordHash ?? null,
      record.recordHash,
    ];
    await ex.query(
      `INSERT INTO ht_evidence (evidence_id, run_id, seq, evidence_type, artifact_uri, artifact_sha256, artifact_size, artifact_mime_type,
         summary, structured, work_item_id, agent_id, tool_invocation_id, operation_id, environment, parent_evidence_ids,
         classification, retention_policy, producer, provenance, trace_id, captured_at, metadata_hash, previous_record_hash, record_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb,
         $21, $22::timestamptz, $23, $24, $25)`,
      params,
    );

    if (events) {
      const ctx = options.eventContext ?? {};
      const event: DomainEventInput<unknown> = {
        eventType: EVENT_TYPES.evidenceAttached,
        aggregateType: 'evidence',
        aggregateId: evidenceId,
        runId: record.runId,
        correlationId: ctx.correlationId ?? record.traceId ?? record.runId,
        actorId: ctx.actorId ?? record.agentId ?? record.producer.agentId ?? record.producer.workerId,
        payload: { evidenceId, evidenceType: record.evidenceType, seq, summary: record.summary },
      };
      if (ctx.causationId !== undefined) event.causationId = ctx.causationId;
      const workItemId = ctx.workItemId ?? record.workItemId;
      if (workItemId !== undefined) event.workItemId = workItemId;
      const agentId = ctx.agentId ?? record.agentId;
      if (agentId !== undefined) event.agentId = agentId;
      await events.emit([event], ex);
    }
    logger.debug('evidence appended', { runId: record.runId, evidenceId, seq, evidenceType: record.evidenceType, artifactSha256: record.artifact.sha256 });
    return record;
  }

  async get(evidenceId: string): Promise<EvidenceRecord | undefined> {
    const res = await this.#deps.db.query<EvidenceRow>(`SELECT ${SELECT_COLUMNS} FROM ht_evidence WHERE evidence_id = $1`, [requireString(evidenceId, 'evidenceId')]);
    const row = res.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async getMany(evidenceIds: readonly string[]): Promise<EvidenceRecord[]> {
    if (!Array.isArray(evidenceIds)) throw invalid('evidenceIds must be an array');
    const unique = [...new Set(evidenceIds)];
    if (unique.length === 0) return [];
    const res = await this.#deps.db.query<EvidenceRow>(
      `SELECT ${SELECT_COLUMNS} FROM ht_evidence WHERE evidence_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(unique)],
    );
    const byId = new Map(res.rows.map((r) => [r.evidence_id, rowToRecord(r)]));
    return unique.flatMap((id) => {
      const r = byId.get(id);
      return r ? [r] : [];
    });
  }

  async query(query: EvidenceQuery): Promise<EvidenceRecord[]> {
    if (!isPlainObject(query)) throw invalid('evidence query must be an object');
    const params: SqlParam[] = [assertRunId(query.runId)];
    const where = ['run_id = $1'];
    const add = (sql: (n: number) => string, value: SqlParam) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (query.evidenceType !== undefined) {
      if (Array.isArray(query.evidenceType)) {
        if (query.evidenceType.length === 0) return [];
        add((n) => `evidence_type IN (SELECT jsonb_array_elements_text($${n}::jsonb))`, JSON.stringify(query.evidenceType));
      } else {
        add((n) => `evidence_type = $${n}`, query.evidenceType);
      }
    }
    if (query.workItemId !== undefined) add((n) => `work_item_id = $${n}`, query.workItemId);
    if (query.agentId !== undefined) add((n) => `agent_id = $${n}`, query.agentId);
    if (query.operationId !== undefined) add((n) => `operation_id = $${n}`, query.operationId);
    if (query.toolInvocationId !== undefined) add((n) => `tool_invocation_id = $${n}`, query.toolInvocationId);
    if (query.afterSeq !== undefined) {
      if (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0) throw invalid('afterSeq must be a non-negative integer');
      add((n) => `seq > $${n}`, query.afterSeq);
    }
    let sql = `SELECT ${SELECT_COLUMNS} FROM ht_evidence WHERE ${where.join(' AND ')} ORDER BY seq ASC`;
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0) throw invalid('limit must be a positive integer');
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const res = await this.#deps.db.query<EvidenceRow>(sql, params);
    return res.rows.map(rowToRecord);
  }

  async count(runId: string): Promise<number> {
    const res = await this.#deps.db.query<{ n: unknown }>('SELECT count(*) AS n FROM ht_evidence WHERE run_id = $1', [assertRunId(runId)]);
    return toNumber(res.rows[0]?.n);
  }

  async rootHash(runId: string, uptoSeq?: number): Promise<{ rootHash: string; count: number; lastSeq: number }> {
    assertRunId(runId);
    const params: SqlParam[] = [runId];
    let sql = 'SELECT seq, record_hash FROM ht_evidence WHERE run_id = $1';
    if (uptoSeq !== undefined) {
      if (!Number.isSafeInteger(uptoSeq) || uptoSeq < 0) throw invalid('uptoSeq must be a non-negative integer');
      params.push(uptoSeq);
      sql += ' AND seq <= $2';
    }
    const res = await this.#deps.db.query<{ seq: unknown; record_hash: string }>(`${sql} ORDER BY seq ASC`, params);
    const hashes = res.rows.map((r) => r.record_hash);
    const lastRow = res.rows[res.rows.length - 1];
    return { rootHash: merkleRootUnchecked(hashes), count: hashes.length, lastSeq: lastRow ? toNumber(lastRow.seq) : 0 };
  }

  async verify(runId: string, options: EvidenceVerifyOptions = {}): Promise<EvidenceVerification> {
    assertRunId(runId);
    const { db, signer, artifacts, logger } = this.#deps;
    // Seals first, then records: any committed seal only covers records committed before it, which the
    // later records read is guaranteed to see (records are append-only), so no false seal_root.
    const seals = (await this.#loadSeals(db, runId)).map((s) => s.seal);
    const records = await this.#loadRecords(db, runId);
    const publicKeys = options.publicKeys ?? (signer ? { [signer.keyId]: signer.publicKeyPem() } : {});
    const verifyOptions: { artifacts?: typeof artifacts; publicKeys: Record<string, string> } = { publicKeys };
    if (options.checkArtifacts !== false) verifyOptions.artifacts = artifacts;
    const result = await verifyEvidenceRecords(runId, records, seals, verifyOptions);
    if (!result.ok) logger.warn('evidence verification failed', { runId, problems: result.problems.length, kinds: [...new Set(result.problems.map((p) => p.kind))] });
    return result;
  }

  async seal(runId: string, options: EvidenceEventOptions = {}): Promise<EvidenceSeal> {
    assertRunId(runId);
    const { db, signer, ids, clock, events, logger } = this.#deps;
    if (!signer) throw new HypertestError('precondition_failed', 'sealing evidence requires a signer');
    if (signer.algorithm !== 'ed25519') throw new HypertestError('unsupported', `unsupported signer algorithm ${String(signer.algorithm)}`);
    return db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [runId]);
      const records = await this.#loadRecords(tx, runId);
      const check = await verifyEvidenceRecords(runId, records);
      if (!check.ok) {
        throw new HypertestError('integrity_violation', `refusing to seal run ${runId}: evidence chain fails verification (${check.problems.length} problems)`, {
          details: { problems: check.problems },
        });
      }
      const count = records.length;
      const lastSeq = count > 0 ? records[count - 1]!.seq : 0;
      const rootHash = check.rootHash;
      const publicKeyPem = signer.publicKeyPem();
      const stored = await this.#loadSeals(tx, runId);
      // Seal rows can be INSERTed by anyone with table access (the triggers only forbid UPDATE/DELETE),
      // so only seals whose signature verifies under this signer's key count as ours.
      const genuine = stored.filter((s) => isSignedBy(s.seal, signer.keyId, publicKeyPem));
      // Never re-certify a chain that contradicts one of our own earlier seals (e.g. the tail was
      // deleted behind the triggers): the new seal would make the truncation look legitimate.
      const regression = await verifyEvidenceRecords(runId, records, genuine.map((s) => s.seal), { publicKeys: { [signer.keyId]: publicKeyPem } });
      if (!regression.ok) {
        throw new HypertestError('integrity_violation', `refusing to seal run ${runId}: evidence no longer matches an earlier seal (${regression.problems.length} problems)`, {
          details: { problems: regression.problems },
        });
      }
      const latest = stored[stored.length - 1];
      if (
        latest &&
        genuine[genuine.length - 1] === latest &&
        latest.seal.rootHash === rootHash &&
        latest.seal.count === count &&
        latest.seal.lastSeq === lastSeq
      ) {
        return latest.seal;
      }
      const message = sealMessage({ runId, rootHash, count, lastSeq });
      const signature = await signer.sign(message);
      if (!verifyEd25519(publicKeyPem, message, signature)) {
        throw new HypertestError('integrity_violation', `signer ${signer.keyId} produced a signature that does not verify against its own public key`);
      }
      const seal: EvidenceSeal = { runId, rootHash, count, lastSeq, keyId: signer.keyId, algorithm: 'ed25519', signature, sealedAt: new Date(clock.isoNow()).toISOString() };
      const sealId = ids.next('seal');
      await tx.query(
        `INSERT INTO ht_evidence_seals (${SEAL_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
        [sealId, runId, (latest?.sealNo ?? 0) + 1, rootHash, count, lastSeq, seal.keyId, seal.algorithm, signature, seal.sealedAt],
      );
      if (events) {
        const ctx = options.eventContext ?? {};
        const event: DomainEventInput<unknown> = {
          eventType: EVENT_TYPES.evidenceSealed,
          aggregateType: 'evidence',
          aggregateId: sealId,
          runId,
          correlationId: ctx.correlationId ?? runId,
          actorId: ctx.actorId ?? `signer:${signer.keyId}`,
          payload: { sealId, rootHash, count, lastSeq, keyId: signer.keyId },
        };
        if (ctx.causationId !== undefined) event.causationId = ctx.causationId;
        if (ctx.workItemId !== undefined) event.workItemId = ctx.workItemId;
        if (ctx.agentId !== undefined) event.agentId = ctx.agentId;
        await events.emit([event], tx);
      }
      logger.info('evidence sealed', { runId, rootHash, count, lastSeq, keyId: signer.keyId });
      return seal;
    });
  }

  async latestSeal(runId: string): Promise<EvidenceSeal | undefined> {
    assertRunId(runId);
    return (await this.#loadSeals(this.#deps.db, runId, true))[0]?.seal;
  }

  async #loadRecords(ex: SqlExecutor, runId: string): Promise<EvidenceRecord[]> {
    const res = await ex.query<EvidenceRow>(`SELECT ${SELECT_COLUMNS} FROM ht_evidence WHERE run_id = $1 ORDER BY seq ASC`, [runId]);
    return res.rows.map(rowToRecord);
  }

  async #loadSeals(ex: SqlExecutor, runId: string, latestOnly = false): Promise<Array<{ seal: EvidenceSeal; sealNo: number }>> {
    const res = await ex.query<SealRow>(
      `SELECT ${SEAL_COLUMNS} FROM ht_evidence_seals WHERE run_id = $1 ORDER BY seal_no ${latestOnly ? 'DESC LIMIT 1' : 'ASC'}`,
      [runId],
    );
    return res.rows.map((r) => ({ seal: rowToSeal(r), sealNo: toNumber(r.seal_no) }));
  }
}

/** Creates the SQL-backed, append-only, hash-chained evidence ledger (I6). */
export function createEvidenceLedger(deps: EvidenceLedgerDeps): EvidenceLedger {
  return new SqlEvidenceLedger(deps);
}
