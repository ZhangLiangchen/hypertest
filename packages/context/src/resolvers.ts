import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { HypertestError, sha256Hex } from '@hypertest/core';
import type { ResolverRegistry, ResourceVersionResolver } from './contracts.ts';
import { environmentVersion } from './snapshots.ts';
import { findingWithdrawalVersion } from './util.ts';

type MaybePromise<T> = T | Promise<T>;

/** Map-backed registry; registering a type again replaces the previous resolver. */
export function createResolverRegistry(resolvers: ResourceVersionResolver[] = []): ResolverRegistry & { types(): string[] } {
  const map = new Map<string, ResourceVersionResolver>();
  const registry = {
    register(resolver: ResourceVersionResolver): void {
      if (!resolver || typeof resolver.resourceType !== 'string' || resolver.resourceType.length === 0 || typeof resolver.currentVersion !== 'function') {
        throw new HypertestError('invalid_argument', 'a resolver needs a non-empty resourceType and currentVersion()');
      }
      map.set(resolver.resourceType, resolver);
    },
    get(resourceType: string): ResourceVersionResolver | undefined {
      return map.get(resourceType);
    },
    types(): string[] {
      return [...map.keys()].sort();
    },
  };
  for (const r of resolvers) registry.register(r);
  return registry;
}

/** Generic resolver from a function returning the current version (undefined ⇒ the resource no longer exists). */
export function functionResolver(resourceType: string, fn: (resourceId: string) => MaybePromise<string | undefined>): ResourceVersionResolver {
  return {
    resourceType,
    async currentVersion(resourceId: string) {
      return fn(resourceId);
    },
  };
}

/**
 * `environment`: version = `${generation}:${buildDigest ?? ''}` — a deploy/restart bumps the generation and
 * invalidates every snapshot that observed the old one. Structurally fits tools' EnvironmentRegistry.get.
 */
export function environmentResolver(getEnv: (environmentId: string) => MaybePromise<{ generation: number; buildDigest?: string | undefined } | undefined>): ResourceVersionResolver {
  return functionResolver('environment', async (id) => {
    const env = await getEnv(id);
    return env ? environmentVersion(env) : undefined;
  });
}

/** `oracle`: version = String(current revision). Fits SpecRepository.getOracle(oracleId) (latest revision). */
export function oracleResolver(getOracle: (oracleId: string) => MaybePromise<{ revision: number } | undefined>): ResourceVersionResolver {
  return functionResolver('oracle', async (id) => {
    const o = await getOracle(id);
    return o ? String(o.revision) : undefined;
  });
}

/** `experiment`: version = String(current revision). Fits SpecRepository.getExperiment(experimentId). */
export function experimentResolver(getExperiment: (experimentId: string) => MaybePromise<{ revision: number } | undefined>): ResourceVersionResolver {
  return functionResolver('experiment', async (id) => {
    const e = await getExperiment(id);
    return e ? String(e.revision) : undefined;
  });
}

/**
 * Blackboard records by lineage: version = recordId of the current head, so any supersede (e.g. a finding
 * being rejected) changes it. Fits Blackboard.head(lineageId). resourceType defaults to `record`; use
 * `{ resourceType: 'finding' }` to register it for findings.
 */
export function recordResolver(getHead: (lineageId: string) => MaybePromise<{ recordId: string } | undefined>, options: { resourceType?: string } = {}): ResourceVersionResolver {
  return functionResolver(options.resourceType ?? 'record', async (id) => {
    const head = await getHead(id);
    return head ? head.recordId : undefined;
  });
}

/** `lease`: version = `${owner}:${fencingToken}` of the live lease. Fits LeaseService.current(resourceKey). */
export function leaseResolver(getLease: (resourceKey: string) => MaybePromise<{ owner: string; fencingToken: number } | undefined>): ResourceVersionResolver {
  return functionResolver('lease', async (id) => {
    const lease = await getLease(id);
    return lease ? `${lease.owner}:${lease.fencingToken}` : undefined;
  });
}

/**
 * `file`: version = sha256 of the file content; resourceId is a path relative to `root`. Absolute paths, `..`
 * escapes and symlinks leading outside the root are refused (invalid_argument / permission_denied); a missing
 * file resolves to undefined.
 */
export function fileResolver(root: string, options: { resourceType?: string } = {}): ResourceVersionResolver {
  const absRoot = resolve(root);
  return functionResolver(options.resourceType ?? 'file', async (relPath) => {
    if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) throw new HypertestError('invalid_argument', `file resource ids must be relative paths inside the root: ${relPath}`);
    const abs = resolve(absRoot, relPath);
    let real: string;
    let realRoot: string;
    try {
      [real, realRoot] = await Promise.all([realpath(abs), realpath(absRoot)]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    const rel = relative(realRoot, real);
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new HypertestError('permission_denied', `file ${relPath} resolves outside the root`);
    try {
      return sha256Hex(await readFile(real));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return undefined;
      throw e;
    }
  });
}

/**
 * (additive) `file` resources of the tool workspaces: resourceId = `workspace/<workspaceId>/<relative path>` — the
 * resource keys the fs/git tools declare — and version = sha256 of the file content (fileResolver semantics inside the
 * workspace root: `..`/absolute ⇒ invalid_argument, symlink escape ⇒ permission_denied, missing file ⇒ undefined).
 * A workspace this process does not know is `not_found` (the guard reports resolver_error: fail closed); an id outside
 * the `workspace/<id>/<path>` form is invalid_argument. Fits WorkspaceManager.get(workspaceId)?.root.
 */
export function workspaceFileResolver(getRoot: (workspaceId: string) => MaybePromise<string | undefined>, options: { resourceType?: string } = {}): ResourceVersionResolver {
  return functionResolver(options.resourceType ?? 'file', async (resourceId) => {
    const m = /^workspace\/([^/]+)\/(.+)$/.exec(resourceId);
    if (!m) throw new HypertestError('invalid_argument', `file resource ids must be workspace/<workspaceId>/<path>: ${resourceId}`);
    const root = await getRoot(m[1]!);
    if (!root) throw new HypertestError('not_found', `workspace ${m[1]} is not open in this process`);
    return fileResolver(root).currentVersion(m[2]!);
  });
}

/**
 * (B[2]) `finding_withdrawal`: version = `active` while the finding lineage's head is not withdrawn, `withdrawn:<status>` once
 * it is rejected or marked duplicate (FINDING_WITHDRAWN_STATUSES); undefined when the lineage does not exist. Fits
 * Blackboard.head(lineageId).
 */
export function findingWithdrawalResolver(getHead: (lineageId: string) => MaybePromise<{ payload?: unknown } | undefined>): ResourceVersionResolver {
  return functionResolver('finding_withdrawal', async (id) => findingWithdrawalVersion(await getHead(id)));
}

/**
 * (B[1]) `plan`: resourceId `run/<runId>/plan`, version = String(revision of the latest ACCEPTED plan), '0' before any —
 * a plan revision proposed on a plan view that another proposal superseded meanwhile is stale (compare-and-set).
 * Fits Blackboard.latestAcceptedPlan(runId).
 */
export function planResolver(getLatestAccepted: (runId: string) => MaybePromise<{ revision: number } | undefined>): ResourceVersionResolver {
  return functionResolver('plan', async (id) => {
    const m = /^run\/(.+)\/plan$/.exec(id);
    if (!m) throw new HypertestError('invalid_argument', `plan resource ids must be run/<runId>/plan: ${id}`);
    const plan = await getLatestAccepted(m[1]!);
    return String(plan?.revision ?? 0);
  });
}
