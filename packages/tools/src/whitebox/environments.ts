import { HypertestError, jsonClone } from '@hypertest/core';
import type { EnvironmentDescriptor, EnvironmentRegistry } from '../contracts.ts';

/**
 * In-memory EnvironmentRegistry (ToolRuntimeDeps.environments). Descriptors are copied in and out, so a
 * caller can never mutate a registered environment behind the registry; `bumpGeneration` is the only way
 * to move a generation forward (it never goes backwards).
 */
export function createEnvironmentRegistry(initial: readonly EnvironmentDescriptor[] = []): EnvironmentRegistry {
  const envs = new Map<string, EnvironmentDescriptor>();
  const copy = (e: EnvironmentDescriptor): EnvironmentDescriptor => jsonClone(e);
  const registry: EnvironmentRegistry = {
    get(environmentId) {
      const e = envs.get(environmentId);
      return e ? copy(e) : undefined;
    },
    list() {
      return [...envs.values()].sort((a, b) => (a.environmentId < b.environmentId ? -1 : 1)).map(copy);
    },
    register(env) {
      if (!env || typeof env.environmentId !== 'string' || env.environmentId === '') throw new HypertestError('invalid_argument', 'environmentId is required');
      if (typeof env.environmentClass !== 'string' || env.environmentClass === '') throw new HypertestError('invalid_argument', `environment ${env.environmentId}: environmentClass is required`);
      if (!Number.isInteger(env.generation) || env.generation < 0) throw new HypertestError('invalid_argument', `environment ${env.environmentId}: generation must be a non-negative integer`);
      const existing = envs.get(env.environmentId);
      if (existing && env.generation < existing.generation) {
        throw new HypertestError('conflict', `environment ${env.environmentId}: generation ${env.generation} < registered ${existing.generation}`);
      }
      envs.set(env.environmentId, copy(env));
    },
    bumpGeneration(environmentId, buildDigest) {
      const e = envs.get(environmentId);
      if (!e) throw new HypertestError('not_found', `environment ${environmentId} is not registered`);
      const next: EnvironmentDescriptor = { ...copy(e), generation: e.generation + 1 };
      if (buildDigest !== undefined) next.buildDigest = buildDigest;
      envs.set(environmentId, next);
      return copy(next);
    },
  };
  for (const e of initial) registry.register(e);
  return registry;
}
