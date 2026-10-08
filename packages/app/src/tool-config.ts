import { HypertestError, type Logger } from '@hypertest/core';
import { BUILTIN_ROLES, WORKSPACE_WRITE_TOOL_IDS, toolPermitted } from '@hypertest/agents';
import type { RoleOverrides } from '@hypertest/agents';
import { PERMISSION_PROFILES } from '@hypertest/policy';
import {
  DEFAULT_MCP_GRANT, delegableTool, fakeComputerBackend, mcpToolId, remoteToolSpec, sanitizeMcpSegment, x11Backend, xdotoolBackend, type AcpAgentConfig, type ComputerBackend, type ComputerToolsOptions,
  type McpServerConfig, type RemoteToolTarget, type ToolSpec,
} from '@hypertest/tools';
import type { HypertestConfig, McpServerToolConfig } from './contracts.ts';
import type { IsolationDecision, IsolationTierResolver } from '@hypertest/tools';

/**
 * Configuration of the tool surface beyond the built-in tools (wave 3, unit tool-surface): MCP servers (`tools.mcpServers`).
 * Validation lives here (called by validateConfig) and the composition turns the validated configuration into tool
 * options, role tool-policy additions and operator scope grants. Secrets never appear in the configuration: an MCP server
 * receives variables and headers only by NAME (`envFrom`, `headersFromEnv`) — resolved at composition from the process
 * environment; a missing variable makes that server unavailable (fail closed: nothing is spawned or sent), never a
 * silently unauthenticated one.
 */

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const EFFECTS = ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'] as const;
const RISKS = ['low', 'medium', 'high', 'critical'] as const;
/** Default roles offered a configured MCP server's tools (`mcp.<id>.*`). */
export const DEFAULT_MCP_ROLES: readonly string[] = Object.freeze(['executor']);

const MCP_KEYS = [
  'id', 'command', 'args', 'cwd', 'envFrom', 'url', 'headersFromEnv', 'allowTools', 'effect', 'riskClass', 'toolEffects', 'environmentId', 'environmentClass', 'roles', 'grantTo', 'timeoutMs',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function nameMap(errors: string[], at: string, v: unknown, keyRe: RegExp, keyWhat: string): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) {
    errors.push(`${at} must be a mapping of ${keyWhat} → NAME of an environment variable`);
    return;
  }
  for (const [k, name] of Object.entries(v)) {
    if (!keyRe.test(k)) errors.push(`${at}: ${JSON.stringify(k)} is not a valid ${keyWhat}`);
    if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) errors.push(`${at}.${k} must name an environment variable ([A-Za-z_][A-Za-z0-9_]*): values are never configured inline`);
  }
}

/** Problems of `tools.mcpServers` (empty: valid). `environments`: the configured environments (environmentId references). */
export function mcpServerProblems(servers: unknown, environments: unknown): string[] {
  const errors: string[] = [];
  if (servers === undefined) return errors;
  if (!Array.isArray(servers)) return ['tools.mcpServers must be a list'];
  const envIds = new Set(Array.isArray(environments) ? environments.filter(isPlainObject).map((e) => e['environmentId']).filter((x): x is string => typeof x === 'string') : []);
  const roles = new Set(BUILTIN_ROLES.map((r) => r.role as string));
  const profiles = new Set(Object.keys(PERMISSION_PROFILES));
  const ids = new Set<string>();
  servers.forEach((s: unknown, i) => {
    const at = `tools.mcpServers[${i}]`;
    if (!isPlainObject(s)) {
      errors.push(`${at} must be a mapping`);
      return;
    }
    for (const k of Object.keys(s)) {
      if (k === 'env') errors.push(`${at}.env: inline environment values are not allowed (secrets never live in the configuration); use envFrom: { SERVER_VAR: NAME_OF_HYPERTEST_VAR }`);
      else if (k === 'headers') errors.push(`${at}.headers: inline header values are not allowed; use headersFromEnv: { header-name: NAME_OF_VARIABLE }`);
      else if (!(MCP_KEYS as readonly string[]).includes(k)) errors.push(`${at}: unknown key '${k}' (expected one of ${MCP_KEYS.join(', ')})`);
    }
    if (typeof s['id'] !== 'string' || !MCP_ID_RE.test(s['id'])) errors.push(`${at}.id must match ${MCP_ID_RE.source} (it becomes the tool id segment mcp.<id>.<tool>)`);
    else {
      if (ids.has(s['id'])) errors.push(`${at}.id: duplicate MCP server '${s['id']}'`);
      ids.add(s['id']);
    }
    const hasCommand = s['command'] !== undefined;
    const hasUrl = s['url'] !== undefined;
    if (hasCommand === hasUrl) errors.push(`${at} needs exactly one of command (stdio) and url (streamable HTTP)`);
    if (hasCommand && !nonEmpty(s['command'])) errors.push(`${at}.command must be a non-empty string`);
    if (hasUrl) {
      let ok = false;
      try {
        const u = new URL(String(s['url']));
        ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
      } catch {
        ok = false;
      }
      if (!ok) errors.push(`${at}.url must be an absolute http(s) URL without credentials`);
    }
    if (s['args'] !== undefined && !(Array.isArray(s['args']) && s['args'].every((a) => typeof a === 'string'))) errors.push(`${at}.args must be a list of strings`);
    if (s['cwd'] !== undefined && !nonEmpty(s['cwd'])) errors.push(`${at}.cwd must be a non-empty string`);
    if (hasUrl && (s['args'] !== undefined || s['cwd'] !== undefined || s['envFrom'] !== undefined)) errors.push(`${at}: args, cwd and envFrom apply to stdio servers (command) only`);
    if (hasCommand && s['headersFromEnv'] !== undefined) errors.push(`${at}.headersFromEnv applies to HTTP servers (url) only`);
    nameMap(errors, `${at}.envFrom`, s['envFrom'], ENV_NAME_RE, 'server variable name');
    nameMap(errors, `${at}.headersFromEnv`, s['headersFromEnv'], HEADER_RE, 'header name');
    const allow = s['allowTools'];
    if (!Array.isArray(allow) || allow.length === 0 || !allow.every(nonEmpty)) {
      errors.push(`${at}.allowTools must be a non-empty list of MCP tool names (the tool catalog is pinned by the runtime manifest: I11)`);
    } else {
      const toolIds = new Map<string, string>();
      for (const t of allow as string[]) {
        const id = typeof s['id'] === 'string' ? mcpToolId(s['id'], t) : t;
        if (toolIds.has(id)) errors.push(`${at}.allowTools: ${JSON.stringify(t)} and ${JSON.stringify(toolIds.get(id))} map to the same tool id ${id}`);
        toolIds.set(id, t);
      }
    }
    if (s['effect'] !== undefined && !(EFFECTS as readonly unknown[]).includes(s['effect'])) errors.push(`${at}.effect must be one of ${EFFECTS.join(', ')}`);
    if (s['riskClass'] !== undefined && !(RISKS as readonly unknown[]).includes(s['riskClass'])) errors.push(`${at}.riskClass must be one of ${RISKS.join(', ')}`);
    const te = s['toolEffects'];
    if (te !== undefined) {
      if (!isPlainObject(te)) errors.push(`${at}.toolEffects must be a mapping of MCP tool name → { effect, riskClass }`);
      else {
        for (const [name, c] of Object.entries(te)) {
          if (Array.isArray(allow) && !allow.includes(name)) errors.push(`${at}.toolEffects.${name}: not in allowTools`);
          if (!isPlainObject(c)) {
            errors.push(`${at}.toolEffects.${name} must be a mapping { effect, riskClass }`);
            continue;
          }
          for (const k of Object.keys(c)) if (k !== 'effect' && k !== 'riskClass') errors.push(`${at}.toolEffects.${name}: unknown key '${k}'`);
          if (c['effect'] !== undefined && !(EFFECTS as readonly unknown[]).includes(c['effect'])) errors.push(`${at}.toolEffects.${name}.effect must be one of ${EFFECTS.join(', ')}`);
          if (c['riskClass'] !== undefined && !(RISKS as readonly unknown[]).includes(c['riskClass'])) errors.push(`${at}.toolEffects.${name}.riskClass must be one of ${RISKS.join(', ')}`);
        }
      }
    }
    if (s['environmentId'] !== undefined) {
      if (!nonEmpty(s['environmentId'])) errors.push(`${at}.environmentId must be a non-empty string`);
      else if (!envIds.has(s['environmentId'])) errors.push(`${at}.environmentId: environment '${s['environmentId']}' is not configured under environments`);
      if (s['environmentClass'] !== undefined) errors.push(`${at}: environmentClass comes from the environment when environmentId is set`);
      if (s['grantTo'] !== undefined) errors.push(`${at}.grantTo applies to servers not bound to an environment (an environment-bound server is covered by env/** grants)`);
    }
    if (s['environmentClass'] !== undefined && !nonEmpty(s['environmentClass'])) errors.push(`${at}.environmentClass must be a non-empty string`);
    for (const [k, known, what] of [['roles', roles, 'role'], ['grantTo', profiles, 'permission profile']] as const) {
      const v = s[k];
      if (v === undefined) continue;
      if (!Array.isArray(v) || !v.every(nonEmpty)) errors.push(`${at}.${k} must be a list of ${what} names`);
      else for (const x of v as string[]) if (!known.has(x)) errors.push(`${at}.${k}: unknown ${what} '${x}'`);
    }
    if (s['timeoutMs'] !== undefined && !(Number.isInteger(s['timeoutMs']) && (s['timeoutMs'] as number) >= 1 && (s['timeoutMs'] as number) <= 600_000)) errors.push(`${at}.timeoutMs must be an integer in [1, 600000]`);
  });
  return errors;
}

/**
 * The MCP bridge configuration of the validated `tools.mcpServers`: `envFrom` / `headersFromEnv` resolved from `env` (a
 * missing variable makes that server unavailable with the exact reason — logged by name, never by value).
 */
export function mcpServerConfigs(config: Pick<HypertestConfig, 'tools'>, env: Record<string, string | undefined>, logger: Logger): McpServerConfig[] {
  return (config.tools?.mcpServers ?? []).map((s: McpServerToolConfig) => {
    const missing: string[] = [];
    const resolve = (map: Record<string, string> | undefined): Record<string, string> | undefined => {
      if (!map) return undefined;
      const out: Record<string, string> = {};
      for (const [k, name] of Object.entries(map)) {
        const value = env[name];
        if (value === undefined || value === '') missing.push(name);
        else out[k] = value;
      }
      return out;
    };
    const c: McpServerConfig = { name: s.id, allowTools: [...s.allowTools] };
    if (s.command !== undefined) c.command = s.command;
    if (s.args) c.args = [...s.args];
    if (s.cwd) c.cwd = s.cwd;
    const envOut = resolve(s.envFrom);
    if (envOut) c.env = envOut;
    if (s.url !== undefined) c.url = s.url;
    const headers = resolve(s.headersFromEnv);
    if (headers) c.headers = headers;
    if (s.effect) c.effect = s.effect;
    if (s.riskClass) c.riskClass = s.riskClass;
    if (s.toolEffects) c.toolEffects = JSON.parse(JSON.stringify(s.toolEffects)) as NonNullable<McpServerConfig['toolEffects']>;
    if (s.environmentId) c.environmentId = s.environmentId;
    if (s.environmentClass) c.environmentClass = s.environmentClass;
    if (s.grantTo) c.grantTo = [...s.grantTo];
    if (s.timeoutMs !== undefined) c.timeoutMs = s.timeoutMs;
    if (missing.length > 0) {
      c.unavailableReason = `the variable(s) ${[...new Set(missing)].join(', ')} it is configured with (envFrom / headersFromEnv) are not set`;
      logger.warn('MCP server is unavailable until its variables are set (fail closed: it is not started)', { server: s.id, missing: [...new Set(missing)] });
    }
    return c;
  });
}

/**
 * Role overrides with the configured tools added to the tool policy of the roles they are offered to (MCP servers:
 * `mcp.<id>.*` for `roles`, default executor). The configured `roles.<role>.toolPolicy.allow` (or the built-in allowlist)
 * is extended, never replaced; a role's deny list still wins.
 */
export function withToolRoleGrants(config: Pick<HypertestConfig, 'tools'>, overrides: NonNullable<RoleOverrides['roles']>): NonNullable<RoleOverrides['roles']> {
  const add = new Map<string, string[]>();
  for (const s of config.tools?.mcpServers ?? []) {
    for (const role of s.roles ?? DEFAULT_MCP_ROLES) add.set(role, [...(add.get(role) ?? []), `mcp.${sanitizeMcpSegment(s.id)}.*`]);
  }
  for (const a of config.tools?.acpAgents ?? []) {
    for (const role of a.roles ?? DEFAULT_ACP_ROLES) add.set(role, [...(add.get(role) ?? []), `acp.${a.id}.*`]);
  }
  if (config.tools?.computerUse) {
    for (const role of config.tools.computerUse.roles ?? DEFAULT_COMPUTER_ROLES) add.set(role, [...(add.get(role) ?? []), 'computer.*']);
  }
  if (add.size === 0) return overrides;
  const out: Record<string, Record<string, unknown>> = { ...(overrides as Record<string, Record<string, unknown>>) };
  for (const [role, patterns] of add) {
    const own = out[role] ?? {};
    const ownPolicy = (own['toolPolicy'] ?? {}) as { allow?: string[]; deny?: string[] };
    const base = ownPolicy.allow ?? BUILTIN_ROLES.find((r) => r.role === role)?.toolPolicy.allow ?? [];
    out[role] = { ...own, toolPolicy: { ...ownPolicy, allow: [...new Set([...base, ...patterns])] } };
  }
  return out as NonNullable<RoleOverrides['roles']>;
}

export { DEFAULT_MCP_GRANT };

/**
 * (wave 3) Problems of the tool-surface keys of one configured environment (`environments[i]`): `grpc` (grpc.* tools),
 * `logs` (logs.query files), `traces` (trace.query backend), `database` (db.introspect, read-only; its connection by
 * variable NAME only) and `control.context` (kubectl context).
 */
export function environmentToolProblems(e: Record<string, unknown>, at: string): string[] {
  const errors: string[] = [];
  const grpc = e['grpc'];
  if (grpc !== undefined) {
    if (!isPlainObject(grpc)) errors.push(`${at}.grpc must be a mapping`);
    else {
      for (const k of Object.keys(grpc)) if (!['target', 'protoFiles', 'includeDirs', 'reflection', 'tls', 'readMethods'].includes(k)) errors.push(`${at}.grpc: unknown key '${k}'`);
      if (typeof grpc['target'] !== 'string' || !/^[A-Za-z0-9.[\]:_-]+:\d{1,5}$/.test(grpc['target'])) errors.push(`${at}.grpc.target must be host:port`);
      for (const k of ['protoFiles', 'includeDirs', 'readMethods']) if (grpc[k] !== undefined && !(Array.isArray(grpc[k]) && (grpc[k] as unknown[]).every(nonEmpty))) errors.push(`${at}.grpc.${k} must be a list of non-empty strings`);
      for (const k of ['reflection', 'tls']) if (grpc[k] !== undefined && typeof grpc[k] !== 'boolean') errors.push(`${at}.grpc.${k} must be a boolean`);
      const hasProto = Array.isArray(grpc['protoFiles']) && grpc['protoFiles'].length > 0;
      if (hasProto === (grpc['reflection'] === true)) errors.push(`${at}.grpc needs exactly one definition source: protoFiles or reflection: true`);
      for (const m of Array.isArray(grpc['readMethods']) ? grpc['readMethods'] : []) {
        if (typeof m === 'string' && m !== '*' && !/^[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z0-9_]*\*?$/.test(m)) errors.push(`${at}.grpc.readMethods: ${JSON.stringify(m)} is not package.Service/Method (a trailing * globs)`);
      }
    }
  }
  const logs = e['logs'];
  if (logs !== undefined) {
    if (!isPlainObject(logs)) errors.push(`${at}.logs must be a mapping`);
    else {
      for (const k of Object.keys(logs)) if (k !== 'files') errors.push(`${at}.logs: unknown key '${k}'`);
      const files = logs['files'];
      if (files !== undefined && !(Array.isArray(files) && files.every((f) => typeof f === 'string' && f.startsWith('/')))) errors.push(`${at}.logs.files must be a list of absolute paths`);
    }
  }
  const traces = e['traces'];
  if (traces !== undefined) {
    if (!isPlainObject(traces)) errors.push(`${at}.traces must be a mapping`);
    else {
      for (const k of Object.keys(traces)) if (!['kind', 'url', 'path', 'service'].includes(k)) errors.push(`${at}.traces: unknown key '${k}'`);
      if (!['otlp_file', 'jaeger', 'tempo'].includes(String(traces['kind']))) errors.push(`${at}.traces.kind must be one of otlp_file, jaeger, tempo`);
      if (traces['kind'] === 'otlp_file' && !(typeof traces['path'] === 'string' && traces['path'].startsWith('/'))) errors.push(`${at}.traces.path (absolute) is required for kind otlp_file`);
      if ((traces['kind'] === 'jaeger' || traces['kind'] === 'tempo')) {
        let ok = false;
        try {
          const u = new URL(String(traces['url']));
          ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
        } catch {
          ok = false;
        }
        if (!ok) errors.push(`${at}.traces.url (http(s), no credentials) is required for kind ${String(traces['kind'])}`);
      }
      if (traces['service'] !== undefined && !nonEmpty(traces['service'])) errors.push(`${at}.traces.service must be a non-empty string`);
    }
  }
  const db = e['database'];
  if (db !== undefined) {
    if (!isPlainObject(db)) errors.push(`${at}.database must be a mapping`);
    else {
      for (const k of Object.keys(db)) {
        if (k === 'url' || k === 'password') errors.push(`${at}.database.${k}: inline connection strings are not allowed; set urlEnv to the NAME of the variable holding it`);
        else if (!['kind', 'urlEnv', 'path', 'schemas'].includes(k)) errors.push(`${at}.database: unknown key '${k}'`);
      }
      if (!['postgres', 'sqlite', 'mysql'].includes(String(db['kind']))) errors.push(`${at}.database.kind must be one of postgres, sqlite, mysql`);
      if (db['kind'] === 'sqlite' && !(typeof db['path'] === 'string' && db['path'].startsWith('/'))) errors.push(`${at}.database.path (absolute) is required for kind sqlite`);
      if ((db['kind'] === 'postgres' || db['kind'] === 'mysql') && !(typeof db['urlEnv'] === 'string' && ENV_NAME_RE.test(db['urlEnv']))) errors.push(`${at}.database.urlEnv (the NAME of the variable holding the connection URL) is required for kind ${String(db['kind'])}`);
      if (db['schemas'] !== undefined && !(Array.isArray(db['schemas']) && db['schemas'].every((x) => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(x)))) errors.push(`${at}.database.schemas must be a list of schema names`);
    }
  }
  const control = e['control'];
  if (isPlainObject(control) && control['context'] !== undefined) {
    if (!(typeof control['context'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@:/-]*$/.test(control['context']))) errors.push(`${at}.control.context must be a kubectl context name`);
    if (control['kind'] !== 'kubectl') errors.push(`${at}.control.context is only valid for kind kubectl`);
  }
  return errors;
}

const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TOOL_ID_RE = /^[a-z][a-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;

/** Problems of `tools.remoteWorkers` (structure; the composition checks the tools exist and are delegable). */
export function remoteWorkerProblems(workers: unknown): string[] {
  const errors: string[] = [];
  if (workers === undefined) return errors;
  if (!Array.isArray(workers)) return ['tools.remoteWorkers must be a list'];
  const ids = new Set<string>();
  const delegated = new Map<string, string>();
  workers.forEach((w: unknown, i) => {
    const at = `tools.remoteWorkers[${i}]`;
    if (!isPlainObject(w)) {
      errors.push(`${at} must be a mapping`);
      return;
    }
    for (const k of Object.keys(w)) {
      if (k === 'secret' || k === 'token') errors.push(`${at}.${k}: inline secrets are not allowed; set secretEnv to the NAME of the variable holding the shared secret`);
      else if (!['id', 'url', 'secretEnv', 'tools'].includes(k)) errors.push(`${at}: unknown key '${k}' (expected one of id, url, secretEnv, tools)`);
    }
    if (typeof w['id'] !== 'string' || !WORKER_ID_RE.test(w['id'])) errors.push(`${at}.id must match ${WORKER_ID_RE.source}`);
    else {
      if (ids.has(w['id'])) errors.push(`${at}.id: duplicate remote worker '${w['id']}'`);
      ids.add(w['id']);
    }
    let ok = false;
    try {
      const u = new URL(String(w['url']));
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '';
    } catch {
      ok = false;
    }
    if (!ok) errors.push(`${at}.url must be an absolute http(s) URL without credentials`);
    if (typeof w['secretEnv'] !== 'string' || !ENV_NAME_RE.test(w['secretEnv'])) errors.push(`${at}.secretEnv must name the environment variable holding the shared secret`);
    const tools = w['tools'];
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === 'string' && TOOL_ID_RE.test(t))) errors.push(`${at}.tools must be a non-empty list of tool ids`);
    else {
      for (const t of tools as string[]) {
        const other = delegated.get(t);
        if (other !== undefined) errors.push(`${at}.tools: ${t} is already delegated to remote worker ${other}`);
        delegated.set(t, String(w['id']));
      }
    }
  });
  return errors;
}

/**
 * The tool catalog with the delegated tools replaced by their remote specs (the local classification, the execute step
 * on the remote worker). A delegated tool that does not exist or has a side-effect binding fails the composition; a worker
 * whose secret variable is not set is unavailable (its tools fail closed; logged by name).
 */
export function withRemoteWorkers(specs: ToolSpec[], config: Pick<HypertestConfig, 'tools'>, env: Record<string, string | undefined>, logger: Logger, fetchImpl?: typeof fetch): ToolSpec[] {
  const workers = config.tools?.remoteWorkers ?? [];
  if (workers.length === 0) return specs;
  const byId = new Map(specs.map((s) => [s.id, s]));
  for (const w of workers) {
    const secret = env[w.secretEnv];
    const target: RemoteToolTarget = { workerId: w.id, url: w.url, secret: secret && secret.length >= 16 ? secret : undefined };
    if (target.secret === undefined) {
      target.unavailableReason = secret ? `the shared secret in ${w.secretEnv} is shorter than 16 characters` : `${w.secretEnv} is not set`;
      logger.warn('remote tool worker is unavailable until its shared secret is set (its tools fail closed)', { worker: w.id, secretEnv: w.secretEnv });
    }
    if (fetchImpl) target.fetch = fetchImpl;
    for (const id of w.tools) {
      const local = byId.get(id);
      if (!local) throw new HypertestError('invalid_argument', `tools.remoteWorkers (${w.id}): tool ${id} is not in the tool catalog`);
      if (!delegableTool(local)) throw new HypertestError('invalid_argument', `tools.remoteWorkers (${w.id}): tool ${id} has a side-effect binding (its adapter runs here) and cannot be delegated`);
      byId.set(id, remoteToolSpec(local, target));
    }
  }
  return specs.map((s) => byId.get(s.id)!);
}

/** Default roles offered a configured ACP agent (`acp.<id>.prompt`): the test designer (an isolated worktree). */
export const DEFAULT_ACP_ROLES: readonly string[] = Object.freeze(['test_designer']);

/** Problems of `tools.acpAgents`. */
export function acpAgentProblems(agents: unknown): string[] {
  const errors: string[] = [];
  if (agents === undefined) return errors;
  if (!Array.isArray(agents)) return ['tools.acpAgents must be a list'];
  const roles = new Set(BUILTIN_ROLES.map((r) => r.role as string));
  const ids = new Set<string>();
  agents.forEach((a: unknown, i) => {
    const at = `tools.acpAgents[${i}]`;
    if (!isPlainObject(a)) {
      errors.push(`${at} must be a mapping`);
      return;
    }
    for (const k of Object.keys(a)) {
      if (k === 'env') errors.push(`${at}.env: inline environment values are not allowed; use envFrom: { AGENT_VAR: NAME_OF_HYPERTEST_VAR }`);
      else if (!['id', 'command', 'args', 'envFrom', 'sandbox', 'roles', 'timeoutMs'].includes(k)) errors.push(`${at}: unknown key '${k}' (expected one of id, command, args, envFrom, sandbox, roles, timeoutMs)`);
    }
    if (typeof a['id'] !== 'string' || !MCP_ID_RE.test(a['id'])) errors.push(`${at}.id must match ${MCP_ID_RE.source} (it becomes the tool id acp.<id>.prompt)`);
    else {
      if (ids.has(a['id'])) errors.push(`${at}.id: duplicate ACP agent '${a['id']}'`);
      ids.add(a['id']);
    }
    if (!nonEmpty(a['command'])) errors.push(`${at}.command must be a non-empty string`);
    if (a['args'] !== undefined && !(Array.isArray(a['args']) && a['args'].every((x) => typeof x === 'string'))) errors.push(`${at}.args must be a list of strings`);
    nameMap(errors, `${at}.envFrom`, a['envFrom'], ENV_NAME_RE, 'agent variable name');
    if (a['sandbox'] !== undefined && a['sandbox'] !== 'workspace' && a['sandbox'] !== 'host') errors.push(`${at}.sandbox must be workspace (default: the caller's workspace sandbox) or host (explicit opt-out)`);
    const r = a['roles'];
    if (r !== undefined) {
      if (!Array.isArray(r) || !r.every(nonEmpty)) errors.push(`${at}.roles must be a list of role names`);
      else for (const x of r as string[]) if (!roles.has(x)) errors.push(`${at}.roles: unknown role '${x}'`);
    }
    if (a['timeoutMs'] !== undefined && !(Number.isInteger(a['timeoutMs']) && (a['timeoutMs'] as number) >= 1000 && (a['timeoutMs'] as number) <= 3_600_000)) errors.push(`${at}.timeoutMs must be an integer in [1000, 3600000]`);
  });
  return errors;
}

/** The ACP agent configuration of the validated `tools.acpAgents` (`envFrom` resolved; a missing variable ⇒ unavailable). */
export function acpAgentConfigs(config: Pick<HypertestConfig, 'tools'>, env: Record<string, string | undefined>, logger: Logger): AcpAgentConfig[] {
  return (config.tools?.acpAgents ?? []).map((a) => {
    const c: AcpAgentConfig = { id: a.id, command: a.command };
    if (a.args) c.args = [...a.args];
    if (a.sandbox) c.sandbox = a.sandbox;
    if (a.timeoutMs !== undefined) c.timeoutMs = a.timeoutMs;
    const missing: string[] = [];
    if (a.envFrom) {
      const out: Record<string, string> = {};
      for (const [k, name] of Object.entries(a.envFrom)) {
        const v = env[name];
        if (v === undefined || v === '') missing.push(name);
        else out[k] = v;
      }
      c.env = out;
    }
    if (missing.length > 0) {
      c.unavailableReason = `the variable(s) ${[...new Set(missing)].join(', ')} it is configured with (envFrom) are not set`;
      logger.warn('ACP agent is unavailable until its variables are set (fail closed: it is not started)', { agent: a.id, missing: [...new Set(missing)] });
    }
    if (a.sandbox === 'host') logger.warn('ACP agent runs as a plain host process (sandbox: host): it is NOT confined to the workspace sandbox', { agent: a.id });
    return c;
  });
}

/** Default roles offered computer use (`computer.*`): the vision/GUI tester (computer use is its last resort). */
export const DEFAULT_COMPUTER_ROLES: readonly string[] = Object.freeze(['vision_gui']);

/** Problems of `tools.computerUse`. */
export function computerUseProblems(cu: unknown): string[] {
  const errors: string[] = [];
  if (cu === undefined) return errors;
  const at = 'tools.computerUse';
  if (!isPlainObject(cu)) return [`${at} must be a mapping`];
  for (const k of Object.keys(cu)) if (!['backend', 'display', 'displayId', 'environmentClass', 'grantTo', 'roles', 'xdotool', 'screenshotCommand'].includes(k)) errors.push(`${at}: unknown key '${k}'`);
  if (!['x11', 'xdotool', 'fake'].includes(String(cu['backend']))) errors.push(`${at}.backend must be one of x11, xdotool, fake`);
  if (cu['backend'] !== 'fake' && !(typeof cu['display'] === 'string' && /^(?:unix)?:\d+(?:\.\d+)?$/.test(cu['display']))) errors.push(`${at}.display (a local X display such as :99) is required for backend ${String(cu['backend'])}`);
  if (cu['displayId'] !== undefined && !(typeof cu['displayId'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(cu['displayId']))) errors.push(`${at}.displayId must be a resource segment ([A-Za-z0-9][A-Za-z0-9_.:-]*)`);
  if (cu['environmentClass'] !== undefined && !nonEmpty(cu['environmentClass'])) errors.push(`${at}.environmentClass must be a non-empty string`);
  const profiles = new Set(Object.keys(PERMISSION_PROFILES));
  const roles = new Set(BUILTIN_ROLES.map((r) => r.role as string));
  for (const [k, known, what] of [['grantTo', profiles, 'permission profile'], ['roles', roles, 'role']] as const) {
    const v = cu[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every(nonEmpty)) errors.push(`${at}.${k} must be a list of ${what} names`);
    else for (const x of v as string[]) if (!known.has(x)) errors.push(`${at}.${k}: unknown ${what} '${x}'`);
  }
  if (cu['xdotool'] !== undefined && (cu['backend'] !== 'xdotool' || !nonEmpty(cu['xdotool']))) errors.push(`${at}.xdotool (the xdotool binary) applies to backend xdotool`);
  if (cu['screenshotCommand'] !== undefined && (cu['backend'] !== 'xdotool' || !(Array.isArray(cu['screenshotCommand']) && cu['screenshotCommand'].length > 0 && cu['screenshotCommand'].every(nonEmpty)))) errors.push(`${at}.screenshotCommand (argv printing a PNG) applies to backend xdotool`);
  return errors;
}

/** The computer.* tool options of the validated `tools.computerUse` (undefined when not configured). */
export function computerUseOptions(config: Pick<HypertestConfig, 'tools'>, logger: Logger): ComputerToolsOptions | undefined {
  const cu = config.tools?.computerUse;
  if (!cu) return undefined;
  const display = cu.display ?? '';
  const backend: ComputerBackend =
    cu.backend === 'x11' ? x11Backend({ display })
      : cu.backend === 'xdotool' ? xdotoolBackend({ display, ...(cu.xdotool ? { xdotool: cu.xdotool } : {}), ...(cu.screenshotCommand ? { screenshotCommand: [...cu.screenshotCommand] } : {}) })
        : fakeComputerBackend();
  if (cu.backend === 'fake') logger.warn('tools.computerUse uses the FAKE desktop backend (a test backend: actions are recorded, nothing is clicked)', {});
  const displayId = cu.displayId ?? (cu.backend === 'fake' ? 'fake' : `display-${display.replace(/^(?:unix)?:/, '').replace(/\./g, '-')}`);
  return { backend, displayId, ...(cu.environmentClass ? { environmentClass: cu.environmentClass } : {}), ...(cu.grantTo ? { grantTo: [...cu.grantTo] } : {}) };
}

// ----------------------------------------------------------------------------- (wave 3, row 250) sandbox keys and isolation tiers

const SANDBOX_TIERS = ['read_only', 'isolated', 'separate'] as const;
const LOOPBACK_HOST_PORT = /^(?:https?:\/\/)?(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]):\d{1,5}\/?$/;

/**
 * Problems of the keys of one sandbox profile (the base `sandbox` or a `sandbox.roles.<role>` entry merged over it):
 * every accepted key is one the selected sandbox honours — `allowedHosts` only with network `egress_allowlist`, only on
 * the local sandbox and only loopback `host:port` endpoints (it relays loopback endpoints; plain docker has no per-host
 * egress filter, so the OCI sandbox refuses an allowlist instead of silently turning it into `--network none`).
 */
export function sandboxKeyProblems(profile: Record<string, unknown>, at: string): string[] {
  const errors: string[] = [];
  const hosts = profile['allowedHosts'];
  if (Array.isArray(hosts) && hosts.length > 0) {
    if (profile['network'] !== 'egress_allowlist') errors.push(`${at}.allowedHosts applies only to network 'egress_allowlist' (network is '${String(profile['network'] ?? 'loopback')}')`);
    if (profile['kind'] === 'oci') errors.push(`${at}.allowedHosts is not supported by the OCI sandbox (plain docker has no per-host egress filter): use the local sandbox for loopback endpoints, or network 'open' explicitly`);
    for (const h of hosts) if (typeof h !== 'string' || !LOOPBACK_HOST_PORT.test(h)) errors.push(`${at}.allowedHosts: ${JSON.stringify(h)} — the local sandbox relays only loopback endpoints given as host:port (127.0.0.1:8080, localhost:3000, [::1]:9000)`);
  }
  return errors;
}

/** Problems of `sandbox.roles` (tier per role; keys honoured like the base profile's). */
export function sandboxRoleProblems(sandbox: Record<string, unknown>): string[] {
  const roles = sandbox['roles'];
  if (roles === undefined) return [];
  if (!isPlainObject(roles)) return ['sandbox.roles must be a mapping of role name to { tier, … }'];
  const errors: string[] = [];
  for (const [role, raw] of Object.entries(roles)) {
    const at = `sandbox.roles.${role}`;
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be a mapping`);
      continue;
    }
    for (const k of Object.keys(raw)) if (!['tier', 'kind', 'image', 'network', 'allowedHosts', 'cpuLimit', 'memoryMb'].includes(k)) errors.push(`${at}: unknown key '${k}'`);
    if (!(SANDBOX_TIERS as readonly string[]).includes(String(raw['tier']))) errors.push(`${at}.tier must be one of ${SANDBOX_TIERS.join(', ')}`);
    if (raw['kind'] !== undefined && raw['kind'] !== 'local' && raw['kind'] !== 'oci') errors.push(`${at}.kind must be local or oci`);
    if (raw['network'] !== undefined && !['none', 'loopback', 'egress_allowlist', 'open'].includes(String(raw['network']))) errors.push(`${at}.network must be one of none, loopback, egress_allowlist, open`);
    if (raw['allowedHosts'] !== undefined && !(Array.isArray(raw['allowedHosts']) && raw['allowedHosts'].every(nonEmpty))) errors.push(`${at}.allowedHosts must be a list of strings`);
    for (const k of ['cpuLimit', 'memoryMb']) if (raw[k] !== undefined && !(typeof raw[k] === 'number' && (raw[k] as number) > 0)) errors.push(`${at}.${k} must be a positive number`);
    const merged: Record<string, unknown> = { ...sandbox, ...raw };
    if (clearsAllowedHosts(raw)) merged['allowedHosts'] = [];
    if (merged['kind'] === 'oci' && !nonEmpty(merged['image'])) errors.push(`${at}: kind oci needs an image (here or in sandbox.image)`);
    errors.push(...sandboxKeyProblems(merged, at));
    // a read-only tier for a role whose tools write its worktree would only make it fail: refused up front
    const def = BUILTIN_ROLES.find((r) => r.role === role);
    const writes = def ? WORKSPACE_WRITE_TOOL_IDS.filter((t) => toolPermitted(def.toolPolicy, t)) : [];
    if (raw['tier'] === 'read_only' && writes.length > 0) errors.push(`${at}.tier read_only: role ${role} writes its worktree (${writes.join(', ')}) — those tools would all be refused`);
  }
  return errors;
}

/** A tier that switches to another network mode or to the OCI sandbox (without its own allowlist) drops the base allowedHosts. */
function clearsAllowedHosts(t: Record<string, unknown>): boolean {
  return t['allowedHosts'] === undefined && ((t['network'] !== undefined && t['network'] !== 'egress_allowlist') || t['kind'] === 'oci');
}

/** The tier configuration of a role (`sandbox.roles.<role>`), as an IsolationDecision. */
function roleDecision(config: HypertestConfig, role: string): IsolationDecision | undefined {
  const t = config.sandbox?.roles?.[role];
  if (!t) return undefined;
  const { tier, ...keys } = t;
  const sandbox: NonNullable<IsolationDecision['sandbox']> = {};
  for (const [k, v] of Object.entries(keys)) if (v !== undefined) (sandbox as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
  if (clearsAllowedHosts(t as unknown as Record<string, unknown>)) sandbox.allowedHosts = [];
  return { tier, ...(Object.keys(sandbox).length > 0 ? { sandbox } : {}), ...(tier === 'read_only' ? { readOnly: true } : {}), reason: `sandbox.roles.${role}` };
}

/**
 * (wave 3, row 250) The isolation tier of a call: the role's configured tier (`sandbox.roles`), made stricter by its work
 * item — a work item whose capability requirements grant no `write_workspace` effect runs its commands read-only (the
 * planner narrowed it: its commands must not change the workspace either), and one whose requirements name no
 * environment / URL scope runs them without egress (network none). Work items are read once per id (cached).
 */
export function isolationResolver(config: HypertestConfig, workItems: { getWorkItem(id: string): Promise<{ capabilityRequirements?: Array<{ effect: string; resourceScopes: string[] }> } | undefined> }): IsolationTierResolver {
  const cache = new Map<string, Promise<{ readOnly: boolean; noEgress: boolean }>>();
  const itemTier = (workItemId: string) => {
    let p = cache.get(workItemId);
    if (!p) {
      p = workItems.getWorkItem(workItemId).then(
        (item) => {
          const reqs = item?.capabilityRequirements ?? [];
          if (reqs.length === 0) return { readOnly: false, noEgress: false };
          return {
            readOnly: !reqs.some((r) => r.effect === 'write_workspace'),
            noEgress: !reqs.some((r) => r.resourceScopes.some((sc) => sc === '**' || sc.startsWith('env/') || sc.startsWith('url/'))),
          };
        },
        () => ({ readOnly: false, noEgress: false }),
      );
      // bounded: the oldest entries go first (a long-lived instance sees many work items)
      if (cache.size >= 10_000) cache.delete(cache.keys().next().value!);
      cache.set(workItemId, p);
    }
    return p;
  };
  return async (call) => {
    const role = roleDecision(config, call.role);
    const item = await itemTier(call.workItemId);
    if (!role && !item.readOnly && !item.noEgress) return undefined;
    const decision: IsolationDecision = role ? { ...role, ...(role.sandbox ? { sandbox: { ...role.sandbox } } : {}) } : { tier: 'isolated' };
    const reasons = role?.reason ? [role.reason] : [];
    if (item.readOnly && call.workspace.kind !== 'scratch') {
      decision.readOnly = true;
      decision.tier = 'read_only';
      reasons.push('work item capability grants no workspace writes');
    }
    if (item.noEgress) {
      decision.sandbox = { ...(decision.sandbox ?? {}), network: 'none' };
      delete decision.sandbox.allowedHosts;
      if (decision.tier === 'isolated') decision.tier = 'separate';
      reasons.push('work item capability names no environment');
    }
    decision.reason = reasons.join('; ');
    return decision;
  };
}
