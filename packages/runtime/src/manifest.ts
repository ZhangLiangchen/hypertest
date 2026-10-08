import { HypertestError, canonicalJson, deepFreeze, jsonClone, sha256Hex, type JsonValue } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import type { ToolSpec } from '@hypertest/tools';

type ManifestContent = Omit<RuntimeManifest, 'manifestId' | 'createdAt'>;

/** A full git commit id (SHA-1 or SHA-256 object format). */
export const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** An OCI content digest as a registry prints it (`sha256:<64 hex>`). */
export const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function assertText(v: unknown, what: string): void {
  if (typeof v !== 'string' || v.length === 0) throw new HypertestError('invalid_argument', `runtime manifest: ${what} must be a non-empty string`);
}

function assertMatch(v: unknown, re: RegExp, what: string, expected: string): void {
  if (typeof v !== 'string' || !re.test(v)) throw new HypertestError('invalid_argument', `runtime manifest: ${what} must be ${expected} (got ${JSON.stringify(v)})`);
}

function byCanonical<T>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => {
    const ka = canonicalJson(a);
    const kb = canonicalJson(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * The canonical content of a manifest: validated, JSON-cloned, set-like arrays sorted (their order carries no meaning).
 * The runtime-BOM fields (`hypertest.imageDigest`, `agentEngines[].adapter`, `defaultEngine`, `roleCatalogRevision`)
 * are optional — manifests built before they existed keep their ids — but validated when present:
 * a malformed digest or SHA in a BOM would pin a run to an unverifiable runtime.
 */
export function manifestContent(input: ManifestContent): ManifestContent {
  if (!input || typeof input !== 'object') throw new HypertestError('invalid_argument', 'runtime manifest: input must be an object');
  assertText(input.hypertest?.version, 'hypertest.version');
  // gitSha predates the runtime BOM (any non-empty string stays valid: stored manifests keep verifying); the app pins a
  // full commit id (GIT_SHA_RE)
  if (input.hypertest.gitSha !== undefined) assertText(input.hypertest.gitSha, 'hypertest.gitSha');
  if (input.hypertest.sourceDigest !== undefined) assertText(input.hypertest.sourceDigest, 'hypertest.sourceDigest');
  if (input.hypertest.imageDigest !== undefined) assertMatch(input.hypertest.imageDigest, IMAGE_DIGEST_RE, 'hypertest.imageDigest', 'an OCI digest sha256:<64 lowercase hex>');
  if (!Array.isArray(input.agentEngines) || input.agentEngines.length === 0) throw new HypertestError('invalid_argument', 'runtime manifest: agentEngines must list at least one engine');
  input.agentEngines.forEach((e, i) => {
    assertText(e?.kind, `agentEngines[${i}].kind`);
    // predates the runtime BOM: any non-empty string stays valid (stored manifests keep verifying)
    if (e.imageDigest !== undefined) assertText(e.imageDigest, `agentEngines[${i}].imageDigest`);
    if (e.adapter !== undefined) {
      assertText(e.adapter?.package, `agentEngines[${i}].adapter.package`);
      assertText(e.adapter.version, `agentEngines[${i}].adapter.version`);
    }
  });
  if (input.defaultEngine !== undefined) {
    assertText(input.defaultEngine, 'defaultEngine');
    if (!input.agentEngines.some((e) => e.kind === input.defaultEngine)) {
      throw new HypertestError('invalid_argument', `runtime manifest: defaultEngine ${JSON.stringify(input.defaultEngine)} is not one of the pinned agentEngines`);
    }
  }
  if (!Array.isArray(input.providerAdapters)) throw new HypertestError('invalid_argument', 'runtime manifest: providerAdapters must be an array');
  input.providerAdapters.forEach((p, i) => {
    assertText(p?.provider, `providerAdapters[${i}].provider`);
    assertText(p.package, `providerAdapters[${i}].package`);
    assertText(p.version, `providerAdapters[${i}].version`);
  });
  assertText(input.modelCatalogRevision, 'modelCatalogRevision');
  for (const k of ['event', 'contextSnapshot', 'tool', 'operation', 'evidence'] as const) assertText(input.schemas?.[k], `schemas.${k}`);
  assertText(input.policyBundleRevision, 'policyBundleRevision');
  if (input.roleCatalogRevision !== undefined) assertText(input.roleCatalogRevision, 'roleCatalogRevision');
  assertText(input.toolCatalogRevision, 'toolCatalogRevision');
  if (input.protocol !== undefined) {
    assertText(input.protocol.id, 'protocol.id');
    assertText(input.protocol.version, 'protocol.version');
    assertText(input.protocol.digest, 'protocol.digest');
  }
  if (input.modelScores !== undefined) {
    // coverage[7]: the eval-derived scores a run is routed with are pinned with it (I11)
    assertMatch(input.modelScores?.digest, /^[0-9a-f]{64}$/, 'modelScores.digest', 'a sha256 (64 lowercase hex)');
    if (!Array.isArray(input.modelScores.routes)) throw new HypertestError('invalid_argument', 'runtime manifest: modelScores.routes must be an array');
    input.modelScores.routes.forEach((r, i) => assertText(r, `modelScores.routes[${i}]`));
  }
  if (input.plugins !== undefined) {
    // A[6]: every kernel plugin is pinned by its digest
    if (!Array.isArray(input.plugins)) throw new HypertestError('invalid_argument', 'runtime manifest: plugins must be an array');
    input.plugins.forEach((p, i) => {
      assertText(p?.id, `plugins[${i}].id`);
      assertText(p.version, `plugins[${i}].version`);
      assertText(p.kind, `plugins[${i}].kind`);
      assertMatch(p.digest, /^sha256:[0-9a-f]{64}$/, `plugins[${i}].digest`, 'sha256:<64 lowercase hex>');
      if (!Array.isArray(p.capabilities)) throw new HypertestError('invalid_argument', `runtime manifest: plugins[${i}].capabilities must be an array`);
    });
  }
  const { manifestId: _id, createdAt: _at, ...rest } = input as ManifestContent & { manifestId?: unknown; createdAt?: unknown };
  const copy = jsonClone(rest) as ManifestContent;
  copy.agentEngines = byCanonical(copy.agentEngines);
  copy.providerAdapters = byCanonical(copy.providerAdapters);
  if (copy.modelScores) copy.modelScores.routes = [...copy.modelScores.routes].sort();
  if (copy.plugins) copy.plugins = byCanonical(copy.plugins.map((p) => ({ ...p, capabilities: [...p.capabilities].sort() })));
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

/** Version of the entry format of toolCatalogRevision (a change of what is hashed is a new revision space). */
export const TOOL_CATALOG_REVISION_FORMAT = 2;

/** What toolCatalogRevision reads of a side-effect adapter (structural: the runtime does not depend on @hypertest/operation). */
export interface ManifestSideEffectAdapter {
  adapterId: string;
  capabilities: object;
}

/**
 * The tool catalog revision pinned by a RuntimeManifest (runtime BOM): `tc_<sha256>` over, per tool (sorted by id), its
 * schemas, effect and risk class (`dynamic` when computed per input), `timeoutMs`, `maxInlineBytes`, whether it computes
 * an environment class or resends, and its **side-effect binding** (adapter id, operation type, lease TTL) — plus the
 * capabilities of every side-effect adapter (idempotency, lookup, fencing, compensation, reconciliation class, risk).
 * A changed timeout, binding or adapter is a different runtime: runs pinned to the old catalog are never driven by it (I11).
 */
export function toolCatalogRevision(tools: readonly Pick<ToolSpec, 'id'>[] | readonly ToolSpec[], adapters: readonly ManifestSideEffectAdapter[] = []): string {
  if (!Array.isArray(tools)) throw new HypertestError('invalid_argument', 'toolCatalogRevision: tools must be an array');
  const seen = new Set<string>();
  const entries = (tools as readonly ToolSpec[]).map((t) => {
    assertText(t?.id, 'tool id');
    if (seen.has(t.id)) throw new HypertestError('invalid_argument', `toolCatalogRevision: duplicate tool id ${t.id}`);
    seen.add(t.id);
    if (!Number.isFinite(t.timeoutMs) || t.timeoutMs <= 0) throw new HypertestError('invalid_argument', `toolCatalogRevision: tool ${t.id} has no positive timeoutMs`);
    const binding = t.sideEffect;
    return {
      id: t.id,
      inputSchema: (t.inputSchema ?? null) as JsonValue,
      outputSchema: (t.outputSchema ?? null) as JsonValue,
      effect: typeof t.effect === 'function' ? 'dynamic' : (t.effect ?? null),
      riskClass: typeof t.riskClass === 'function' ? 'dynamic' : (t.riskClass ?? null),
      timeoutMs: t.timeoutMs,
      maxInlineBytes: t.maxInlineBytes ?? null,
      environmentClass: typeof t.environmentClass === 'function',
      resendable: typeof t.resendable === 'function',
      sideEffect: binding ? { adapterId: binding.adapterId, operationType: binding.operationType, leaseTtlMs: binding.leaseTtlMs ?? null } : null,
      // (additive, wave 3) what the tool may record and the scopes the operator grants with it are part of the runtime: hashed
      // only when present, so the revision of a catalog without them is unchanged
      ...(Array.isArray(t.evidenceTypes) ? { evidenceTypes: [...t.evidenceTypes].sort() } : {}),
      ...(t.grant ? { grant: { scopes: [...t.grant.scopes].sort(), profiles: [...t.grant.profiles].sort() } } : {}),
    };
  });
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const adapterEntries = adapters
    .map((a) => {
      assertText(a?.adapterId, 'side-effect adapter id');
      return { adapterId: a.adapterId, capabilities: jsonClone((a.capabilities ?? null) as JsonValue) };
    })
    .sort((a, b) => (a.adapterId < b.adapterId ? -1 : a.adapterId > b.adapterId ? 1 : 0));
  for (let i = 1; i < adapterEntries.length; i++) {
    if (adapterEntries[i]!.adapterId === adapterEntries[i - 1]!.adapterId) throw new HypertestError('invalid_argument', `toolCatalogRevision: duplicate adapter id ${adapterEntries[i]!.adapterId}`);
  }
  return `tc_${sha256Hex(canonicalJson({ format: TOOL_CATALOG_REVISION_FORMAT, tools: entries, adapters: adapterEntries }))}`;
}
