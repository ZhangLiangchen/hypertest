import { HypertestError, canonicalJson, deepFreeze, jsonClone, sha256Hex } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';

type ManifestContent = Omit<RuntimeManifest, 'manifestId' | 'createdAt'>;

function assertText(v: unknown, what: string): void {
  if (typeof v !== 'string' || v.length === 0) throw new HypertestError('invalid_argument', `runtime manifest: ${what} must be a non-empty string`);
}

function byCanonical<T>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => {
    const ka = canonicalJson(a);
    const kb = canonicalJson(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** The canonical content of a manifest: validated, JSON-cloned, set-like arrays sorted (their order carries no meaning). */
export function manifestContent(input: ManifestContent): ManifestContent {
  if (!input || typeof input !== 'object') throw new HypertestError('invalid_argument', 'runtime manifest: input must be an object');
  assertText(input.hypertest?.version, 'hypertest.version');
  if (!Array.isArray(input.agentEngines) || input.agentEngines.length === 0) throw new HypertestError('invalid_argument', 'runtime manifest: agentEngines must list at least one engine');
  input.agentEngines.forEach((e, i) => assertText(e?.kind, `agentEngines[${i}].kind`));
  if (!Array.isArray(input.providerAdapters)) throw new HypertestError('invalid_argument', 'runtime manifest: providerAdapters must be an array');
  input.providerAdapters.forEach((p, i) => {
    assertText(p?.provider, `providerAdapters[${i}].provider`);
    assertText(p.package, `providerAdapters[${i}].package`);
    assertText(p.version, `providerAdapters[${i}].version`);
  });
  assertText(input.modelCatalogRevision, 'modelCatalogRevision');
  for (const k of ['event', 'contextSnapshot', 'tool', 'operation', 'evidence'] as const) assertText(input.schemas?.[k], `schemas.${k}`);
  assertText(input.policyBundleRevision, 'policyBundleRevision');
  assertText(input.toolCatalogRevision, 'toolCatalogRevision');
  if (input.protocol !== undefined) {
    assertText(input.protocol.id, 'protocol.id');
    assertText(input.protocol.version, 'protocol.version');
    assertText(input.protocol.digest, 'protocol.digest');
  }
  const { manifestId: _id, createdAt: _at, ...rest } = input as ManifestContent & { manifestId?: unknown; createdAt?: unknown };
  const copy = jsonClone(rest) as ManifestContent;
  copy.agentEngines = byCanonical(copy.agentEngines);
  copy.providerAdapters = byCanonical(copy.providerAdapters);
  return copy;
}

/**
 * Builds the runtime bill of materials pinned to a TestRun (I11). `manifestId = 'rm_' + sha256(canonicalJson(content))`
 * where content excludes `createdAt`: the same runtime yields the same id whenever it is built. Frozen.
 */
export function buildRuntimeManifest(input: ManifestContent, createdAt: string): RuntimeManifest {
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new HypertestError('invalid_argument', `runtime manifest: createdAt must be an ISO timestamp`);
  const content = manifestContent(input);
  const manifestId = `rm_${sha256Hex(canonicalJson(content))}`;
  return deepFreeze({ manifestId, ...content, createdAt: new Date(Date.parse(createdAt)).toISOString() });
}

/** True when the manifest's id matches its content (tamper check for pinned manifests). */
export function verifyRuntimeManifest(manifest: RuntimeManifest): boolean {
  try {
    return manifest.manifestId === `rm_${sha256Hex(canonicalJson(manifestContent(manifest)))}`;
  } catch {
    return false;
  }
}
