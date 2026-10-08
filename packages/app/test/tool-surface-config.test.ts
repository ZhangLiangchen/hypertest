/**
 * Configuration of the tool surface (wave 3, unit tool-surface): every key the validation accepts for tools, MCP servers,
 * transports and sandbox tiers is honoured by the composition — and malformed values are refused with the exact path.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import { defaultConfig, validateConfig, type HypertestConfig } from '../src/index.ts';
import { acpAgentConfigs, computerUseOptions, isolationResolver, mcpServerConfigs, withRemoteWorkers, withToolRoleGrants } from '../src/tool-config.ts';

function withTools(tools: Record<string, unknown>): HypertestConfig {
  return { ...defaultConfig(), tools } as unknown as HypertestConfig;
}

describe('tools.urlEnvironmentClass (e2e[0])', () => {
  test('a non-empty class name is accepted; anything else is refused', () => {
    assert.deepEqual(validateConfig(withTools({ httpAllowlist: ['https://api.example.test'], urlEnvironmentClass: 'staging' })), []);
    assert.ok(validateConfig(withTools({ urlEnvironmentClass: '' })).includes('tools.urlEnvironmentClass must be a non-empty string'));
    assert.ok(validateConfig(withTools({ urlEnvironmentClass: 3 })).includes('tools.urlEnvironmentClass must be a non-empty string'));
  });
});

describe('tools.mcpServers (E[5]/stubs[1]/coverage[3])', () => {
  const ok = { id: 'tickets', command: 'node', args: ['server.mjs'], envFrom: { TICKETS_TOKEN: 'HT_TICKETS_TOKEN' }, allowTools: ['create_ticket', 'list_tickets'], toolEffects: { list_tickets: { effect: 'read', riskClass: 'low' } }, roles: ['executor'], grantTo: ['test_executor'] };

  test('a stdio and an HTTP server with *Env names, classification, roles and grants validate', () => {
    assert.deepEqual(validateConfig(withTools({ mcpServers: [ok, { id: 'tracker', url: 'https://mcp.example.test/mcp', headersFromEnv: { authorization: 'MCP_TRACKER_AUTH' }, allowTools: ['list'], effect: 'read', riskClass: 'low' }] })), []);
  });

  test('every malformed key is refused with its exact path; inline secrets never', () => {
    const problems = (s: Record<string, unknown>, environments?: unknown[]) => validateConfig({ ...withTools({ mcpServers: [s] }), ...(environments ? { environments } : {}) } as HypertestConfig);
    const has = (errors: string[], re: RegExp) => assert.ok(errors.some((e) => re.test(e)), errors.join('\n'));
    has(problems({ ...ok, env: { TICKETS_TOKEN: 'plain-secret' } }), /tools\.mcpServers\[0\]\.env: inline environment values are not allowed/);
    has(problems({ ...ok, headers: { authorization: 'Bearer x' } }), /\.headers: inline header values are not allowed/);
    has(problems({ ...ok, url: 'http://h/mcp' }), /needs exactly one of command \(stdio\) and url/);
    has(problems({ id: 'x', allowTools: ['t'] }), /needs exactly one of command/);
    has(problems({ ...ok, id: 'bad id!' }), /\.id must match/);
    has(problems({ ...ok, allowTools: [] }), /allowTools must be a non-empty list/);
    has(problems({ ...ok, envFrom: { TOKEN: 'not a name' } }), /envFrom\.TOKEN must name an environment variable/);
    has(problems({ ...ok, effect: 'explode' }), /\.effect must be one of/);
    has(problems({ ...ok, riskClass: 'extreme' }), /\.riskClass must be one of/);
    has(problems({ ...ok, toolEffects: { other: { effect: 'read' } } }), /toolEffects\.other: not in allowTools/);
    has(problems({ ...ok, roles: ['wizard'] }), /\.roles: unknown role 'wizard'/);
    has(problems({ ...ok, grantTo: ['root'] }), /\.grantTo: unknown permission profile 'root'/);
    has(problems({ ...ok, environmentId: 'nope' }), /environment 'nope' is not configured/);
    has(problems({ ...ok, environmentId: 'svc', grantTo: undefined, environmentClass: 'local' }, [{ environmentId: 'svc', environmentClass: 'local', generation: 0 }]), /environmentClass comes from the environment/);
    has(problems({ ...ok, timeoutMs: 0 }), /timeoutMs must be an integer/);
    has(problems({ ...ok, bogus: 1 }), /unknown key 'bogus'/);
    has(validateConfig(withTools({ mcpServers: [ok, ok] })), /duplicate MCP server 'tickets'/);
    has(problems({ ...ok, url: undefined, command: undefined, headersFromEnv: { authorization: 'X' }, id: 'h' }), /needs exactly one/);
  });

  test('mcpServerConfigs resolves *Env names; a missing variable makes the server unavailable (logged by name, never by value)', () => {
    const logger = new MemoryLogger();
    const [resolved] = mcpServerConfigs({ tools: { mcpServers: [ok as never] } } as unknown as HypertestConfig, { HT_TICKETS_TOKEN: 's3cret' }, logger);
    assert.deepEqual(resolved!.env, { TICKETS_TOKEN: 's3cret' });
    assert.equal(resolved!.unavailableReason, undefined);
    const [missing] = mcpServerConfigs({ tools: { mcpServers: [ok as never] } } as unknown as HypertestConfig, {}, logger);
    assert.match(missing!.unavailableReason!, /HT_TICKETS_TOKEN/);
    assert.equal(JSON.stringify(logger.entries).includes('s3cret'), false);
  });

  test('withToolRoleGrants extends (never replaces) the offered roles\' allowlists; other roles are untouched', () => {
    const overrides = withToolRoleGrants({ tools: { mcpServers: [ok as never, { ...ok, id: 'calc', roles: undefined } as never] } } as unknown as HypertestConfig, { executor: { toolPolicy: { allow: ['http.request', 'complete_work', 'fail_work'] } } } as never);
    const roles = new RoleCatalog(BUILTIN_ROLES, { roles: overrides });
    assert.deepEqual(roles.require('executor').toolPolicy.allow, ['http.request', 'complete_work', 'fail_work', 'mcp.tickets.*', 'mcp.calc.*']);
    assert.equal(roles.require('vision_gui').toolPolicy.allow.some((p) => p.startsWith('mcp.')), false);
    // the built-in allowlist is the base when the configuration does not override it
    const builtin = new RoleCatalog(BUILTIN_ROLES, { roles: withToolRoleGrants({ tools: { mcpServers: [{ ...ok, roles: ['metrics_analyst'] } as never] } } as unknown as HypertestConfig, {}) });
    const base = BUILTIN_ROLES.find((r) => r.role === 'metrics_analyst')!.toolPolicy.allow;
    assert.deepEqual(builtin.require('metrics_analyst').toolPolicy.allow, [...base, 'mcp.tickets.*']);
  });
});

describe('tools.remoteWorkers / tools.acpAgents / tools.computerUse / environment tool keys (row 246, 248, 249)', () => {
  const has = (errors: string[], re: RegExp) => assert.ok(errors.some((e) => re.test(e)), errors.join('\n'));

  test('remote workers: url, secret by NAME, delegated tools; inline secrets and double delegation refused', () => {
    assert.deepEqual(validateConfig(withTools({ remoteWorkers: [{ id: 'edge', url: 'https://edge.example.test:7431', secretEnv: 'HT_EDGE_SECRET', tools: ['http.request', 'grpc.call'] }] })), []);
    has(validateConfig(withTools({ remoteWorkers: [{ id: 'edge', url: 'https://edge', secret: 'inline', secretEnv: 'X', tools: ['http.request'] }] })), /remoteWorkers\[0\]\.secret: inline secrets are not allowed/);
    has(validateConfig(withTools({ remoteWorkers: [{ id: 'edge', url: 'ftp://edge', secretEnv: 'X', tools: ['http.request'] }] })), /url must be an absolute http\(s\) URL/);
    has(validateConfig(withTools({ remoteWorkers: [{ id: 'a', url: 'http://a', secretEnv: 'X', tools: ['http.request'] }, { id: 'b', url: 'http://b', secretEnv: 'Y', tools: ['http.request'] }] })), /already delegated to remote worker a/);
    has(validateConfig(withTools({ remoteWorkers: [{ id: 'edge', url: 'http://a', secretEnv: 'bad name', tools: [] }] })), /secretEnv must name/);
  });

  test('withRemoteWorkers: delegated tools keep their classification; bound or unknown tools fail the composition; a missing secret fails closed', () => {
    const http = { id: 'http.request', title: 't', description: 'd', inputSchema: { type: 'object' }, effect: 'read', riskClass: 'low', resources: () => ['env/x'], timeoutMs: 1000, execute: async () => ({ status: 'success' }) } as unknown as Parameters<typeof withRemoteWorkers>[0][number];
    const bound = { ...http, id: 'load.start', sideEffect: { adapterId: 'load.http', operationType: 'load.start', target: () => ({ resourceKey: 'loadgen/x', kind: 'load_job' }) } } as unknown as Parameters<typeof withRemoteWorkers>[0][number];
    const logger = new MemoryLogger();
    const cfg = (tools: string[]) => ({ tools: { remoteWorkers: [{ id: 'edge', url: 'http://127.0.0.1:1', secretEnv: 'HT_EDGE', tools }] } }) as unknown as HypertestConfig;
    const [remote] = withRemoteWorkers([http], cfg(['http.request']), {}, logger);
    assert.notEqual(remote, http);
    assert.equal(remote!.effect, 'read');
    assert.deepEqual(remote!.resources({}, {} as never), ['env/x']);
    assert.ok(logger.entries.some((e) => e.msg.startsWith('remote tool worker is unavailable')));
    assert.throws(() => withRemoteWorkers([http, bound], cfg(['load.start']), { HT_EDGE: 'x'.repeat(20) }, logger), /side-effect binding/);
    assert.throws(() => withRemoteWorkers([http], cfg(['nope.tool']), { HT_EDGE: 'x'.repeat(20) }, logger), /not in the tool catalog/);
  });

  test('ACP agents: command, envFrom names, sandbox placement, roles', () => {
    assert.deepEqual(validateConfig(withTools({ acpAgents: [{ id: 'coder', command: 'claude-code-acp', args: ['--x'], envFrom: { ANTHROPIC_API_KEY: 'HT_ANTHROPIC_KEY' }, sandbox: 'host', roles: ['fixer'] }] })), []);
    has(validateConfig(withTools({ acpAgents: [{ id: 'coder', command: 'x', env: { K: 'v' } }] })), /acpAgents\[0\]\.env: inline environment values/);
    has(validateConfig(withTools({ acpAgents: [{ id: 'coder', command: 'x', sandbox: 'none' }] })), /sandbox must be workspace/);
    has(validateConfig(withTools({ acpAgents: [{ id: 'coder', command: 'x', roles: ['nobody'] }] })), /unknown role 'nobody'/);
    has(validateConfig(withTools({ acpAgents: [{ id: 'c', command: 'x' }, { id: 'c', command: 'y' }] })), /duplicate ACP agent 'c'/);
    const logger = new MemoryLogger();
    const [a] = acpAgentConfigs({ tools: { acpAgents: [{ id: 'coder', command: 'x', envFrom: { K: 'HT_K' } }] } } as unknown as HypertestConfig, {}, logger);
    assert.match(a!.unavailableReason!, /HT_K/);
    const roles = new RoleCatalog(BUILTIN_ROLES, { roles: withToolRoleGrants({ tools: { acpAgents: [{ id: 'coder', command: 'x' }] } } as unknown as HypertestConfig, {}) });
    assert.ok(roles.require('test_designer').toolPolicy.allow.includes('acp.coder.*'));
  });

  test('computer use: backend, display, grants, roles; the fake backend is announced', () => {
    assert.deepEqual(validateConfig(withTools({ computerUse: { backend: 'x11', display: ':99', displayId: 'kiosk', grantTo: ['test_executor'], roles: ['vision_gui'] } })), []);
    has(validateConfig(withTools({ computerUse: { backend: 'x11' } })), /display \(a local X display such as :99\) is required/);
    has(validateConfig(withTools({ computerUse: { backend: 'vnc', display: ':1' } })), /backend must be one of x11, xdotool, fake/);
    has(validateConfig(withTools({ computerUse: { backend: 'x11', display: ':1', xdotool: '/usr/bin/xdotool' } })), /xdotool \(the xdotool binary\) applies to backend xdotool/);
    has(validateConfig(withTools({ computerUse: { backend: 'fake', grantTo: ['nobody'] } })), /unknown permission profile 'nobody'/);
    const logger = new MemoryLogger();
    const o = computerUseOptions({ tools: { computerUse: { backend: 'fake' } } } as unknown as HypertestConfig, logger)!;
    assert.equal(o.backend.kind, 'fake');
    assert.equal(o.displayId, 'fake');
    assert.ok(logger.entries.some((e) => /FAKE desktop backend/.test(e.msg)));
    assert.equal(computerUseOptions({ tools: { computerUse: { backend: 'x11', display: ':99.0' } } } as unknown as HypertestConfig, logger)!.displayId, 'display-99-0');
    const roles = new RoleCatalog(BUILTIN_ROLES, { roles: withToolRoleGrants({ tools: { computerUse: { backend: 'fake' } } } as unknown as HypertestConfig, {}) });
    assert.ok(roles.require('vision_gui').toolPolicy.allow.includes('computer.*'));
  });

  test('environment tool keys: grpc, logs, traces, database (by variable NAME), kubectl context', () => {
    const env = (extra: Record<string, unknown>) => validateConfig({ ...defaultConfig(), environments: [{ environmentId: 'e', environmentClass: 'local', generation: 0, ...extra }] } as unknown as HypertestConfig);
    assert.deepEqual(env({
      grpc: { target: '127.0.0.1:50051', protoFiles: ['/srv/shop.proto'], readMethods: ['shop.Catalog/Get*'] },
      logs: { files: ['/var/log/shop.log'] },
      traces: { kind: 'jaeger', url: 'http://127.0.0.1:16686', service: 'shop' },
      database: { kind: 'postgres', urlEnv: 'SHOP_DB_URL', schemas: ['public'] },
      control: { kind: 'kubectl', target: 'shop', namespace: 'ns', context: 'kind-test' },
    }), []);
    has(env({ grpc: { target: 'no-port' } }), /grpc\.target must be host:port/);
    has(env({ grpc: { target: 'h:1', protoFiles: ['/a.proto'], reflection: true } }), /exactly one definition source/);
    has(env({ grpc: { target: 'h:1', reflection: true, readMethods: ['bad method'] } }), /readMethods: "bad method"/);
    has(env({ logs: { files: ['relative.log'] } }), /logs\.files must be a list of absolute paths/);
    has(env({ traces: { kind: 'zipkin' } }), /traces\.kind must be one of/);
    has(env({ traces: { kind: 'otlp_file' } }), /traces\.path \(absolute\) is required/);
    has(env({ database: { kind: 'postgres', url: 'postgres://u:p@h/db' } }), /database\.url: inline connection strings are not allowed/);
    has(env({ database: { kind: 'postgres' } }), /urlEnv \(the NAME of the variable/);
    has(env({ database: { kind: 'sqlite', path: 'rel.db' } }), /database\.path \(absolute\) is required for kind sqlite/);
    has(env({ control: { kind: 'docker', target: 'c', context: 'x' } }), /control\.context is only valid for kind kubectl/);
  });
});

describe('sandbox keys and isolation tiers (row 250 / E[6] / stubs[6])', () => {
  const withSandbox = (sandbox: Record<string, unknown>) => ({ ...defaultConfig(), sandbox: { kind: 'local', network: 'loopback', envAllowlist: [], ...sandbox } }) as unknown as HypertestConfig;
  const has = (errors: string[], re: RegExp) => assert.ok(errors.some((e) => re.test(e)), errors.join('\n'));

  test('every accepted key is honoured by the selected sandbox, else refused (allowedHosts rules; cpuLimit/memoryMb positive)', () => {
    assert.deepEqual(validateConfig(withSandbox({ network: 'egress_allowlist', allowedHosts: ['127.0.0.1:9000', 'localhost:3000'], cpuLimit: 1.5, memoryMb: 512 })), []);
    has(validateConfig(withSandbox({ allowedHosts: ['127.0.0.1:9000'] })), /sandbox\.allowedHosts applies only to network 'egress_allowlist'/);
    has(validateConfig(withSandbox({ network: 'egress_allowlist', allowedHosts: ['example.com'] })), /sandbox\.allowedHosts: "example\.com" — the local sandbox relays only loopback endpoints/);
    has(validateConfig(withSandbox({ kind: 'oci', image: 'node:22', network: 'egress_allowlist', allowedHosts: ['127.0.0.1:1'] })), /sandbox\.allowedHosts is not supported by the OCI sandbox/);
    has(validateConfig(withSandbox({ memoryMb: 0 })), /sandbox\.memoryMb must be a positive number/);
    // a role tier that switches network (or to oci) without its own allowlist drops the base allowedHosts
    assert.deepEqual(validateConfig(withSandbox({ network: 'egress_allowlist', allowedHosts: ['127.0.0.1:9000'], roles: { executor: { tier: 'separate', network: 'none' }, rca: { tier: 'isolated', kind: 'oci', image: 'node:22' } } })), []);
  });

  test('sandbox.roles: a tier per role with its own keys; malformed tiers, keys and read_only for writing roles refused', () => {
    assert.deepEqual(validateConfig(withSandbox({
      roles: {
        reviewer: { tier: 'read_only' },
        executor: { tier: 'separate', network: 'egress_allowlist', allowedHosts: ['127.0.0.1:9000'], memoryMb: 2048, cpuLimit: 2 },
        rca: { tier: 'isolated', kind: 'oci', image: 'node:22', network: 'none' },
      },
    })), []);
    has(validateConfig(withSandbox({ roles: { executor: { tier: 'jail' } } })), /sandbox\.roles\.executor\.tier must be one of read_only, isolated, separate/);
    has(validateConfig(withSandbox({ roles: { executor: { tier: 'separate', gpu: true } } })), /sandbox\.roles\.executor: unknown key 'gpu'/);
    has(validateConfig(withSandbox({ roles: { fixer: { tier: 'read_only' } } })), /sandbox\.roles\.fixer\.tier read_only: role fixer writes its worktree \(fs\.write, fs\.apply_patch, git\.commit\)/);
    has(validateConfig(withSandbox({ roles: { executor: { tier: 'separate', kind: 'oci' } } })), /sandbox\.roles\.executor: kind oci needs an image/);
    has(validateConfig(withSandbox({ roles: { executor: { tier: 'separate', allowedHosts: ['127.0.0.1:1'] } } })), /sandbox\.roles\.executor\.allowedHosts applies only to network 'egress_allowlist'/);
  });

  test('isolationResolver: the role tier, made stricter by its work item (no write_workspace ⇒ read-only; no environment ⇒ no egress)', async () => {
    const config = withSandbox({ roles: { executor: { tier: 'separate', network: 'egress_allowlist', allowedHosts: ['127.0.0.1:9000'], memoryMb: 1024 }, reviewer: { tier: 'read_only' } } });
    const items: Record<string, { capabilityRequirements: Array<{ effect: string; resourceScopes: string[] }> }> = {
      plain: { capabilityRequirements: [] },
      readOnly: { capabilityRequirements: [{ effect: 'execute', resourceScopes: ['workspace/**', 'env/shop'] }] },
      offline: { capabilityRequirements: [{ effect: 'execute', resourceScopes: ['workspace/**'] }, { effect: 'write_workspace', resourceScopes: ['workspace/**'] }] },
    };
    let reads = 0;
    const resolve = isolationResolver(config, { getWorkItem: async (id) => (reads++, items[id]) });
    const ws = (kind: 'isolated_worktree' | 'scratch') => ({ workspaceId: 'w', kind, root: '/tmp/x', readOnly: false, sandbox: { kind: 'local', network: 'loopback', envAllowlist: [] }, resourcePrefix: 'workspace/w' }) as never;
    assert.deepEqual(await resolve({ runId: 'r', workItemId: 'plain', role: 'executor', workspace: ws('isolated_worktree') }), { tier: 'separate', sandbox: { network: 'egress_allowlist', allowedHosts: ['127.0.0.1:9000'], memoryMb: 1024 }, reason: 'sandbox.roles.executor' });
    assert.deepEqual(await resolve({ runId: 'r', workItemId: 'plain', role: 'reviewer', workspace: ws('isolated_worktree') }), { tier: 'read_only', readOnly: true, reason: 'sandbox.roles.reviewer' });
    assert.equal(await resolve({ runId: 'r', workItemId: 'plain', role: 'lead', workspace: ws('isolated_worktree') }), undefined, 'no tier configured, no narrowing: the workspace as it is');
    const ro = await resolve({ runId: 'r', workItemId: 'readOnly', role: 'rca', workspace: ws('isolated_worktree') });
    assert.deepEqual([ro?.tier, ro?.readOnly, ro?.reason], ['read_only', true, 'work item capability grants no workspace writes']);
    const off = await resolve({ runId: 'r', workItemId: 'offline', role: 'executor', workspace: ws('isolated_worktree') });
    assert.deepEqual([off?.tier, off?.sandbox?.network, off?.sandbox?.allowedHosts, off?.readOnly], ['separate', 'none', undefined, undefined]);
    await resolve({ runId: 'r', workItemId: 'offline', role: 'executor', workspace: ws('isolated_worktree') });
    assert.equal(reads, 3, 'each work item is read once');
    const switched = isolationResolver(withSandbox({ network: 'egress_allowlist', allowedHosts: ['127.0.0.1:9000'], roles: { executor: { tier: 'separate', network: 'none' } } }), { getWorkItem: async () => undefined });
    assert.deepEqual((await switched({ runId: 'r', workItemId: 'x', role: 'executor', workspace: ws('isolated_worktree') }))?.sandbox, { network: 'none', allowedHosts: [] });
  });
});
