import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { HypertestError, type Logger } from '@hypertest/core';
import type { EnvironmentDescriptor, EnvironmentRegistry } from '@hypertest/tools';
import type { EnvironmentConfig } from './contracts.ts';

/**
 * Environments of a Hypertest instance.
 *
 * - `control.tokenEnv` (config only) names the variable holding a process supervisor's control token: it is read at
 *   composition and attached to the control target as `#token=…` (the form the env.* adapters read, never sent over
 *   the wire nor persisted), so the token never lives in the configuration.
 * - Generations are durable: `env.restart` / `env.deploy` bump an environment's generation (and build digest) in the
 *   in-memory registry of @hypertest/tools. A restart that forgot the bump would make a context snapshot taken BEFORE
 *   the deploy validate as fresh again (FreshnessGuard) and attribute new evidence to the old build. Every bump is
 *   therefore written (synchronously: the registry API is synchronous) to `<dataDir>/state/environments.json` and
 *   re-applied at the next composition (the higher generation wins over the configured one).
 * - A bump names its operation, and the file remembers it (`operations`, the most recent MAX_PERSISTED_BUMPS): the
 *   adapter bumps while verifying, BEFORE the ledger records `verified`, so a process killed in between re-verifies
 *   the operation after the restart — and gets the recorded bump back instead of counting the same restart twice.
 */

export const ENVIRONMENT_STATE_FILE = 'environments.json';

interface PersistedEnvironment {
  generation: number;
  buildDigest?: string;
}

/** The bump an operation made (environment, the generation it produced, its build digest). */
interface PersistedBump {
  environmentId: string;
  generation: number;
  buildDigest?: string;
}

interface StateFile {
  version: 1;
  environments: Record<string, PersistedEnvironment>;
  /** (additive) Bumps by operation id, oldest first; absent when no bump named its operation. */
  operations?: Record<string, PersistedBump>;
}

/** How many bumps by operation id the state file keeps (re-verification happens right after a restart). */
const MAX_PERSISTED_BUMPS = 1024;

/** Descriptors for the tools registry: `control.tokenEnv` resolved into the target fragment (a missing variable is reported, never fatal). */
export function resolveEnvironments(configured: readonly EnvironmentConfig[], env: Record<string, string | undefined>, logger: Logger): EnvironmentDescriptor[] {
  return configured.map((e) => {
    if (!e.control || e.control.tokenEnv === undefined) return e as EnvironmentDescriptor;
    const { tokenEnv, ...control } = e.control;
    const token = env[tokenEnv];
    if (token === undefined || token === '') {
      logger.warn('environment control token variable is not set; env.* operations on this environment will be refused by its supervisor (see `hypertest doctor`)', { environmentId: e.environmentId, tokenEnv });
      return { ...e, control } as EnvironmentDescriptor;
    }
    return { ...e, control: { ...control, target: `${control.target}#token=${encodeURIComponent(token)}` } } as EnvironmentDescriptor;
  });
}

function readState(file: string): StateFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, environments: {} };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const envs = (parsed as Partial<StateFile> | undefined)?.environments;
  const valid =
    envs !== null &&
    typeof envs === 'object' &&
    !Array.isArray(envs) &&
    Object.values(envs).every((v) => v !== null && typeof v === 'object' && Number.isSafeInteger((v as PersistedEnvironment).generation) && (v as PersistedEnvironment).generation >= 0);
  const ops = (parsed as Partial<StateFile> | undefined)?.operations;
  const opsValid =
    ops === undefined ||
    (ops !== null &&
      typeof ops === 'object' &&
      !Array.isArray(ops) &&
      Object.values(ops).every(
        (v) =>
          v !== null && typeof v === 'object' && typeof (v as PersistedBump).environmentId === 'string' && Number.isSafeInteger((v as PersistedBump).generation) &&
          (v as PersistedBump).generation >= 0 && ((v as PersistedBump).buildDigest === undefined || typeof (v as PersistedBump).buildDigest === 'string'),
      ));
  // fail closed: a lost generation would make stale snapshots valid again (a lost bump record would count a restart twice)
  if (!valid || !opsValid) throw new HypertestError('integrity_violation', `environment state file ${file} is corrupt; restore it or remove it after verifying every environment's generation in the configuration`);
  const out: StateFile = { version: 1, environments: envs as Record<string, PersistedEnvironment> };
  if (ops !== undefined && Object.keys(ops).length > 0) out.operations = ops;
  return out;
}

function writeState(file: string, state: StateFile): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * Wraps `inner` so that generation changes survive restarts (see the module comment). Persisted generations higher
 * than the configured ones are applied to `inner` now; the file is merged on every write (max per environment).
 */
export function persistentEnvironmentRegistry(inner: EnvironmentRegistry, file: string, logger: Logger): EnvironmentRegistry {
  const state = readState(file);
  for (const [id, p] of Object.entries(state.environments)) {
    const current = inner.get(id);
    if (!current || current.generation >= p.generation) continue;
    const next: EnvironmentDescriptor = { ...current, generation: p.generation };
    if (p.buildDigest !== undefined) next.buildDigest = p.buildDigest;
    else delete next.buildDigest;
    inner.register(next);
    logger.info('environment generation restored from the state file', { environmentId: id, generation: p.generation });
  }
  const persist = (bump?: { operationId: string; record: PersistedBump }): void => {
    const onDisk = readState(file);
    const merged: Record<string, PersistedEnvironment> = { ...onDisk.environments };
    for (const e of inner.list()) {
      const prev = onDisk.environments[e.environmentId];
      if (prev && prev.generation > e.generation) continue;
      merged[e.environmentId] = e.buildDigest !== undefined ? { generation: e.generation, buildDigest: e.buildDigest } : { generation: e.generation };
    }
    const state: StateFile = { version: 1, environments: merged };
    const operations: Record<string, PersistedBump> = { ...(onDisk.operations ?? {}) };
    if (bump) {
      delete operations[bump.operationId];
      operations[bump.operationId] = bump.record;
    }
    const ids = Object.keys(operations);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PERSISTED_BUMPS))) delete operations[id];
    if (Object.keys(operations).length > 0) state.operations = operations;
    writeState(file, state);
  };
  return {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    register(env) {
      inner.register(env);
      persist();
    },
    bumpGeneration(environmentId, buildDigest, operationId) {
      if (operationId !== undefined) {
        // re-verification of an operation whose bump an earlier process already made (and persisted)
        const prior = readState(file).operations?.[operationId];
        if (prior) {
          if (prior.environmentId !== environmentId) throw new HypertestError('conflict', `operation ${operationId} already bumped environment ${prior.environmentId}, not ${environmentId}`);
          const current = inner.get(environmentId);
          if (!current) throw new HypertestError('not_found', `environment ${environmentId} is not registered`);
          const recorded: EnvironmentDescriptor = { ...current, generation: prior.generation };
          if (prior.buildDigest !== undefined) recorded.buildDigest = prior.buildDigest;
          else delete recorded.buildDigest;
          return recorded;
        }
      }
      const next = inner.bumpGeneration(environmentId, buildDigest, operationId);
      if (operationId === undefined) persist();
      else persist({ operationId, record: { environmentId, generation: next.generation, ...(next.buildDigest !== undefined ? { buildDigest: next.buildDigest } : {}) } });
      return next;
    },
  };
}
