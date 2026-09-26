import { HypertestError, jsonClone, noopLogger, systemClock, toNumber, type Migration, type SqlExecutor } from '@hypertest/core';
import type { EnvironmentDescriptor, SqlEnvironmentRegistry, SqlEnvironmentRegistryDeps } from '../contracts.ts';

/**
 * Schema of @hypertest/tools (H12). Portable across PGlite and PostgreSQL 16.
 *
 * - ht_environments: the authoritative generation (+ build digest) per environment id, shared by every process.
 * - ht_environment_bumps: the bump each verified operation made (a re-verification returns it instead of bumping twice).
 * Descriptors (URLs, control targets, possibly secret tokens) are NOT stored: they come from each process's configuration.
 */
export const toolsMigrations: Migration[] = [
  {
    id: 'tools/001-environments',
    sql: `
CREATE TABLE ht_environments (
  environment_id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation >= 0),
  build_digest text,
  updated_at timestamptz NOT NULL
);
CREATE TABLE ht_environment_bumps (
  operation_id text PRIMARY KEY,
  environment_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  build_digest text,
  created_at timestamptz NOT NULL
);
CREATE INDEX ht_environment_bumps_env_idx ON ht_environment_bumps (environment_id);
`,
  },
];

interface Row {
  generation: unknown;
  build_digest: string | null;
}

function validate(env: EnvironmentDescriptor): void {
  if (!env || typeof env.environmentId !== 'string' || env.environmentId === '') throw new HypertestError('invalid_argument', 'environmentId is required');
  if (typeof env.environmentClass !== 'string' || env.environmentClass === '') throw new HypertestError('invalid_argument', `environment ${env.environmentId}: environmentClass is required`);
  if (!Number.isInteger(env.generation) || env.generation < 0) throw new HypertestError('invalid_argument', `environment ${env.environmentId}: generation must be a non-negative integer`);
}

function withState(env: EnvironmentDescriptor, generation: number, buildDigest: string | null | undefined): EnvironmentDescriptor {
  const out: EnvironmentDescriptor = { ...jsonClone(env), generation };
  if (buildDigest !== null && buildDigest !== undefined) out.buildDigest = buildDigest;
  else delete out.buildDigest;
  return out;
}

/**
 * SQL-backed EnvironmentRegistry (H12) over the core `SqlDatabase` port (run `toolsMigrations` first). Every process
 * registers the environments of its configuration; the stored generation wins when it is ahead (a restart never
 * forgets a deploy/restart, so snapshots that observed the old generation stay stale), and `bumpGenerationAsync` is
 * atomic across processes (row lock) and idempotent per operation id (a reconciliation in another process after a
 * crash between the bump and the ledger's `verified` never counts one restart twice).
 *
 * The synchronous EnvironmentRegistry members work on the local view: `get`/`list` answer from it (`load`/`refresh`
 * read the store — freshness checks across processes must use `load`); the sync `register`/`bumpGeneration` update it
 * and queue the durable write (`flush()` awaits it). Prefer the async members where the caller can await.
 */
export async function createSqlEnvironmentRegistry(deps: SqlEnvironmentRegistryDeps, initial: readonly EnvironmentDescriptor[] = []): Promise<SqlEnvironmentRegistry> {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? noopLogger;
  const envs = new Map<string, EnvironmentDescriptor>();
  /** Sync bumps of this process by operation id (bounded): a re-verification here returns its bump. */
  const localBumps = new Map<string, EnvironmentDescriptor>();
  let queue: Promise<void> = Promise.resolve();
  let queuedError: unknown;

  /** Moves the local view forward only (never backwards). */
  const advance = (id: string, generation: number, buildDigest: string | null | undefined): EnvironmentDescriptor | undefined => {
    const cur = envs.get(id);
    if (!cur) return undefined;
    if (generation > cur.generation || (generation === cur.generation && buildDigest !== undefined && (buildDigest ?? undefined) !== cur.buildDigest)) {
      envs.set(id, withState(cur, generation, buildDigest));
    }
    return jsonClone(envs.get(id)!);
  };

  const enqueue = (what: string, fn: () => Promise<unknown>): void => {
    queue = queue.then(fn).then(
      () => undefined,
      (e: unknown) => {
        logger.error('environment registry write failed', { what, error: (e as Error).message });
        queuedError ??= e;
      },
    );
  };

  /** Upsert with max semantics: a configured generation never moves the stored one backwards. */
  async function upsert(q: SqlExecutor, env: EnvironmentDescriptor): Promise<{ generation: number; buildDigest: string | null }> {
    const r = await q.query<Row>(
      `INSERT INTO ht_environments (environment_id, generation, build_digest, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (environment_id) DO UPDATE SET
         build_digest = CASE WHEN EXCLUDED.generation > ht_environments.generation THEN EXCLUDED.build_digest ELSE ht_environments.build_digest END,
         generation = GREATEST(ht_environments.generation, EXCLUDED.generation),
         updated_at = EXCLUDED.updated_at
       RETURNING generation, build_digest`,
      [env.environmentId, env.generation, env.buildDigest ?? null, clock.isoNow()],
    );
    return { generation: toNumber(r.rows[0]!.generation), buildDigest: r.rows[0]!.build_digest };
  }

  async function bumpDurably(environmentId: string, buildDigest: string | undefined, operationId: string | undefined): Promise<EnvironmentDescriptor> {
    const base = envs.get(environmentId);
    if (!base) throw new HypertestError('not_found', `environment ${environmentId} is not registered`);
    if (operationId !== undefined && (typeof operationId !== 'string' || operationId === '')) throw new HypertestError('invalid_argument', 'operationId must be a non-empty string');
    const out = await db.transaction(async (tx) => {
      // make sure the row exists (never raised from the local view here: a queued sync bump already advanced it)
      await tx.query('INSERT INTO ht_environments (environment_id, generation, build_digest, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (environment_id) DO NOTHING', [
        environmentId, base.generation, base.buildDigest ?? null, clock.isoNow(),
      ]);
      const cur = (await tx.query<Row>('SELECT generation, build_digest FROM ht_environments WHERE environment_id = $1 FOR UPDATE', [environmentId])).rows[0]!;
      if (operationId !== undefined) {
        const prior = (await tx.query<Row & { environment_id: string }>('SELECT environment_id, generation, build_digest FROM ht_environment_bumps WHERE operation_id = $1', [operationId])).rows[0];
        if (prior) {
          if (prior.environment_id !== environmentId) throw new HypertestError('conflict', `operation ${operationId} already bumped environment ${prior.environment_id}, not ${environmentId}`);
          return { generation: toNumber(prior.generation), buildDigest: prior.build_digest, recorded: true };
        }
      }
      const generation = toNumber(cur.generation) + 1;
      const digest = buildDigest ?? cur.build_digest;
      const now = clock.isoNow();
      await tx.query('UPDATE ht_environments SET generation = $2, build_digest = $3, updated_at = $4 WHERE environment_id = $1', [environmentId, generation, digest, now]);
      if (operationId !== undefined) {
        await tx.query('INSERT INTO ht_environment_bumps (operation_id, environment_id, generation, build_digest, created_at) VALUES ($1, $2, $3, $4, $5)', [operationId, environmentId, generation, digest, now]);
      }
      return { generation, buildDigest: digest, recorded: false };
    });
    if (out.recorded) {
      // the recorded bump (like the in-memory registry): the environment may have moved on since
      advance(environmentId, out.generation, out.buildDigest);
      return withState(envs.get(environmentId)!, out.generation, out.buildDigest);
    }
    logger.info('environment generation bumped', { environmentId, generation: out.generation, operationId: operationId ?? null });
    return advance(environmentId, out.generation, out.buildDigest)!;
  }

  async function registerDurably(env: EnvironmentDescriptor): Promise<EnvironmentDescriptor> {
    const stored = await upsert(db, env);
    return advance(env.environmentId, stored.generation, stored.buildDigest) ?? withState(env, stored.generation, stored.buildDigest);
  }

  const registry: SqlEnvironmentRegistry = {
    get(environmentId) {
      const e = envs.get(environmentId);
      return e ? jsonClone(e) : undefined;
    },
    list() {
      return [...envs.values()].sort((a, b) => (a.environmentId < b.environmentId ? -1 : 1)).map((e) => jsonClone(e));
    },
    register(env) {
      validate(env);
      const existing = envs.get(env.environmentId);
      if (existing && env.generation < existing.generation) {
        throw new HypertestError('conflict', `environment ${env.environmentId}: generation ${env.generation} < registered ${existing.generation}`);
      }
      envs.set(env.environmentId, jsonClone(env));
      enqueue(`register ${env.environmentId}`, () => registerDurably(env));
    },
    bumpGeneration(environmentId, buildDigest, operationId) {
      const e = envs.get(environmentId);
      if (!e) throw new HypertestError('not_found', `environment ${environmentId} is not registered`);
      if (operationId !== undefined) {
        const prior = localBumps.get(operationId);
        if (prior) {
          if (prior.environmentId !== environmentId) throw new HypertestError('conflict', `operation ${operationId} already bumped environment ${prior.environmentId}, not ${environmentId}`);
          return jsonClone(prior);
        }
      }
      // local view now; the durable bump (atomic, idempotent per operation) follows in order — prefer bumpGenerationAsync,
      // which also knows the bumps other processes made
      const next: EnvironmentDescriptor = { ...jsonClone(e), generation: e.generation + 1 };
      if (buildDigest !== undefined) next.buildDigest = buildDigest;
      envs.set(environmentId, next);
      if (operationId !== undefined) {
        localBumps.set(operationId, jsonClone(next));
        while (localBumps.size > 4096) localBumps.delete(localBumps.keys().next().value as string);
      }
      enqueue(`bump ${environmentId}`, () => bumpDurably(environmentId, buildDigest, operationId));
      return jsonClone(next);
    },
    async load(environmentId) {
      if (!envs.has(environmentId)) return undefined;
      const r = (await db.query<Row>('SELECT generation, build_digest FROM ht_environments WHERE environment_id = $1', [environmentId])).rows[0];
      if (r) advance(environmentId, toNumber(r.generation), r.build_digest);
      return registry.get(environmentId);
    },
    bumpGenerationAsync(environmentId, buildDigest, operationId) {
      return bumpDurably(environmentId, buildDigest, operationId);
    },
    async registerAsync(env) {
      validate(env);
      const existing = envs.get(env.environmentId);
      if (existing && env.generation < existing.generation) {
        throw new HypertestError('conflict', `environment ${env.environmentId}: generation ${env.generation} < registered ${existing.generation}`);
      }
      envs.set(env.environmentId, jsonClone(env));
      return registerDurably(env);
    },
    async refresh() {
      const ids = [...envs.keys()];
      if (ids.length === 0) return;
      const r = await db.query<Row & { environment_id: string }>('SELECT environment_id, generation, build_digest FROM ht_environments WHERE environment_id = ANY($1::text[])', [ids]);
      for (const row of r.rows) advance(row.environment_id, toNumber(row.generation), row.build_digest);
    },
    async flush() {
      await queue;
      if (queuedError !== undefined) {
        const e = queuedError;
        queuedError = undefined;
        throw e;
      }
    },
  };

  // configured descriptors: the stored generation wins when it is ahead (restart never forgets a bump)
  for (const env of initial) {
    validate(env);
    if (envs.has(env.environmentId)) throw new HypertestError('invalid_argument', `environment ${env.environmentId} is configured twice`);
    envs.set(env.environmentId, jsonClone(env));
    const stored = await registerDurably(env);
    if (stored.generation > env.generation) logger.info('environment generation restored from the store', { environmentId: env.environmentId, generation: stored.generation });
  }
  return registry;
}
