import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HypertestError, jsonClone, validateJson } from '@hypertest/core';
import { MODEL_CAPABILITY_PROFILE_SCHEMA, anthropicCompatibilityClass, type ModelCapabilityProfile } from '@hypertest/model';
import { DEFAULT_POLICY_RULES, POLICY_RULE_SCHEMA, type OracleGovernance } from '@hypertest/policy';
import { DEFAULT_SHELL_ALLOWLIST } from '@hypertest/tools';
import { BUILTIN_ROLES, RoleCatalog, type RoleOverrides } from '@hypertest/agents';
import type { HypertestConfig, HypertestConfigInput, LoadConfigOptions, OracleConfig, ProviderConfig, RouteConfig } from './contracts.ts';

/**
 * Configuration: defaults, deep merge, `${VAR}` interpolation, relative path resolution and human-readable
 * validation. Secrets never live in the configuration: `*Env` fields NAME environment variables (read at runtime).
 */

export const PROVIDER_KINDS = ['openai-compatible', 'anthropic', 'pi-ai', 'scripted'] as const;
export const ENGINE_KINDS = ['native', 'pi'] as const;
/** Variables passed through to sandboxed processes by default (the sandbox sets PATH/HOME/LANG/TMPDIR itself). */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']);

/** Defaults applied to every `models.routes` entry (a route names at least routeId, provider and model). */
export const ROUTE_DEFAULTS = Object.freeze({
  capabilities: ['tool_use', 'structured_output'],
  structuredOutput: 'native',
  reasoning: 'none',
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  maxDataClassification: 'confidential',
  quality: { default: 0.7 },
  toolReliability: 0.8,
  costPerMillionInputUsd: 0,
  costPerMillionOutputUsd: 0,
  typicalLatencyMs: 2000,
  maxActionRisk: 'high',
  enabled: true,
}) as Readonly<Omit<ModelCapabilityProfile, 'routeId' | 'provider' | 'model' | 'continuationCompatibilityClass'>>;

const TOP_LEVEL_KEYS = new Set([
  'version', 'project', 'store', 'bus', 'durable', 'artifacts', 'models', 'roles', 'budget', 'gate', 'policy', 'bugate', 'engines', 'sandbox',
  'environments', 'tools', 'signing', 'memory', 'observability', 'oracles',
]);
/** Discriminated sections: a patch with another `kind` replaces the section instead of merging into it. */
const KIND_SECTIONS = new Set(['store', 'bus', 'durable', 'artifacts', 'memory']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Variable names that look like credentials are never interpolated (defense in depth). */
const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
/** Inline credential fields that must be expressed through `*Env` indirection instead. */
const INLINE_SECRET_KEYS = new Set(['apiKey', 'api_key', 'key', 'token', 'secret', 'password', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'privateKey', 'capabilitySecret']);
/** Header names that carry credentials: configure apiKeyEnv instead of inlining them. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'x-goog-api-key']);
/** Any other header whose name says it carries a credential (x-auth-token, x-access-token, x-secret, x-api_key, …). */
const CREDENTIAL_HEADER_RE = /(auth|token|secret|passw|api[-_]?key|cookie|session)/i;
/** Query parameters that carry credentials (e.g. `?password=` in a postgres URL). */
const CREDENTIAL_PARAM_RE = /(pass|secret|token)/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function invalid(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('invalid_argument', message, { details });
}

/**
 * Deep merge for configuration: plain objects merge recursively, arrays and scalars replace, `undefined` is ignored.
 * A discriminated section (store, bus, durable, artifacts, memory) whose `kind` changes is replaced as a whole, so
 * no field of the previous kind survives (e.g. a pglite `dataDir` under a postgres store).
 */
export function mergeConfig<T>(base: T, patch: unknown, path = '$'): T {
  if (patch === undefined) return jsonClone(base as never) as T;
  if (!isPlainObject(patch) || !isPlainObject(base)) return jsonClone(patch as never) as T;
  const out: Record<string, unknown> = jsonClone(base as never) as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw invalid(`configuration: forbidden key '${key}' at ${path}`, { path, key });
    const value = patch[key];
    if (value === undefined) continue;
    const current = out[key];
    if (path === '$' && KIND_SECTIONS.has(key) && isPlainObject(value) && isPlainObject(current) && value['kind'] !== undefined && value['kind'] !== current['kind']) {
      out[key] = mergeConfig({}, value, `${path}.${key}`);
      continue;
    }
    out[key] = isPlainObject(value) && isPlainObject(current) ? mergeConfig(current, value, `${path}.${key}`) : mergeConfig(undefined, value, `${path}.${key}`);
  }
  return out as T;
}

function baseConfig(): HypertestConfig {
  return {
    version: 1,
    project: { name: 'hypertest', dataDir: '.hypertest' },
    store: { kind: 'pglite' },
    bus: { kind: 'inprocess' },
    durable: { kind: 'local', maxConcurrentTurns: 4 },
    artifacts: { kind: 'fs' },
    models: { providers: [], routes: [] },
    engines: { default: 'native' },
    sandbox: { kind: 'local', network: 'loopback', envAllowlist: [...DEFAULT_ENV_ALLOWLIST] },
    environments: [],
    tools: { shellAllowlist: [...DEFAULT_SHELL_ALLOWLIST], httpAllowlist: [], enableBrowser: false },
    memory: { kind: 'sql' },
    observability: { logLevel: 'info' },
  };
}

/** Fills paths derived from `project.dataDir` (pglite store `<dataDir>/db`, fs artifacts `<dataDir>/artifacts`) when absent. */
export function withDerivedPaths(config: HypertestConfig): HypertestConfig {
  const out = jsonClone(config as never) as HypertestConfig;
  const dataDir = out.project?.dataDir;
  if (typeof dataDir !== 'string' || dataDir === '') return out;
  if (out.store?.kind === 'pglite' && out.store.dataDir === undefined) out.store.dataDir = join(dataDir, 'db');
  if (out.artifacts?.kind === 'fs' && out.artifacts.root === undefined) out.artifacts.root = join(dataDir, 'artifacts');
  return out;
}

/**
 * The default configuration (embedded PGlite at `<dataDir>/db`, in-process bus, local durable runtime with 4
 * concurrent turns, filesystem artifacts at `<dataDir>/artifacts`, no model providers or routes, the native engine,
 * a local loopback sandbox) with `overrides` deep-merged on top. Relative paths stay relative (createHypertest
 * resolves them against the process working directory; loadConfig against the configuration file).
 */
export function defaultConfig(overrides: HypertestConfigInput = {}): HypertestConfig {
  return withDerivedPaths(mergeConfig(baseConfig(), overrides));
}

// ------------------------------------------------------------------------------------------------ interpolation

/** Names of the variables `*Env` fields refer to (they hold secrets and are never interpolated). */
export function secretVariableNames(input: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k.endsWith('Env') && typeof x === 'string') names.add(x);
        else walk(x);
      }
    }
  };
  walk(input);
  return names;
}

const PLACEHOLDER_RE = /\$\$\{|\$\{([^}]*)\}/g;

/**
 * Replaces `${VAR}` / `${VAR:-default}` in string VALUES (keys are never touched; `$${` is a literal `${`). Values of
 * `*Env` fields are variable NAMES and are never interpolated. A variable named by any `*Env` field, or whose name
 * looks like a credential (KEY, SECRET, TOKEN, PASSWORD, …), is refused: secrets reach Hypertest only through
 * `*Env` indirection at runtime, never through the configuration text. Every problem is reported at once.
 */
export function interpolateConfig(input: unknown, env: Record<string, string | undefined>, secretVars: ReadonlySet<string> = secretVariableNames(input)): unknown {
  const errors: string[] = [];
  const subst = (s: string, path: string): string =>
    s.replace(PLACEHOLDER_RE, (whole, body: string | undefined) => {
      if (whole === '$${') return '${';
      const expr = body ?? '';
      const sep = expr.indexOf(':-');
      const name = (sep >= 0 ? expr.slice(0, sep) : expr).trim();
      if (!ENV_NAME_RE.test(name)) {
        errors.push(`${path}: invalid variable reference '${whole}'`);
        return whole;
      }
      if (secretVars.has(name)) {
        errors.push(`${path}: '${name}' holds a secret (it is named by a *Env field) and is never interpolated into the configuration`);
        return whole;
      }
      if (SECRET_NAME_RE.test(name)) {
        errors.push(`${path}: '${name}' looks like a credential and is never interpolated; reference it through a *Env field instead`);
        return whole;
      }
      const value = env[name];
      if (value !== undefined) return value;
      if (sep >= 0) return expr.slice(sep + 2);
      errors.push(`${path}: environment variable '${name}' is not set`);
      return whole;
    });
  const walk = (v: unknown, path: string, key: string): unknown => {
    if (typeof v === 'string') {
      if (key.endsWith('Env')) {
        if (v.includes('${')) errors.push(`${path}: *Env fields name an environment variable and are never interpolated`);
        return v;
      }
      return subst(v, path);
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, key));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) {
          errors.push(`${path}: forbidden key '${k}'`);
          continue;
        }
        out[k] = walk(x, `${path}.${k}`, k);
      }
      return out;
    }
    return v;
  };
  const out = walk(input, '$', '');
  if (errors.length > 0) throw invalid(`configuration interpolation failed:\n  - ${errors.join('\n  - ')}`, { errors });
  return out;
}

// ------------------------------------------------------------------------------------------------ paths

/** Resolves every relative filesystem path of the configuration against `baseDir` (returns a copy). */
export function resolveConfigPaths(config: HypertestConfig, baseDir: string): HypertestConfig {
  const out = jsonClone(config as never) as HypertestConfig;
  const abs = (p: string | undefined): string | undefined => (typeof p === 'string' && p !== '' && !isAbsolute(p) ? resolve(baseDir, p) : p);
  if (out.project && typeof out.project.dataDir === 'string') out.project.dataDir = abs(out.project.dataDir)!;
  if (out.store?.kind === 'pglite' && out.store.dataDir !== undefined) out.store.dataDir = abs(out.store.dataDir)!;
  if (out.artifacts?.kind === 'fs' && out.artifacts.root !== undefined) out.artifacts.root = abs(out.artifacts.root)!;
  if (out.bugate?.path !== undefined) out.bugate.path = abs(out.bugate.path)!;
  if (out.signing?.keyFile !== undefined) out.signing.keyFile = abs(out.signing.keyFile)!;
  return out;
}

/**
 * Loads a configuration file: YAML (`.yaml`/`.yml`, and anything that is not `.json`) or JSON; `${VAR}` interpolation
 * of non-secret string values (see interpolateConfig); deep merge over the defaults; relative paths (including the
 * default `.hypertest` data directory) resolved against the configuration file's directory; validation. Invalid
 * configurations throw `invalid_argument` listing every problem. A missing `apiKeyEnv` variable is NOT an error here
 * (reported by `diagnose`/`hypertest doctor`): keys are read when providers are created.
 */
export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<HypertestConfig> {
  const file = resolve(path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new HypertestError('not_found', `configuration file ${file} not found`, { cause: e });
    throw new HypertestError('unavailable', `configuration file ${file} could not be read: ${(e as Error).message}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw invalid(`configuration file ${file} is not valid ${file.endsWith('.json') ? 'JSON' : 'YAML'}: ${(e as Error).message}`, { file });
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isPlainObject(raw)) throw invalid(`configuration file ${file} must contain a mapping at the top level`, { file });
  let interpolated: unknown;
  try {
    interpolated = interpolateConfig(raw, options.env ?? process.env);
  } catch (e) {
    if (e instanceof HypertestError) throw invalid(`configuration file ${file}: ${e.message}`, { file, ...(e.details ?? {}) });
    throw e;
  }
  const merged = mergeConfig(baseConfig(), interpolated);
  const config = withDerivedPaths(resolveConfigPaths(merged, dirname(file)));
  const errors = validateConfig(config);
  if (errors.length > 0) throw invalid(`invalid configuration ${file}:\n  - ${errors.join('\n  - ')}`, { file, errors });
  return config;
}

// ------------------------------------------------------------------------------------------------ routes

/** The continuation compatibility class a provider tags its responses with (for kinds where it is fixed by the model). */
export function providerCompatibilityClass(provider: ProviderConfig, model: string): string | undefined {
  switch (provider.kind) {
    case 'anthropic':
      return anthropicCompatibilityClass(model);
    case 'openai-compatible':
    case 'scripted':
      return `${provider.id}:${model}`;
    default:
      return undefined; // pi-ai: `pi-ai:<api>:<piProvider>:<model>` needs the resolved pi model (createHypertest)
  }
}

/** A complete ModelCapabilityProfile from a configured route (ROUTE_DEFAULTS for every absent field). */
export function completeRoute(route: RouteConfig, continuationCompatibilityClass: string): ModelCapabilityProfile {
  const profile = { ...(jsonClone(ROUTE_DEFAULTS) as object), ...(jsonClone(route) as object) } as ModelCapabilityProfile;
  profile.continuationCompatibilityClass = route.continuationCompatibilityClass ?? continuationCompatibilityClass;
  return profile;
}

// ------------------------------------------------------------------------------------------------ roles

/**
 * Role overrides: built-in roles ⊕ models.defaultPolicy (every role's model policy) ⊕ the condenser used as a plain
 * summarizer (no required capabilities: it is invoked without tools) ⊕ `roles` from the configuration (wins).
 */
export function roleOverrides(config: HypertestConfig): NonNullable<RoleOverrides['roles']> {
  const out: Record<string, Record<string, unknown>> = {};
  const defaultPolicy = config.models?.defaultPolicy;
  if (defaultPolicy) for (const r of BUILTIN_ROLES) out[r.role] = { defaultModelPolicy: jsonClone(defaultPolicy) };
  out['condenser'] = mergeConfig(out['condenser'] ?? {}, { defaultModelPolicy: { requiredCapabilities: [] } });
  for (const [role, o] of Object.entries(config.roles ?? {})) out[role] = mergeConfig(out[role] ?? {}, o);
  return out as NonNullable<RoleOverrides['roles']>;
}

// ------------------------------------------------------------------------------------------------ validation

type Errors = string[];

function unknownKeys(errors: Errors, path: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (set.has(k)) continue;
    if (INLINE_SECRET_KEYS.has(k)) errors.push(`${path}.${k}: inline secrets are not allowed; set a *Env field to the NAME of an environment variable instead`);
    else errors.push(`${path}: unknown key '${k}' (expected one of ${allowed.join(', ')})`);
  }
}

function str(errors: Errors, path: string, v: unknown, required: boolean): v is string {
  if (v === undefined) {
    if (required) errors.push(`${path} is required`);
    return false;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function envName(errors: Errors, path: string, v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== 'string' || !ENV_NAME_RE.test(v)) errors.push(`${path} must name an environment variable ([A-Za-z_][A-Za-z0-9_]*), got ${JSON.stringify(v)}`);
}

function httpUrl(errors: Errors, path: string, v: unknown, required: boolean): void {
  if (!str(errors, path, v, required)) return;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push(`${path} must be an http(s) URL, got ${v}`);
    if (u.username || u.password) errors.push(`${path} must not embed credentials`);
  } catch {
    errors.push(`${path} must be a URL, got ${JSON.stringify(v)}`);
  }
}

function posInt(errors: Errors, path: string, v: unknown, min = 1): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) errors.push(`${path} must be an integer ≥ ${min}, got ${JSON.stringify(v)}`);
}

function oneOf(errors: Errors, path: string, v: unknown, allowed: readonly string[], required = true): boolean {
  if (v === undefined && !required) return true;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    errors.push(`${path} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);
    return false;
  }
  return true;
}

function objectAt(errors: Errors, path: string, v: unknown, required: boolean): v is Record<string, unknown> {
  if (v === undefined) {
    if (required) errors.push(`${path} is required`);
    return false;
  }
  if (!isPlainObject(v)) {
    errors.push(`${path} must be a mapping`);
    return false;
  }
  return true;
}

function stringList(errors: Errors, path: string, v: unknown): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) errors.push(`${path} must be a list of non-empty strings`);
}

function validateProviders(errors: Errors, providers: unknown): Map<string, ProviderConfig> {
  const byId = new Map<string, ProviderConfig>();
  if (!Array.isArray(providers)) {
    errors.push('models.providers must be a list');
    return byId;
  }
  providers.forEach((p, i) => {
    const at = `models.providers[${i}]`;
    if (!objectAt(errors, at, p, true)) return;
    const id = p['id'];
    const label = typeof id === 'string' ? `${at} (${id})` : at;
    unknownKeys(errors, label, p, ['id', 'kind', 'baseUrl', 'apiKeyEnv', 'headers', 'piProvider', 'timeoutMs', 'maxRetries']);
    if (str(errors, `${label}.id`, id, true)) {
      if (id.startsWith('engine:')) errors.push(`${label}.id: the 'engine:' prefix is reserved for engine adapters in runtime manifests`);
      if (byId.has(id)) errors.push(`${label}.id: duplicate provider id '${id}'`);
    }
    const kind = p['kind'];
    if (typeof kind !== 'string' || !(PROVIDER_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${label}.kind: unknown provider kind ${JSON.stringify(kind)} (expected one of ${PROVIDER_KINDS.join(', ')})`);
    }
    envName(errors, `${label}.apiKeyEnv`, p['apiKeyEnv']);
    if (kind === 'openai-compatible') httpUrl(errors, `${label}.baseUrl`, p['baseUrl'], true);
    else if (p['baseUrl'] !== undefined) httpUrl(errors, `${label}.baseUrl`, p['baseUrl'], false);
    if (kind === 'pi-ai') str(errors, `${label}.piProvider`, p['piProvider'], true);
    else if (p['piProvider'] !== undefined) errors.push(`${label}.piProvider is only valid for kind pi-ai`);
    if (kind === 'scripted' && (p['apiKeyEnv'] !== undefined || p['baseUrl'] !== undefined)) errors.push(`${label}: scripted providers take neither baseUrl nor apiKeyEnv`);
    posInt(errors, `${label}.timeoutMs`, p['timeoutMs']);
    posInt(errors, `${label}.maxRetries`, p['maxRetries'], 0);
    const headers = p['headers'];
    if (headers !== undefined) {
      if (!isPlainObject(headers)) errors.push(`${label}.headers must be a mapping of header name to value`);
      else {
        for (const [h, v] of Object.entries(headers)) {
          if (CREDENTIAL_HEADERS.has(h.toLowerCase()) || CREDENTIAL_HEADER_RE.test(h)) errors.push(`${label}.headers.${h}: credential headers are not allowed in the configuration; set apiKeyEnv`);
          else if (typeof v !== 'string') errors.push(`${label}.headers.${h} must be a string`);
        }
      }
    }
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, p as unknown as ProviderConfig);
  });
  return byId;
}

const ROUTE_KEYS = Object.keys((MODEL_CAPABILITY_PROFILE_SCHEMA as { properties: Record<string, unknown> }).properties);

function validateRoutes(errors: Errors, routes: unknown, providers: Map<string, ProviderConfig>): void {
  if (!Array.isArray(routes)) {
    errors.push('models.routes must be a list');
    return;
  }
  const ids = new Set<string>();
  routes.forEach((r, i) => {
    const at = `models.routes[${i}]`;
    if (!objectAt(errors, at, r, true)) return;
    const label = typeof r['routeId'] === 'string' ? `${at} (${r['routeId']})` : at;
    unknownKeys(errors, label, r, ROUTE_KEYS);
    if (str(errors, `${label}.routeId`, r['routeId'], true)) {
      if (ids.has(r['routeId'])) errors.push(`${label}.routeId: duplicate route id`);
      ids.add(r['routeId']);
    }
    str(errors, `${label}.model`, r['model'], true);
    if (!str(errors, `${label}.provider`, r['provider'], true)) return;
    const provider = providers.get(r['provider']);
    if (!provider) {
      errors.push(`${label}.provider: provider '${r['provider']}' is not declared in models.providers`);
      return;
    }
    if (typeof r['routeId'] !== 'string' || typeof r['model'] !== 'string') return;
    const tag = providerCompatibilityClass(provider, r['model']);
    if (provider.kind === 'anthropic' && r['continuationCompatibilityClass'] !== undefined && r['continuationCompatibilityClass'] !== tag) {
      errors.push(`${label}.continuationCompatibilityClass must equal the provider's tag '${tag}'`);
    }
    const profile = completeRoute(r as unknown as RouteConfig, tag ?? `pi-ai:?:${provider.piProvider ?? '?'}:${r['model']}`);
    const v = validateJson(MODEL_CAPABILITY_PROFILE_SCHEMA, profile);
    if (!v.valid) for (const issue of v.issues.filter((x) => !/additional properties/.test(x.message))) errors.push(`${label}${issue.path && issue.path !== '/' ? issue.path.replaceAll('/', '.') : ''}: ${issue.message}`);
  });
}

function validateStore(errors: Errors, store: unknown): void {
  if (!objectAt(errors, 'store', store, true)) return;
  if (!oneOf(errors, 'store.kind', store['kind'], ['pglite', 'postgres'])) return;
  if (store['kind'] === 'pglite') {
    unknownKeys(errors, 'store', store, ['kind', 'dataDir']);
    if (store['dataDir'] !== undefined) str(errors, 'store.dataDir', store['dataDir'], false);
    return;
  }
  unknownKeys(errors, 'store', store, ['kind', 'url', 'urlEnv', 'schema']);
  const url = store['url'];
  const urlEnv = store['urlEnv'];
  if (url === undefined && urlEnv === undefined) errors.push('store: a postgres store needs url or urlEnv');
  if (url !== undefined && urlEnv !== undefined) errors.push('store: set either url or urlEnv, not both');
  envName(errors, 'store.urlEnv', urlEnv);
  if (url !== undefined && str(errors, 'store.url', url, false)) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') errors.push(`store.url must be a postgres:// URL`);
      if (u.password) errors.push('store.url must not contain a password; put the URL in an environment variable and set store.urlEnv');
      for (const k of u.searchParams.keys()) {
        if (CREDENTIAL_PARAM_RE.test(k)) errors.push(`store.url must not carry credentials (query parameter '${k}'); put the URL in an environment variable and set store.urlEnv`);
      }
    } catch {
      errors.push('store.url must be a postgres:// URL');
    }
  }
  if (store['schema'] !== undefined && (typeof store['schema'] !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(store['schema']))) errors.push('store.schema must be a lowercase SQL identifier ([a-z_][a-z0-9_]*)');
}

function validateSections(errors: Errors, c: Record<string, unknown>): void {
  const bus = c['bus'];
  if (objectAt(errors, 'bus', bus, true) && oneOf(errors, 'bus.kind', bus['kind'], ['inprocess', 'nats'])) {
    if (bus['kind'] === 'inprocess') unknownKeys(errors, 'bus', bus, ['kind']);
    else {
      unknownKeys(errors, 'bus', bus, ['kind', 'servers', 'stream', 'subjectPrefix']);
      if (bus['subjectPrefix'] !== undefined && (typeof bus['subjectPrefix'] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(bus['subjectPrefix']))) errors.push('bus.subjectPrefix must be a single subject token ([A-Za-z0-9_-]+)');
      const s = bus['servers'];
      const list = Array.isArray(s) ? s : [s];
      if (s === undefined || list.length === 0 || list.some((x) => typeof x !== 'string' || x === '')) errors.push('bus.servers must be a server URL or a non-empty list of them');
      else {
        for (const x of list as string[]) {
          let u: URL | undefined;
          try {
            u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(x) ? x : `nats://${x}`);
          } catch {
            errors.push(`bus.servers: ${JSON.stringify(x)} is not a server address`);
          }
          if (u && (u.username || u.password)) errors.push('bus.servers must not embed credentials (user, password or token)');
        }
      }
      if (bus['stream'] !== undefined && (typeof bus['stream'] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(bus['stream']))) errors.push('bus.stream must be a JetStream stream name');
    }
  }
  const durable = c['durable'];
  if (objectAt(errors, 'durable', durable, true) && oneOf(errors, 'durable.kind', durable['kind'], ['local', 'temporal'])) {
    if (durable['kind'] === 'local') {
      unknownKeys(errors, 'durable', durable, ['kind', 'maxConcurrentTurns']);
      posInt(errors, 'durable.maxConcurrentTurns', durable['maxConcurrentTurns']);
    } else {
      unknownKeys(errors, 'durable', durable, ['kind', 'address', 'namespace', 'taskQueue', 'workerMode']);
      str(errors, 'durable.address', durable['address'], true);
      if (durable['namespace'] !== undefined) str(errors, 'durable.namespace', durable['namespace'], false);
      if (durable['taskQueue'] !== undefined) str(errors, 'durable.taskQueue', durable['taskQueue'], false);
      oneOf(errors, 'durable.workerMode', durable['workerMode'], ['embedded', 'external'], false);
    }
  }
  const artifacts = c['artifacts'];
  if (objectAt(errors, 'artifacts', artifacts, true) && oneOf(errors, 'artifacts.kind', artifacts['kind'], ['fs', 's3'])) {
    if (artifacts['kind'] === 'fs') {
      unknownKeys(errors, 'artifacts', artifacts, ['kind', 'root']);
      if (artifacts['root'] !== undefined) str(errors, 'artifacts.root', artifacts['root'], false);
    } else {
      unknownKeys(errors, 'artifacts', artifacts, ['kind', 'endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'objectLockDays', 'accessKeyIdEnv', 'secretAccessKeyEnv']);
      str(errors, 'artifacts.region', artifacts['region'], true);
      str(errors, 'artifacts.bucket', artifacts['bucket'], true);
      if (artifacts['endpoint'] !== undefined) httpUrl(errors, 'artifacts.endpoint', artifacts['endpoint'], false);
      posInt(errors, 'artifacts.objectLockDays', artifacts['objectLockDays']);
      envName(errors, 'artifacts.accessKeyIdEnv', artifacts['accessKeyIdEnv']);
      envName(errors, 'artifacts.secretAccessKeyEnv', artifacts['secretAccessKeyEnv']);
      if ((artifacts['accessKeyIdEnv'] === undefined) !== (artifacts['secretAccessKeyEnv'] === undefined)) errors.push('artifacts: set both accessKeyIdEnv and secretAccessKeyEnv, or neither (default AWS credential chain)');
      if (artifacts['forcePathStyle'] !== undefined && typeof artifacts['forcePathStyle'] !== 'boolean') errors.push('artifacts.forcePathStyle must be a boolean');
    }
  }
  const memory = c['memory'];
  if (memory !== undefined && objectAt(errors, 'memory', memory, false) && oneOf(errors, 'memory.kind', memory['kind'], ['sql', 'powercontext'])) {
    if (memory['kind'] === 'sql') unknownKeys(errors, 'memory', memory, ['kind']);
    else {
      unknownKeys(errors, 'memory', memory, ['kind', 'baseUrl', 'apiKeyEnv']);
      httpUrl(errors, 'memory.baseUrl', memory['baseUrl'], true);
      envName(errors, 'memory.apiKeyEnv', memory['apiKeyEnv']);
    }
  }
}

function validatePolicy(errors: Errors, policy: unknown): void {
  if (!objectAt(errors, 'policy', policy, false)) return;
  unknownKeys(errors, 'policy', policy, ['rules', 'opa', 'capabilitySecretEnv']);
  envName(errors, 'policy.capabilitySecretEnv', policy['capabilitySecretEnv']);
  const rules = policy['rules'];
  if (rules !== undefined) {
    if (!Array.isArray(rules)) errors.push('policy.rules must be a list');
    else {
      const builtin = new Set(DEFAULT_POLICY_RULES.map((r) => r.id));
      const seen = new Set<string>();
      rules.forEach((r, i) => {
        const id = isPlainObject(r) ? r['id'] : undefined;
        const label = typeof id === 'string' ? `policy.rules[${i}] (${id})` : `policy.rules[${i}]`;
        const v = validateJson(POLICY_RULE_SCHEMA, r);
        if (!v.valid) for (const issue of v.issues) errors.push(`${label}${issue.path && issue.path !== '/' ? issue.path.replaceAll('/', '.') : ''}: ${issue.message}`);
        if (typeof id === 'string') {
          if (builtin.has(id)) errors.push(`${label}.id: '${id}' is a built-in rule id; choose another id`);
          if (seen.has(id)) errors.push(`${label}.id: duplicate rule id '${id}'`);
          seen.add(id);
        }
      });
    }
  }
  const opa = policy['opa'];
  if (opa !== undefined && objectAt(errors, 'policy.opa', opa, false)) {
    unknownKeys(errors, 'policy.opa', opa, ['url', 'path', 'timeoutMs']);
    httpUrl(errors, 'policy.opa.url', opa['url'], true);
    if (opa['path'] !== undefined) str(errors, 'policy.opa.path', opa['path'], false);
    posInt(errors, 'policy.opa.timeoutMs', opa['timeoutMs']);
  }
}

const BUDGET_KEYS = ['maxWallClockMs', 'maxAgentConcurrency', 'maxModelTokens', 'maxModelCostUsd', 'maxToolCalls', 'maxComputeMinutes', 'maxExternalQps', 'maxArtifactBytes', 'maxWorkItems', 'maxAgentDepth', 'maxPlanRevisions'];
/** Budget caps the control plane requires to be integers (≥ 1; maxAgentDepth ≥ 0): a run with another value is refused at start. */
const INTEGER_BUDGET_KEYS: Record<string, number> = { maxWallClockMs: 1, maxAgentConcurrency: 1, maxModelTokens: 1, maxToolCalls: 1, maxWorkItems: 1, maxPlanRevisions: 1, maxAgentDepth: 0 };
const GATE_KEYS = ['gateId', 'description', 'failOnUnresolvedSeverity', 'conditionalOnRiskLevel', 'requiredEvidence', 'requireDeterministicForCritical', 'requireIndependentReview', 'minCoverage', 'requireOracle'];

function validateBudget(errors: Errors, budget: unknown, path: string): void {
  if (budget === undefined || !objectAt(errors, path, budget, false)) return;
  unknownKeys(errors, path, budget, BUDGET_KEYS);
  for (const [k, v] of Object.entries(budget)) {
    if (!BUDGET_KEYS.includes(k)) continue;
    const min = INTEGER_BUDGET_KEYS[k];
    if (min !== undefined) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) errors.push(`${path}.${k} must be an integer ≥ ${min}`);
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`${path}.${k} must be a finite number ≥ 0`);
  }
}

/**
 * A (partial) GateSpec. Every field is checked: the QualityGate trusts its spec, and e.g. an unknown
 * `failOnUnresolvedSeverity` would make no finding "at least as severe" — silently disabling the rule that unresolved
 * P0/P1 findings fail the gate.
 */
function validateGate(errors: Errors, gate: unknown, path: string): void {
  if (gate === undefined || !objectAt(errors, path, gate, false)) return;
  unknownKeys(errors, path, gate, GATE_KEYS);
  if (gate['gateId'] !== undefined) str(errors, `${path}.gateId`, gate['gateId'], false);
  if (gate['description'] !== undefined && typeof gate['description'] !== 'string') errors.push(`${path}.description must be a string`);
  oneOf(errors, `${path}.failOnUnresolvedSeverity`, gate['failOnUnresolvedSeverity'], ['P0', 'P1', 'P2', 'P3'], false); // the domain's Severity (H3: 'P4' would disable C2)
  oneOf(errors, `${path}.conditionalOnRiskLevel`, gate['conditionalOnRiskLevel'], ['low', 'medium', 'high', 'critical'], false);
  for (const k of ['requireDeterministicForCritical', 'requireIndependentReview', 'requireOracle']) if (gate[k] !== undefined && typeof gate[k] !== 'boolean') errors.push(`${path}.${k} must be a boolean`);
  const required = gate['requiredEvidence'];
  if (required !== undefined) {
    if (!Array.isArray(required)) errors.push(`${path}.requiredEvidence must be a list`);
    else {
      required.forEach((r, i) => {
        const at = `${path}.requiredEvidence[${i}]`;
        if (!objectAt(errors, at, r, true)) return;
        unknownKeys(errors, at, r, ['evidenceType', 'minCount', 'description', 'critical']);
        str(errors, `${at}.evidenceType`, r['evidenceType'], true);
        if (r['minCount'] === undefined) errors.push(`${at}.minCount is required (an integer ≥ 1)`);
        else posInt(errors, `${at}.minCount`, r['minCount'], 1);
        if (r['description'] !== undefined && typeof r['description'] !== 'string') errors.push(`${at}.description must be a string`);
        if (r['critical'] !== undefined && typeof r['critical'] !== 'boolean') errors.push(`${at}.critical must be a boolean`);
      });
    }
  }
  const cov = gate['minCoverage'];
  if (cov !== undefined && objectAt(errors, `${path}.minCoverage`, cov, false)) {
    unknownKeys(errors, `${path}.minCoverage`, cov, ['lines', 'branches']);
    for (const k of ['lines', 'branches']) {
      const v = cov[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) errors.push(`${path}.minCoverage.${k} must be a number in [0, 100] (a ratio ≤ 1 or a percentage)`);
    }
  }
}

/**
 * (additive) Problems of a run's own `budget` / `gate` overrides (StartRunInput), with the same rules as the
 * configuration's `budget` / `gate`. `createHypertest().start()` refuses a run with any (invalid_argument).
 */
export function validateRunOverrides(input: { budget?: unknown; gate?: unknown }): string[] {
  const errors: Errors = [];
  validateBudget(errors, input.budget, 'budget');
  validateGate(errors, input.gate, 'gate');
  return errors;
}

const ORACLE_KINDS = ['deterministic_invariant', 'requirement', 'differential', 'metamorphic', 'statistical', 'llm_semantic'];
const ORACLE_AUTHORITIES = ['formal_spec', 'approved_requirement', 'business_rule', 'known_good_reference', 'differential_reference', 'expert_approved'];
const CHECK_TYPES = ['test_outcome', 'metric_threshold', 'http_expectation', 'evidence_predicate', 'llm_rubric'];
const COMPARATORS = ['<', '<=', '>', '>=', '==', '!='];

/** (conformance-1) `oracles`: configured oracles established by a named human authority. */
function validateOracles(errors: Errors, oracles: unknown): void {
  if (oracles === undefined) return;
  if (!Array.isArray(oracles)) {
    errors.push('oracles must be a list');
    return;
  }
  const seen = new Set<string>();
  oracles.forEach((o: unknown, i: number) => {
    const at = `oracles[${i}]`;
    if (!objectAt(errors, at, o, true)) return;
    unknownKeys(errors, at, o, ['oracleId', 'scope', 'assertions', 'authorities', 'judgePolicy', 'changePolicy', 'establishedBy']);
    str(errors, `${at}.oracleId`, o['oracleId'], true);
    if (typeof o['oracleId'] === 'string') {
      if (seen.has(o['oracleId'])) errors.push(`${at}.oracleId: duplicate oracle id ${o['oracleId']}`);
      seen.add(o['oracleId']);
    }
    str(errors, `${at}.establishedBy`, o['establishedBy'], true);
    if (typeof o['establishedBy'] === 'string' && !/^[\p{L}\p{N}._@+-][\p{L}\p{N}._@+\- ]{0,127}$/u.test(o['establishedBy'])) errors.push(`${at}.establishedBy must be a person's name or handle`);
    const scope = o['scope'];
    if (objectAt(errors, `${at}.scope`, scope, true)) {
      unknownKeys(errors, `${at}.scope`, scope, ['components', 'description']);
      stringList(errors, `${at}.scope.components`, scope['components']);
      if (!Array.isArray(scope['components'])) errors.push(`${at}.scope.components is required (a list)`);
      str(errors, `${at}.scope.description`, scope['description'], true);
    }
    const assertions = o['assertions'];
    if (!Array.isArray(assertions) || assertions.length === 0) errors.push(`${at}.assertions must be a non-empty list`);
    else {
      const ids = new Set<string>();
      assertions.forEach((a: unknown, j: number) => {
        const aat = `${at}.assertions[${j}]`;
        if (!objectAt(errors, aat, a, true)) return;
        unknownKeys(errors, aat, a, ['assertionId', 'description', 'kind', 'severity', 'check']);
        str(errors, `${aat}.assertionId`, a['assertionId'], true);
        if (typeof a['assertionId'] === 'string') {
          if (ids.has(a['assertionId'])) errors.push(`${aat}.assertionId: duplicate ${a['assertionId']}`);
          ids.add(a['assertionId']);
        }
        str(errors, `${aat}.description`, a['description'], true);
        oneOf(errors, `${aat}.kind`, a['kind'], ORACLE_KINDS, true);
        oneOf(errors, `${aat}.severity`, a['severity'], ['P0', 'P1', 'P2', 'P3'], true);
        const check = a['check'];
        if (check !== undefined && objectAt(errors, `${aat}.check`, check, false)) {
          oneOf(errors, `${aat}.check.type`, check['type'], CHECK_TYPES, true);
          if (check['type'] === 'test_outcome') {
            str(errors, `${aat}.check.testSelector`, check['testSelector'], true);
            if (check['expected'] !== 'pass') errors.push(`${aat}.check.expected must be "pass"`);
          } else if (check['type'] === 'metric_threshold') {
            str(errors, `${aat}.check.metric`, check['metric'], true);
            oneOf(errors, `${aat}.check.comparator`, check['comparator'], COMPARATORS, true);
            if (typeof check['threshold'] !== 'number' || !Number.isFinite(check['threshold'])) errors.push(`${aat}.check.threshold must be a finite number`);
            oneOf(errors, `${aat}.check.aggregation`, check['aggregation'], ['avg', 'p50', 'p95', 'p99', 'max', 'min', 'rate'], false);
          } else if (check['type'] === 'http_expectation') {
            str(errors, `${aat}.check.method`, check['method'], true);
            str(errors, `${aat}.check.path`, check['path'], true);
          } else if (check['type'] === 'evidence_predicate') {
            str(errors, `${aat}.check.evidenceType`, check['evidenceType'], true);
            str(errors, `${aat}.check.field`, check['field'], true);
            oneOf(errors, `${aat}.check.comparator`, check['comparator'], COMPARATORS, true);
          } else if (check['type'] === 'llm_rubric') str(errors, `${aat}.check.rubric`, check['rubric'], true);
        }
      });
    }
    const authorities = o['authorities'];
    if (authorities !== undefined) {
      if (!Array.isArray(authorities)) errors.push(`${at}.authorities must be a list`);
      else authorities.forEach((x: unknown, j: number) => {
        if (!objectAt(errors, `${at}.authorities[${j}]`, x, true)) return;
        str(errors, `${at}.authorities[${j}].sourceRef`, x['sourceRef'], true);
        oneOf(errors, `${at}.authorities[${j}].authority`, x['authority'], ORACLE_AUTHORITIES, true);
      });
    }
    const judge = o['judgePolicy'];
    if (judge !== undefined && objectAt(errors, `${at}.judgePolicy`, judge, false)) {
      unknownKeys(errors, `${at}.judgePolicy`, judge, ['deterministicRequiredForCritical', 'allowLlmOnlyDecision', 'independentReviewerRequired']);
      for (const k of ['deterministicRequiredForCritical', 'allowLlmOnlyDecision', 'independentReviewerRequired']) if (judge[k] !== undefined && typeof judge[k] !== 'boolean') errors.push(`${at}.judgePolicy.${k} must be a boolean`);
    }
    const change = o['changePolicy'];
    if (change !== undefined && objectAt(errors, `${at}.changePolicy`, change, false)) {
      unknownKeys(errors, `${at}.changePolicy`, change, ['agentMayPropose', 'invalidatesPriorDecisions', 'approvers']);
      for (const k of ['agentMayPropose', 'invalidatesPriorDecisions']) if (change[k] !== undefined && typeof change[k] !== 'boolean') errors.push(`${at}.changePolicy.${k} must be a boolean`);
      const approvers = change['approvers'];
      if (approvers !== undefined && (!Array.isArray(approvers) || approvers.length === 0 || approvers.some((x) => x !== 'human' && x !== 'independent_agent'))) errors.push(`${at}.changePolicy.approvers must list human and/or independent_agent`);
    }
  });
}

/** (additive, conformance-1) Problems of an `oracles` list (the configuration section, or a file `hypertest oracle establish` reads). */
export function oracleConfigProblems(oracles: unknown): string[] {
  const errors: Errors = [];
  validateOracles(errors, oracles);
  return errors;
}

/** (additive, conformance-1) The OracleGovernance.establish input of a configured oracle (defaults applied). */
export function oracleSpecFromConfig(o: OracleConfig): Parameters<OracleGovernance['establish']>[0] {
  return {
    oracleId: o.oracleId,
    scope: { components: [...o.scope.components], description: o.scope.description },
    assertions: o.assertions.map((a) => ({ ...a })),
    authorities: o.authorities?.map((a) => ({ ...a })) ?? [{ sourceRef: 'hypertest.config', authority: 'approved_requirement' }],
    judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true, ...(o.judgePolicy ?? {}) },
    changePolicy: { agentMayPropose: true, invalidatesPriorDecisions: true, approvers: ['human'], ...(o.changePolicy ?? {}), selfApprove: false },
  };
}

function validateRest(errors: Errors, c: Record<string, unknown>): void {
  validateBudget(errors, c['budget'], 'budget');
  validateGate(errors, c['gate'], 'gate');
  validateOracles(errors, c['oracles']);
  const bugate = c['bugate'];
  if (bugate !== undefined && objectAt(errors, 'bugate', bugate, false)) {
    unknownKeys(errors, 'bugate', bugate, ['path']);
    if (bugate['path'] !== undefined) str(errors, 'bugate.path', bugate['path'], false);
  }
  const engines = c['engines'];
  if (engines !== undefined && objectAt(errors, 'engines', engines, false)) {
    unknownKeys(errors, 'engines', engines, ['default']);
    if (typeof engines['default'] !== 'string' || !(ENGINE_KINDS as readonly string[]).includes(engines['default'])) {
      errors.push(`engines.default: ${JSON.stringify(engines['default'])} is not a registered engine (${ENGINE_KINDS.join(', ')})`);
    }
  }
  const sandbox = c['sandbox'];
  if (sandbox !== undefined && objectAt(errors, 'sandbox', sandbox, false)) {
    unknownKeys(errors, 'sandbox', sandbox, ['kind', 'image', 'network', 'allowedHosts', 'envAllowlist', 'cpuLimit', 'memoryMb']);
    oneOf(errors, 'sandbox.kind', sandbox['kind'], ['local', 'oci'], false);
    if (sandbox['kind'] === 'oci') str(errors, 'sandbox.image', sandbox['image'], true);
    oneOf(errors, 'sandbox.network', sandbox['network'], ['none', 'loopback', 'egress_allowlist', 'open'], false);
    stringList(errors, 'sandbox.allowedHosts', sandbox['allowedHosts']);
    const allow = sandbox['envAllowlist'];
    if (allow !== undefined) {
      if (!Array.isArray(allow) || allow.some((x) => typeof x !== 'string' || !ENV_NAME_RE.test(x))) errors.push('sandbox.envAllowlist must be a list of environment variable names');
      else for (const name of allow as string[]) if (SECRET_NAME_RE.test(name)) errors.push(`sandbox.envAllowlist: '${name}' looks like a credential; secrets are never passed to sandboxed processes`);
    }
    for (const k of ['cpuLimit', 'memoryMb']) if (sandbox[k] !== undefined && (typeof sandbox[k] !== 'number' || !((sandbox[k] as number) > 0))) errors.push(`sandbox.${k} must be a positive number`);
  }
  const envs = c['environments'];
  if (envs !== undefined) {
    if (!Array.isArray(envs)) errors.push('environments must be a list');
    else {
      const seen = new Set<string>();
      envs.forEach((e, i) => {
        const at = `environments[${i}]`;
        if (!objectAt(errors, at, e, true)) return;
        unknownKeys(errors, at, e, ['environmentId', 'environmentClass', 'baseUrl', 'metricsUrl', 'prometheusUrl', 'generation', 'buildDigest', 'control']);
        if (str(errors, `${at}.environmentId`, e['environmentId'], true)) {
          if (seen.has(e['environmentId'])) errors.push(`${at}.environmentId: duplicate environment '${e['environmentId']}'`);
          seen.add(e['environmentId']);
        }
        str(errors, `${at}.environmentClass`, e['environmentClass'], true);
        if (e['generation'] === undefined) errors.push(`${at}.generation is required (an integer ≥ 0)`);
        else posInt(errors, `${at}.generation`, e['generation'], 0);
        for (const k of ['baseUrl', 'metricsUrl', 'prometheusUrl']) if (e[k] !== undefined) httpUrl(errors, `${at}.${k}`, e[k], false);
        const control = e['control'];
        if (control !== undefined && objectAt(errors, `${at}.control`, control, false)) {
          unknownKeys(errors, `${at}.control`, control, ['kind', 'target', 'namespace', 'command', 'tokenEnv']);
          oneOf(errors, `${at}.control.kind`, control['kind'], ['process', 'docker', 'kubectl']);
          if (str(errors, `${at}.control.target`, control['target'], true) && /#.*\btoken=/i.test(control['target'])) {
            errors.push(`${at}.control.target: inline control tokens are not allowed; set control.tokenEnv to the NAME of the variable holding the token`);
          }
          stringList(errors, `${at}.control.command`, control['command']);
          if (control['tokenEnv'] !== undefined) {
            envName(errors, `${at}.control.tokenEnv`, control['tokenEnv']);
            if (control['kind'] !== 'process') errors.push(`${at}.control.tokenEnv is only valid for kind process (the process supervisor's control token)`);
          }
        }
      });
    }
  }
  const tools = c['tools'];
  if (tools !== undefined && objectAt(errors, 'tools', tools, false)) {
    unknownKeys(errors, 'tools', tools, ['shellAllowlist', 'httpAllowlist', 'enableBrowser']);
    stringList(errors, 'tools.shellAllowlist', tools['shellAllowlist']);
    stringList(errors, 'tools.httpAllowlist', tools['httpAllowlist']);
    if (tools['enableBrowser'] !== undefined && typeof tools['enableBrowser'] !== 'boolean') errors.push('tools.enableBrowser must be a boolean');
  }
  const signing = c['signing'];
  if (signing !== undefined && objectAt(errors, 'signing', signing, false)) {
    unknownKeys(errors, 'signing', signing, ['keyFile']);
    if (signing['keyFile'] !== undefined) str(errors, 'signing.keyFile', signing['keyFile'], false);
  }
  const obs = c['observability'];
  if (obs !== undefined && objectAt(errors, 'observability', obs, false)) {
    unknownKeys(errors, 'observability', obs, ['logLevel']);
    oneOf(errors, 'observability.logLevel', obs['logLevel'], ['debug', 'info', 'warn', 'error'], false);
  }
  const roles = c['roles'];
  const models = c['models'];
  if (roles !== undefined || (isPlainObject(models) && models['defaultPolicy'] !== undefined)) {
    if (roles !== undefined && !isPlainObject(roles)) errors.push('roles must be a mapping of role id to overrides');
    else if (!isPlainObject(models) || models['defaultPolicy'] === undefined || isPlainObject(models['defaultPolicy'])) {
      const hasPolicy = isPlainObject(models) && models['defaultPolicy'] !== undefined;
      const label = roles !== undefined && hasPolicy ? 'roles + models.defaultPolicy' : roles !== undefined ? 'roles' : 'models.defaultPolicy';
      try {
        new RoleCatalog(BUILTIN_ROLES, { roles: roleOverrides(c as unknown as HypertestConfig) });
      } catch (e) {
        errors.push(`${label}: ${(e as Error).message}`);
      }
    }
  }
}

/**
 * Validates a configuration and returns human-readable problems (empty when valid): unknown keys, inline secrets,
 * unknown provider kinds, routes naming undeclared providers or invalid capability profiles, invalid policy rules,
 * unknown engines, malformed stores/buses/durable runtimes/artifact stores. It never reads environment variables.
 */
export function validateConfig(config: HypertestConfig): string[] {
  const errors: Errors = [];
  if (!isPlainObject(config)) return ['configuration must be a mapping'];
  const c = config as unknown as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!TOP_LEVEL_KEYS.has(k)) errors.push(`unknown configuration key '${k}' (expected one of ${[...TOP_LEVEL_KEYS].join(', ')})`);
  if (c['version'] !== 1) errors.push(`version must be 1, got ${JSON.stringify(c['version'])}`);
  const project = c['project'];
  if (objectAt(errors, 'project', project, true)) {
    unknownKeys(errors, 'project', project, ['name', 'dataDir']);
    str(errors, 'project.name', project['name'], true);
    str(errors, 'project.dataDir', project['dataDir'], true);
  }
  validateStore(errors, c['store']);
  validateSections(errors, c);
  const models = c['models'];
  if (objectAt(errors, 'models', models, true)) {
    unknownKeys(errors, 'models', models, ['providers', 'routes', 'defaultPolicy']);
    const providers = validateProviders(errors, models['providers']);
    validateRoutes(errors, models['routes'], providers);
    if (models['defaultPolicy'] !== undefined && !isPlainObject(models['defaultPolicy'])) errors.push('models.defaultPolicy must be a mapping');
  }
  validatePolicy(errors, c['policy']);
  validateRest(errors, c);
  return errors;
}
