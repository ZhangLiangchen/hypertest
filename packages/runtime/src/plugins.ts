import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HypertestError, sha256Hex, type Clock, type JsonValue, type Logger } from '@hypertest/core';
import type { ModelProvider } from '@hypertest/model';
import type { ToolSpec } from '@hypertest/tools';
import type { AgentEngine, NativeEngineDeps } from './contracts.ts';

/**
 * (A[6], coverage[2]) The Agent Runtime Kernel's extension mechanism (technology-selection §Agent Runtime Kernel: Capability
 * Registry, Plugin Lifecycle, Context assembly hooks; §Runtime ownership: Plugin ABI; §最终总体架构 KERNEL: Plugin Runtime /
 * Service Registry).
 *
 * Plugin ABI. A plugin is a LOCAL ES module named by the configuration (`plugins:`) with a manifest:
 *   { id, version, kind: tool | engine | provider | context-hook, entry, capabilities, digest: 'sha256:<hex of entry bytes>' }
 * exporting `createPlugin(): HypertestPlugin` (or a default export of that function). The kernel:
 *   1. verifies the entry's bytes against `digest` BEFORE importing it (a mismatch is refused: nothing of it runs), and
 *      again after the import (the file may not change between check and load);
 *   2. runs the lifecycle in configuration order: init(ctx) → contributions → start() → health(); any failure stops the
 *      plugins already started (reverse order) and fails the composition (fail closed);
 *   3. registers every contribution in the Capability Registry — a contribution its manifest does not declare
 *      (`tool:<id>`, `engine:<kind>`, `provider:<id>`, `context-hook:<name>`, `service:<name>`) is refused, as is one of a
 *      kind the plugin's `kind` may not contribute (services are allowed to every kind);
 *   4. provides services through the Service Registry (name → implementation; plugins consume each other's services);
 *   5. stops the plugins in reverse order on shutdown.
 * Contributions join the ordinary registries (tools → ToolRegistry, engines → EngineRegistry, providers →
 * ProviderRegistry, context hooks → the turn's context assembly), so a plugin tool goes through the same capability check,
 * policy permit, freshness validation, operation ledger and evidence as a built-in tool; the RuntimeManifest pins every
 * plugin by id, version, kind, digest and capabilities (I11).
 */
export const PLUGIN_KINDS = ['tool', 'engine', 'provider', 'context-hook'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

const CAPABILITY_PREFIXES = ['tool', 'engine', 'provider', 'context-hook', 'service'] as const;
type CapabilityPrefix = (typeof CAPABILITY_PREFIXES)[number];
/** Which contributions a plugin kind may make (services: every kind). */
const KIND_CONTRIBUTES: Record<PluginKind, readonly CapabilityPrefix[]> = {
  tool: ['tool', 'service'],
  engine: ['engine', 'service'],
  provider: ['provider', 'service'],
  'context-hook': ['context-hook', 'service'],
};
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface PluginManifest {
  id: string;
  version: string;
  kind: PluginKind;
  /** Absolute path of the ES module (the configuration resolves a relative entry against the configuration file). */
  entry: string;
  /** What the plugin may contribute: `tool:<toolId>`, `engine:<kind>`, `provider:<providerId>`, `context-hook:<name>`, `service:<name>`. */
  capabilities: string[];
  /** `sha256:<64 hex>` of the entry module's bytes. */
  digest: string;
}

export interface PluginHealth {
  ok: boolean;
  detail?: string;
}

/** A context-assembly hook: bounded reference sections added to a turn's context (data, never instructions). */
export interface ContextHook {
  sections(input: { runId: string; workItemId: string; agentId: string; role: string; turn: number }): Promise<Array<{ title: string; text: string }>> | Array<{ title: string; text: string }>;
}

export interface ServiceRegistry {
  provide(name: string, implementation: unknown, owner: string): void;
  get<T = unknown>(name: string): T;
  has(name: string): boolean;
  list(): Array<{ name: string; owner: string }>;
}

export interface CapabilityRegistry {
  register(capability: string, pluginId: string): void;
  owner(capability: string): string | undefined;
  list(): Array<{ capability: string; pluginId: string }>;
}

export interface PluginContext {
  readonly manifest: Readonly<PluginManifest>;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly services: ServiceRegistry;
}

/** What a plugin module's createPlugin() returns. Every member is optional. */
export interface HypertestPlugin {
  init?(ctx: PluginContext): void | Promise<void>;
  start?(): void | Promise<void>;
  health?(): PluginHealth | Promise<PluginHealth>;
  stop?(): void | Promise<void>;
  /** Contributions (read once, after init). */
  tools?(): ToolSpec[];
  engine?(deps: NativeEngineDeps): AgentEngine;
  provider?(): ModelProvider;
  contextHooks?(): Record<string, ContextHook>;
  services?(): Record<string, unknown>;
}

export type PluginState = 'loaded' | 'initialized' | 'started' | 'stopped' | 'failed';

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly plugin: HypertestPlugin;
  state: PluginState;
}

export interface PluginKernel {
  readonly plugins: readonly LoadedPlugin[];
  readonly services: ServiceRegistry;
  readonly capabilities: CapabilityRegistry;
  tools(): ToolSpec[];
  providers(): ModelProvider[];
  /** Engines of engine plugins (constructed once per call with the runtime's engine deps). */
  engines(deps: NativeEngineDeps): AgentEngine[];
  contextHooks(): Array<{ pluginId: string; name: string; hook: ContextHook }>;
  health(): Promise<Array<{ pluginId: string } & PluginHealth>>;
  stop(): Promise<void>;
  /** RuntimeManifest.plugins. */
  manifestEntries(): Array<{ id: string; version: string; kind: string; digest: string; capabilities: string[] }>;
}

/** `sha256:<hex>` of a plugin entry's bytes. */
export function pluginDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(Buffer.from(bytes))}`;
}

function refused(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('precondition_failed', message, { details });
}

function invalid(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('invalid_argument', message, { details });
}

/** Validates a manifest (invalid_argument naming the first problem). */
export function validatePluginManifest(m: unknown, at = 'plugin'): PluginManifest {
  if (!m || typeof m !== 'object') throw invalid(`${at}: must be an object`);
  const p = m as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !ID_RE.test(p['id'])) throw invalid(`${at}.id must match ${ID_RE.source}`);
  if (typeof p['version'] !== 'string' || p['version'].trim() === '') throw invalid(`${at} (${p['id']}).version must be a non-empty string`);
  if (typeof p['kind'] !== 'string' || !(PLUGIN_KINDS as readonly string[]).includes(p['kind'])) throw invalid(`${at} (${p['id']}).kind must be one of ${PLUGIN_KINDS.join(', ')}`);
  if (typeof p['entry'] !== 'string' || !isAbsolute(p['entry'])) throw invalid(`${at} (${p['id']}).entry must be an absolute path (relative entries are resolved against the configuration file)`);
  if (typeof p['digest'] !== 'string' || !DIGEST_RE.test(p['digest'])) throw invalid(`${at} (${p['id']}).digest must be sha256:<64 lowercase hex> of the entry file`);
  const caps = p['capabilities'];
  if (!Array.isArray(caps) || caps.length === 0) throw invalid(`${at} (${p['id']}).capabilities must list what the plugin may contribute`);
  for (const c of caps) {
    const [prefix, name] = typeof c === 'string' ? [c.slice(0, c.indexOf(':')), c.slice(c.indexOf(':') + 1)] : ['', ''];
    if (typeof c !== 'string' || c.indexOf(':') < 1 || !(CAPABILITY_PREFIXES as readonly string[]).includes(prefix) || name === '') {
      throw invalid(`${at} (${p['id']}).capabilities: ${JSON.stringify(c)} must be <${CAPABILITY_PREFIXES.join('|')}>:<name>`);
    }
    if (!KIND_CONTRIBUTES[p['kind'] as PluginKind].includes(prefix as CapabilityPrefix)) throw invalid(`${at} (${p['id']}).capabilities: a ${p['kind']} plugin may not contribute ${prefix}s (${c})`);
  }
  return { id: p['id'], version: p['version'], kind: p['kind'] as PluginKind, entry: p['entry'], capabilities: [...(caps as string[])], digest: p['digest'] };
}

function createServiceRegistry(): ServiceRegistry {
  const services = new Map<string, { implementation: unknown; owner: string }>();
  return {
    provide(name, implementation, owner) {
      if (typeof name !== 'string' || name === '') throw invalid('service name must be a non-empty string');
      if (services.has(name)) throw new HypertestError('conflict', `service ${name} is already provided by ${services.get(name)!.owner}`);
      services.set(name, { implementation, owner });
    },
    get<T>(name: string): T {
      const s = services.get(name);
      if (!s) throw new HypertestError('not_found', `service ${name} is not provided (provided: ${[...services.keys()].sort().join(', ') || 'none'})`);
      return s.implementation as T;
    },
    has: (name) => services.has(name),
    list: () => [...services.entries()].map(([name, s]) => ({ name, owner: s.owner })).sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

function createCapabilityRegistry(): CapabilityRegistry {
  const owners = new Map<string, string>();
  return {
    register(capability, pluginId) {
      const existing = owners.get(capability);
      if (existing !== undefined && existing !== pluginId) throw new HypertestError('conflict', `capability ${capability} is already provided by plugin ${existing}`);
      owners.set(capability, pluginId);
    },
    owner: (capability) => owners.get(capability),
    list: () => [...owners.entries()].map(([capability, pluginId]) => ({ capability, pluginId })).sort((a, b) => (a.capability < b.capability ? -1 : 1)),
  };
}

async function verifiedBytes(m: PluginManifest): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(m.entry);
  } catch (e) {
    throw refused(`plugin ${m.id}: entry ${m.entry} cannot be read: ${(e as Error).message}`, { pluginId: m.id, entry: m.entry });
  }
  const actual = pluginDigest(bytes);
  if (actual !== m.digest) {
    throw refused(`plugin ${m.id}: digest mismatch — the configuration pins ${m.digest}, the entry ${m.entry} is ${actual}: refused (nothing of it was loaded)`, {
      pluginId: m.id, expected: m.digest, actual,
    });
  }
  return bytes;
}

/**
 * Loads, verifies and starts the configured plugins (see the module comment). Throws (stopping what started) on a digest
 * mismatch, an import or lifecycle failure, an undeclared or conflicting contribution, or an unhealthy plugin.
 */
export async function createPluginKernel(
  configs: ReadonlyArray<PluginManifest & { config?: Record<string, JsonValue> }>,
  deps: { logger: Logger; clock: Clock },
): Promise<PluginKernel> {
  const services = createServiceRegistry();
  const capabilities = createCapabilityRegistry();
  const loaded: LoadedPlugin[] = [];
  const contributions = new Map<string, { tools: ToolSpec[]; provider?: ModelProvider; hooks: Record<string, ContextHook> }>();
  const seen = new Set<string>();
  const log = deps.logger.child({ component: 'plugins' });

  async function stopAll(): Promise<void> {
    for (const p of [...loaded].reverse()) {
      if (p.state !== 'started' && p.state !== 'initialized') continue;
      try {
        await p.plugin.stop?.();
        p.state = 'stopped';
        log.info('plugin stopped', { pluginId: p.manifest.id });
      } catch (e) {
        p.state = 'failed';
        log.error('plugin stop failed', { pluginId: p.manifest.id, error: (e as Error).message });
      }
    }
  }

  const declared = (m: PluginManifest, capability: string) => {
    if (!m.capabilities.includes(capability)) {
      throw refused(`plugin ${m.id} contributes ${capability}, which its manifest does not declare (capabilities: ${m.capabilities.join(', ')}): refused`, { pluginId: m.id, capability });
    }
    capabilities.register(capability, m.id);
  };

  try {
    for (const [i, raw] of configs.entries()) {
      const m = validatePluginManifest(raw, `plugins[${i}]`);
      if (seen.has(m.id)) throw invalid(`plugins[${i}]: duplicate plugin id ${m.id}`);
      seen.add(m.id);
      const bytes = await verifiedBytes(m);
      let mod: Record<string, unknown>;
      try {
        mod = (await import(`${pathToFileURL(m.entry).href}?sha256=${m.digest.slice('sha256:'.length)}`)) as Record<string, unknown>;
      } catch (e) {
        throw refused(`plugin ${m.id}: the entry module could not be imported: ${(e as Error).message}`, { pluginId: m.id });
      }
      // the bytes loaded are the bytes verified (no change between the check and the import)
      if (pluginDigest(await readFile(m.entry)) !== pluginDigest(bytes)) throw refused(`plugin ${m.id}: the entry changed while it was loaded: refused`, { pluginId: m.id });
      const factory = (typeof mod['createPlugin'] === 'function' ? mod['createPlugin'] : mod['default']) as unknown;
      if (typeof factory !== 'function') throw refused(`plugin ${m.id}: the entry exports neither createPlugin() nor a default function`, { pluginId: m.id });
      const plugin = (await (factory as () => HypertestPlugin | Promise<HypertestPlugin>)()) ?? {};
      if (typeof plugin !== 'object') throw refused(`plugin ${m.id}: createPlugin() did not return a plugin object`, { pluginId: m.id });
      const lp: LoadedPlugin = { manifest: m, plugin, state: 'loaded' };
      loaded.push(lp);
      const ctx: PluginContext = { manifest: Object.freeze({ ...m, capabilities: [...m.capabilities] }), config: Object.freeze({ ...(raw.config ?? {}) }), logger: log.child({ pluginId: m.id }), clock: deps.clock, services };
      try {
        await plugin.init?.(ctx);
      } catch (e) {
        lp.state = 'failed';
        throw refused(`plugin ${m.id}: init failed: ${(e as Error).message}`, { pluginId: m.id });
      }
      lp.state = 'initialized';
      // contributions, each checked against the manifest's declared capabilities
      const tools = plugin.tools?.() ?? [];
      for (const t of tools) declared(m, `tool:${t.id}`);
      let provider: ModelProvider | undefined;
      if (plugin.provider) {
        provider = plugin.provider();
        declared(m, `provider:${provider.providerId}`);
      }
      const hooks = plugin.contextHooks?.() ?? {};
      for (const name of Object.keys(hooks)) declared(m, `context-hook:${name}`);
      for (const [name, impl] of Object.entries(plugin.services?.() ?? {})) {
        declared(m, `service:${name}`);
        services.provide(name, impl, m.id);
      }
      if (plugin.engine && !m.capabilities.some((c) => c.startsWith('engine:'))) throw refused(`plugin ${m.id} contributes an engine but declares no engine:<kind> capability`, { pluginId: m.id });
      const contribution: { tools: ToolSpec[]; provider?: ModelProvider; hooks: Record<string, ContextHook> } = { tools, hooks };
      if (provider) contribution.provider = provider;
      contributions.set(m.id, contribution);
      log.info('plugin initialized', { pluginId: m.id, version: m.version, kind: m.kind, digest: m.digest });
    }
    for (const p of loaded) {
      try {
        await p.plugin.start?.();
      } catch (e) {
        p.state = 'failed';
        throw refused(`plugin ${p.manifest.id}: start failed: ${(e as Error).message}`, { pluginId: p.manifest.id });
      }
      p.state = 'started';
      log.info('plugin started', { pluginId: p.manifest.id });
    }
    for (const p of loaded) {
      const h = await health(p);
      if (!h.ok) throw refused(`plugin ${p.manifest.id} is unhealthy after start: ${h.detail ?? 'no detail'}`, { pluginId: p.manifest.id });
    }
  } catch (e) {
    await stopAll();
    throw e;
  }

  async function health(p: LoadedPlugin): Promise<PluginHealth> {
    if (p.state !== 'started') return { ok: false, detail: `plugin is ${p.state}` };
    try {
      const h = (await p.plugin.health?.()) ?? { ok: true };
      return h.ok === true ? h : { ok: false, ...(h.detail !== undefined ? { detail: String(h.detail) } : {}) };
    } catch (e) {
      return { ok: false, detail: `health check threw: ${(e as Error).message}` };
    }
  }

  let stopping: Promise<void> | undefined;
  return {
    plugins: loaded,
    services,
    capabilities,
    tools: () => [...contributions.values()].flatMap((c) => c.tools),
    providers: () => [...contributions.values()].flatMap((c) => (c.provider ? [c.provider] : [])),
    engines(engineDeps) {
      const out: AgentEngine[] = [];
      for (const p of loaded) {
        if (!p.plugin.engine) continue;
        const engine = p.plugin.engine(engineDeps);
        declared(p.manifest, `engine:${engine.kind}`);
        out.push(engine);
      }
      return out;
    },
    contextHooks: () => loaded.flatMap((p) => Object.entries(contributions.get(p.manifest.id)?.hooks ?? {}).map(([name, hook]) => ({ pluginId: p.manifest.id, name, hook }))),
    async health() {
      const out: Array<{ pluginId: string } & PluginHealth> = [];
      for (const p of loaded) out.push({ pluginId: p.manifest.id, ...(await health(p)) });
      return out;
    },
    stop() {
      stopping ??= stopAll();
      return stopping;
    },
    manifestEntries: () => loaded.map((p) => ({ id: p.manifest.id, version: p.manifest.version, kind: p.manifest.kind, digest: p.manifest.digest, capabilities: [...p.manifest.capabilities].sort() })),
  };
}
