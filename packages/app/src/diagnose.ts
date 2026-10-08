import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { connect } from 'node:net';
import { FixedClock, HypertestError, SequentialIdGenerator, noopLogger } from '@hypertest/core';
import { openDatabase } from '@hypertest/store';
import { ModelCatalog, PiAiProvider, ProviderRegistry, createModelRouter, credentialAvailability, piCompatibilityClass, type ModelCapabilityProfile, type ModelProvider } from '@hypertest/model';
import { resolveProtocolBinding } from '@hypertest/policy';
import { createOciSandbox, networkIsolation } from '@hypertest/tools';
import { pluginDigest } from '@hypertest/runtime';
import { BUILTIN_ROLES, RoleCatalog, SPECIALIST_ROLES, type RoleDefinition } from '@hypertest/agents';
import { isLoopbackHost } from './api.ts';
import { completeRoute, defaultedRouteFields, providerCompatibilityClass, resolveConfigPaths, roleOverrides, validateConfig, withDerivedPaths } from './config.ts';
import { sandboxProfile } from './compose.ts';
import { lockFileFor, lockHolder } from './lock.ts';
import type { DiagnoseOptions, DiagnosticCheck, DiagnosticReport, HypertestConfig, ProviderConfig } from './contracts.ts';

/**
 * `hypertest doctor`: checks a configuration without starting Hypertest — validation, secrets named by `*Env` fields
 * (presence only; values are never printed), model routes (can every built-in role be routed? a lead without a route
 * is an error: every run would fail at routing), the BUGate binding, the default engine, the sandbox, and (unless
 * `connect: false`) reachability of the configured infrastructure (PostgreSQL, NATS, Temporal, OPA, PowerContext).
 */
export async function diagnose(input: HypertestConfig, options: DiagnoseOptions = {}): Promise<DiagnosticReport> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 3000;
  const checks: DiagnosticCheck[] = [];
  const add = (name: string, status: DiagnosticCheck['status'], detail: string) => checks.push({ name, status, detail });

  const errors = validateConfig(input);
  if (errors.length > 0) {
    for (const e of errors) add('config', 'error', e);
    return { ok: false, checks };
  }
  add('config', 'ok', 'configuration is valid');
  const config = withDerivedPaths(resolveConfigPaths(input, process.cwd()));

  // ---- secrets (presence only)
  const secret = (name: string, variable: string | undefined, required: boolean, what: string) => {
    if (!variable) return;
    const v = env[variable];
    if (v === undefined || v === '') add(name, required ? 'error' : 'warn', `${what}: environment variable ${variable} is not set`);
    else add(name, 'ok', `${what}: ${variable} is set`);
  };
  for (const p of config.models.providers) {
    if (p.apiKeyEnv) secret('secrets', p.apiKeyEnv, true, `provider ${p.id} (apiKeyEnv)`);
    else if (p.kind === 'anthropic' && !p.baseUrl) add('secrets', 'error', `provider ${p.id}: no apiKeyEnv configured; the hosted Anthropic API needs a key — the provider is unavailable (fail closed, no request is sent)`);
    else if (p.kind === 'anthropic') add('secrets', 'warn', `provider ${p.id}: no apiKeyEnv configured; calls to ${p.baseUrl} are sent without an API key`);
  }
  if (config.store.kind === 'postgres') secret('secrets', config.store.urlEnv, true, 'store (urlEnv)');
  if (config.policy?.capabilitySecretEnv) {
    const v = env[config.policy.capabilitySecretEnv];
    if (v === undefined || v === '') add('secrets', 'error', `policy.capabilitySecretEnv: ${config.policy.capabilitySecretEnv} is not set`);
    else if (v.length < 16) add('secrets', 'error', `policy.capabilitySecretEnv: ${config.policy.capabilitySecretEnv} is shorter than 16 characters`);
    else add('secrets', 'ok', `policy.capabilitySecretEnv: ${config.policy.capabilitySecretEnv} is set`);
  } else if (config.store.kind === 'postgres') {
    add('secrets', 'warn', 'store is postgres but policy.capabilitySecretEnv is not set: every worker generates its own capability secret; workers sharing the database need a shared one');
  }
  if (config.memory?.kind === 'powercontext') secret('secrets', config.memory.apiKeyEnv, true, 'memory (apiKeyEnv)');
  if (config.artifacts.kind === 's3') {
    secret('secrets', config.artifacts.accessKeyIdEnv, true, 'artifacts (accessKeyIdEnv)');
    secret('secrets', config.artifacts.secretAccessKeyEnv, true, 'artifacts (secretAccessKeyEnv)');
  }
  for (const e of config.environments ?? []) secret('secrets', e.control?.tokenEnv, true, `environment ${e.environmentId} (control.tokenEnv)`);
  for (const p of config.models.providers) {
    if (p.maxRetries !== undefined) add('models', 'warn', `provider ${p.id}: maxRetries is not supported (retries and fail-closed fallback are the model router's); the value is ignored`);
  }

  // ---- models: can the roles be routed? (a provider without its credential is unavailable: e2e[3])
  await checkRoutes(config, add, env);

  // ---- A[6] kernel plugins: the entry exists and matches its pinned digest (doctor runs no plugin code)
  for (const p of config.plugins ?? []) {
    try {
      const actual = pluginDigest(await readFile(p.entry));
      if (actual !== p.digest) add('plugins', 'error', `plugin ${p.id}: digest mismatch — configured ${p.digest}, ${p.entry} is ${actual}: Hypertest refuses to start with it`);
      else add('plugins', 'ok', `plugin ${p.id} ${p.version} (${p.kind}; ${p.capabilities.join(', ')}): ${p.entry} matches its digest`);
    } catch (e) {
      add('plugins', 'error', `plugin ${p.id}: entry ${p.entry} cannot be read: ${(e as Error).message}`);
    }
  }

  // ---- protocol + engines + sandbox
  try {
    const p = await resolveProtocolBinding(config.bugate?.path ? { bugatePath: config.bugate.path } : {});
    const src = p.binding.source.kind === 'bugate_checkout' ? `checkout ${p.binding.source.path}` : 'embedded';
    if (config.bugate?.path && p.binding.source.kind === 'embedded') add('protocol', 'warn', `no BUGate checkout at ${config.bugate.path} (protocol/v2/manifest.yaml missing); using the embedded protocol ${p.binding.version}`);
    else add('protocol', 'ok', `BUGate ${p.binding.version} (${src}), digest ${p.binding.digest.slice(0, 16)}`);
  } catch (e) {
    add('protocol', 'error', (e as Error).message);
  }
  add('engines', 'ok', `default engine ${config.engines?.default ?? 'native'}`);
  const profile = sandboxProfile(config);
  if (profile.kind === 'oci') {
    const ok = options.connect === false ? undefined : await createOciSandbox({ image: profile.image! }).available!().catch(() => false);
    if (ok === false) add('sandbox', 'error', `OCI sandbox (${profile.image}): the docker daemon is not reachable`);
    else add('sandbox', ok ? 'ok' : 'warn', `OCI sandbox (${profile.image})${ok ? '' : ': not probed'}`);
  } else {
    const allow = `env allowlist ${profile.envAllowlist.join(', ') || '(none)'}`;
    // E[4]: where the sandbox cannot hide keys, capability secret and store, Hypertest refuses to start (fail closed)
    // unless sandbox.insecureAllowUnhiddenSecrets: true — then a warning, never ok
    const optedIn = config.sandbox?.insecureAllowUnhiddenSecrets === true;
    const unhidden = (what: string) =>
      optedIn
        ? add('sandbox', 'warn', `${what}; INSECURE (sandbox.insecureAllowUnhiddenSecrets): keys, capability secret and store are NOT hidden from commands agents run, ${allow}`)
        : add('sandbox', 'error', `${what}: keys, capability secret and store would NOT be hidden from commands agents run, so Hypertest refuses to start — use the OCI sandbox or a host with python3 and PID/mount namespaces, or accept it with sandbox.insecureAllowUnhiddenSecrets: true`);
    if (profile.network === 'open') unhidden('local sandbox, network open (commands agents run reach any host: no egress governance, no namespaces)');
    else {
      // security-2: every other profile runs commands in a network namespace; without one the sandbox refuses them
      const iso = await networkIsolation();
      if (iso.available && iso.jail) add('sandbox', 'ok', `local sandbox, network ${profile.network} (enforced: ${iso.strategy}, private loopback; keys, store and other workspaces hidden), ${allow}`);
      else if (iso.available) unhidden(`local sandbox, network ${profile.network} (enforced: ${iso.strategy}${iso.loopback ? ', private loopback' : ', no loopback'}; no PID/mount jail)`);
      else add('sandbox', 'error', `local sandbox, network ${profile.network} cannot be enforced on this host (${iso.reason}): every command agents run would be refused — use the OCI sandbox`);
    }
  }

  // ---- storage and infrastructure
  if (config.store.kind === 'pglite') {
    await writable(add, 'store', config.store.dataDir!, 'PGlite data directory');
    const lockFile = lockFileFor(config.store.dataDir!);
    const holder = await lockHolder(lockFile).catch(() => undefined);
    if (holder && holder.alive !== false) {
      const who = holder.pid !== undefined ? `process ${holder.pid}${holder.hostname ? ` on ${holder.hostname}` : ''}` : 'an unknown process';
      add('store', 'warn', `PGlite data directory ${config.store.dataDir} is in use by ${who} (lock file ${lockFile}): another Hypertest process cannot open it until that one stops`);
    }
  }
  if (config.artifacts.kind === 'fs') await writable(add, 'artifacts', config.artifacts.root!, 'artifact store');
  else add('artifacts', 'warn', `S3 bucket ${config.artifacts.bucket} is not probed by doctor`);
  if (options.connect !== false) {
    if (config.store.kind === 'postgres') {
      const url = config.store.url ?? (config.store.urlEnv ? env[config.store.urlEnv] : undefined);
      if (url) {
        try {
          // no `schema` here: opening with a schema creates it, and doctor is read-only
          const db = await withTimeout(openDatabase({ kind: 'postgres', url }), timeoutMs, 'postgres');
          try {
            await withTimeout(db.query('SELECT 1'), timeoutMs, 'postgres');
            const schema = config.store.schema;
            if (schema) {
              const r = await withTimeout(db.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]), timeoutMs, 'postgres');
              if (r.rows.length === 0) add('store', 'warn', `PostgreSQL is reachable; schema ${schema} does not exist yet (created at the first start)`);
              else add('store', 'ok', `PostgreSQL is reachable (schema ${schema})`);
            } else add('store', 'ok', 'PostgreSQL is reachable');
          } finally {
            await db.close();
          }
        } catch (e) {
          add('store', 'error', `PostgreSQL is not reachable: ${(e as Error).message}`);
        }
      }
    }
    if (config.bus.kind === 'nats') {
      for (const s of Array.isArray(config.bus.servers) ? config.bus.servers : [config.bus.servers]) await tcp(add, 'bus', s, 4222, timeoutMs, 'NATS');
    }
    if (config.durable.kind === 'temporal') await tcp(add, 'durable', config.durable.address, 7233, timeoutMs, 'Temporal');
    if (config.policy?.opa) await http(add, 'policy', `${config.policy.opa.url.replace(/\/+$/, '')}/health`, timeoutMs, 'OPA', true);
    if (config.memory?.kind === 'powercontext') await http(add, 'memory', config.memory.baseUrl, timeoutMs, 'PowerContext', false);
  }
  return { ok: checks.every((c) => c.status !== 'error'), checks };
}

type Add = (name: string, status: DiagnosticCheck['status'], detail: string) => void;

async function checkRoutes(config: HypertestConfig, add: Add, env: Record<string, string | undefined>): Promise<void> {
  if (config.models.routes.filter((r) => r.enabled !== false).length === 0) {
    add('models', 'error', 'no model routes are configured: every run fails when it routes its lead agent (add models.providers and models.routes)');
    return;
  }
  // stub providers: routing never calls a provider. A provider without its required credential is unavailable exactly as in
  // createHypertest (e2e[3]): its routes are never used, so roles routable only through it are reported unroutable.
  const providers = new ProviderRegistry(
    config.models.providers.map((p): ModelProvider => {
      const requireApiKey = p.kind !== 'scripted' && (p.apiKeyEnv !== undefined || (p.kind === 'anthropic' && !p.baseUrl));
      const credential = credentialAvailability(p.id, requireApiKey, p.apiKeyEnv ? env[p.apiKeyEnv] : undefined, p.apiKeyEnv ?? `models.providers[${p.id}].apiKeyEnv (not configured)`);
      if (!credential.ok) {
        const routes = config.models.routes.filter((r) => r.provider === p.id).map((r) => r.routeId);
        add('models', 'warn', `${credential.reason}: routes ${routes.join(', ') || '(none)'} are unavailable — never routed to, no request is sent`);
      }
      return {
        providerId: p.id,
        adapterInfo: { package: 'doctor', version: '0' },
        complete: () => Promise.reject(new HypertestError('unsupported', 'doctor stub')),
        availability: () => credential,
      };
    }),
  );
  const profiles: ModelCapabilityProfile[] = [];
  for (const route of config.models.routes) {
    // A[2]: every route has an explicit profile — report what is left to (conservative) defaults and unknown prices
    const { defaulted, costUnknown } = defaultedRouteFields(route);
    if (defaulted.length > 0) add('models', 'warn', `route ${route.routeId}: defaulted fields ${defaulted.join(', ')} (declare them; security fields default to maxDataClassification internal, maxActionRisk low)`);
    if (costUnknown) add('models', 'warn', `route ${route.routeId}: price unknown (no costPerMillionInputUsd/costPerMillionOutputUsd): runs or work items with a USD cost budget never route to it`);
    const p = config.models.providers.find((x) => x.id === route.provider)!;
    let tag = providerCompatibilityClass(p, route.model);
    if (p.kind === 'pi-ai') {
      try {
        const pi = new PiAiProvider({ providerId: p.id, piProvider: p.piProvider!, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}) });
        tag = piCompatibilityClass(await pi.resolveModel(route.model));
      } catch (e) {
        add('models', 'error', `route ${route.routeId}: ${(e as Error).message}`);
        tag = `pi-ai:?:${p.piProvider}:${route.model}`;
      }
    }
    profiles.push(completeRoute(route, tag!));
  }
  let roles: RoleCatalog;
  let catalog: ModelCatalog;
  try {
    catalog = new ModelCatalog(profiles);
    roles = new RoleCatalog(BUILTIN_ROLES, { roles: roleOverrides(config) });
  } catch (e) {
    add('models', 'error', (e as Error).message);
    return;
  }
  const router = createModelRouter({ ids: new SequentialIdGenerator(), clock: new FixedClock(), logger: noopLogger, catalog, providers });
  const route = (role: RoleDefinition) =>
    router.route(
      {
        runId: 'doctor', agentId: 'doctor', role: role.role, taskType: role.taskType, policy: role.defaultModelPolicy, requiredCapabilities: [], actionRisk: 'low',
        dataClassification: role.dataClassification, contextTokensEstimate: 1, contextSnapshotId: 'doctor',
      },
      { runId: 'doctor', correlationId: 'doctor', actorId: 'system:doctor' },
    );
  const unroutable: string[] = [];
  // the core roles; the specialist roles (vision_gui, local_private) need special routes and are reported below
  for (const role of roles.list().filter((r) => !SPECIALIST_ROLES.includes(r.role))) {
    const decision = await route(role);
    if (decision.ok) continue;
    const why = decision.rejected.map((r) => `${r.routeId}: ${r.reason}`).join('; ');
    if (role.role === 'lead') add('models', 'error', `no route can serve the lead role (${why}): every run would fail at routing`);
    else unroutable.push(`${role.role} (${why})`);
  }
  if (unroutable.length > 0) add('models', 'warn', `roles without an eligible route (their work items fail at routing): ${unroutable.join('; ')}`);
  else add('models', 'ok', `${config.models.routes.length} route(s); every core role can be routed`);
  await checkSpecialistRoutes(config, catalog.list(), roles, route, add);
}

/** Where a provider runs, for the restricted-data check: this host, a private network, or somewhere else. */
export function providerLocality(p: Pick<ProviderConfig, 'kind' | 'baseUrl'>): { local: boolean; where: string } {
  if (p.kind === 'scripted') return { local: true, where: 'in process (scripted)' };
  if (p.kind === 'anthropic' && !p.baseUrl) return { local: false, where: 'the hosted Anthropic API' };
  if (!p.baseUrl) return { local: false, where: `the provider's hosted default endpoint (${p.kind})` };
  let host: string;
  try {
    host = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return { local: false, where: `an unparsable endpoint ${JSON.stringify(p.baseUrl)}` };
  }
  if (isLoopbackHost(host) || host === 'localhost' || host === '::1') return { local: true, where: `this host (${host})` };
  const privateV4 = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host);
  const privateV6 = /^f[cd][0-9a-f]{2}:/.test(host);
  if (privateV4 || privateV6 || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.svc.cluster.local')) return { local: true, where: `a private network address (${host})` };
  return { local: false, where: `${host}, which is neither this host nor a private network` };
}

/**
 * Route coverage of the specialist roles: `vision_gui` needs a route with the vision capability (the computer-use
 * capability is reported as the optional fallback), `local_private` a route accepting restricted data — and every route
 * that accepts restricted data should be a local (or private-network) model, or restricted data leaves the deployment.
 */
async function checkSpecialistRoutes(
  config: HypertestConfig,
  profiles: readonly ModelCapabilityProfile[],
  roles: RoleCatalog,
  route: (role: RoleDefinition) => ReturnType<ReturnType<typeof createModelRouter>['route']>,
  add: Add,
): Promise<void> {
  const enabled = profiles.filter((p) => p.enabled);
  const gui = roles.get('vision_gui');
  if (gui) {
    const decision = await route(gui);
    const cu = enabled.filter((p) => p.capabilities.includes('computer_use') && p.capabilities.includes('vision')).map((p) => p.routeId);
    if (decision.ok) {
      add('models', 'ok', `vision_gui: routed to ${decision.routeId} (vision); computer-use fallback ${cu.length > 0 ? `routes: ${cu.join(', ')}` : 'unavailable (no route with computer_use): DOM, API and screenshot checks only'}`);
    } else {
      const why = decision.rejected.map((r) => `${r.routeId}: ${r.reason}`).join('; ');
      add('models', 'warn', `vision_gui: no route can serve GUI testing (${why}): GUI work items fail at routing — add a route with capabilities [tool_use, structured_output, vision]`);
    }
  }
  const priv = roles.get('local_private');
  if (priv) {
    const decision = await route(priv);
    const restricted = enabled.filter((p) => p.maxDataClassification === 'restricted');
    if (!decision.ok) {
      const why = decision.rejected.map((r) => `${r.routeId}: ${r.reason}`).join('; ');
      add('models', 'warn', `local_private: no route can take restricted data (${why}): restricted work fails closed at routing and is never sent to another model — add a local route with maxDataClassification: restricted`);
    } else {
      add('models', 'ok', `local_private: restricted data is routed only to routes accepting it (${restricted.map((p) => p.routeId).join(', ')}); selected ${decision.routeId}`);
    }
    for (const p of restricted) {
      const provider = config.models.providers.find((x) => x.id === p.provider);
      if (!provider) continue;
      const where = providerLocality(provider);
      if (!where.local) add('models', 'warn', `route ${p.routeId} accepts restricted data but its provider ${provider.id} runs at ${where.where}: restricted data (local_private work) would leave this deployment — lower its maxDataClassification or point it at a local model`);
    }
  }
}

/** Read-only check: the directory (or, when it does not exist yet, its nearest existing ancestor) is writable. */
async function writable(add: Add, name: string, dir: string, what: string): Promise<void> {
  let probe = dir;
  for (;;) {
    try {
      await access(probe, constants.F_OK);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    await access(probe, constants.W_OK);
    add(name, 'ok', probe === dir ? `${what} ${dir} is writable` : `${what} ${dir} can be created (${probe} is writable)`);
  } catch (e) {
    add(name, 'error', `${what} ${dir} is not writable: ${(e as Error).message}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HypertestError('timeout', `${what}: no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function hostPort(address: string, defaultPort: number): { host: string; port: number } {
  const u = new URL(/^[a-z]+:\/\//i.test(address) ? address : `tcp://${address}`);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : defaultPort };
}

async function tcp(add: Add, name: string, address: string, defaultPort: number, timeoutMs: number, what: string): Promise<void> {
  let target: { host: string; port: number };
  try {
    target = hostPort(address, defaultPort);
  } catch {
    add(name, 'error', `${what} address ${address} is invalid`);
    return;
  }
  const ok = await new Promise<string | undefined>((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => finish(`no connection within ${timeoutMs} ms`), timeoutMs);
    function finish(error?: string) {
      clearTimeout(timer);
      socket.destroy();
      resolve(error);
    }
    socket.once('connect', () => finish());
    socket.once('error', (e) => finish(e.message));
  });
  if (ok === undefined) add(name, 'ok', `${what} ${target.host}:${target.port} is reachable`);
  else add(name, 'error', `${what} ${target.host}:${target.port} is not reachable: ${ok}`);
}

async function http(add: Add, name: string, url: string, timeoutMs: number, what: string, requireOk: boolean): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    await res.body?.cancel();
    if (requireOk && !res.ok) add(name, 'error', `${what} ${url} answered HTTP ${res.status}`);
    else add(name, 'ok', `${what} ${url} is reachable (HTTP ${res.status})`);
  } catch (e) {
    add(name, 'error', `${what} ${url} is not reachable: ${(e as Error).message}`);
  }
}
