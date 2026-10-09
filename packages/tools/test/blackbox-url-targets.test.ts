/**
 * (e2e[0]) URL-addressed black-box calls under the grant the production composition gives a test executor (its
 * workspace, the run, env/**, loadgen/**, loadjob/** — never url/**): a URL on a registered environment's origin — an
 * operator environment or an allowlisted URL target (`urlTargetEnvironments`) — is a call on that environment
 * (`env/<id>` resource, its class, trusted origins, evidence anchored to it); any other URL stays `url/<host>` and is
 * refused at the capability check. Before the fix every URL-addressed call was `url/<host>` and refused.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PERMISSION_PROFILES, createRootCapability } from '@hypertest/policy';
import type { PermissionProfile } from '@hypertest/domain';
import {
  createEnvironmentRegistry, environmentClassForUrl, httpRequestTool, loadStartTool, metricsScrapeTool, urlEnvironmentId, urlResource, urlTargetEnvironments, type EnvironmentDescriptor,
} from '../src/index.ts';
import { AGENT, FAR, RUN, SECRET, WORK, newRuntime, openBlackboxEnv, startServer, toolRequest, type BlackboxEnv, type TestServer } from './blackbox-helpers.ts';

/** The production grant of a test_executor agent (control worker: workspace + run + the black-box plane it covers). */
function executorCapability() {
  const p = PERMISSION_PROFILES.test_executor;
  const profile: PermissionProfile = { ...p, resourceScopes: ['workspace/ws_bb/**', `run/${RUN}/**`, 'env/**', 'loadgen/**', 'loadjob/**'], environmentClasses: ['local', 'sandbox'] };
  return createRootCapability({ runId: RUN, subjectAgentId: AGENT, workItemId: WORK, profile, tools: ['http.request', 'metrics.scrape', 'load.start'], expiresAt: FAR, capabilityId: 'cap_exec' }, SECRET);
}

describe('urlTargetEnvironments: allowlisted URL targets are black-box environments', () => {
  test('one environment per URL entry: loopback ⇒ local, else the configured remote class (no default: unclassified remote URLs are not environments)', () => {
    const envs = urlTargetEnvironments(['http://127.0.0.1:7450', 'https://api.example.test/v1/', '*.example.org', 'h.example.net:8443', 'http://127.0.0.1:7450'], [], { remoteClass: 'sandbox' });
    assert.deepEqual(envs, [
      { environmentId: 'url-127.0.0.1-7450', environmentClass: 'local', baseUrl: 'http://127.0.0.1:7450', generation: 0 },
      { environmentId: 'url-api.example.test-443', environmentClass: 'sandbox', baseUrl: 'https://api.example.test/v1/', generation: 0 },
    ]);
    assert.equal(urlTargetEnvironments(['https://api.example.test'], [], { remoteClass: 'staging' })[0]!.environmentClass, 'staging');
    // (review) a remote host is never classified by default: on `sandbox` the default policy would let agents write and
    // delete there without approval — without tools.urlEnvironmentClass it stays an unclassified url/<host> (named)
    const unclassified: string[] = [];
    assert.deepEqual(urlTargetEnvironments(['http://127.0.0.1:7450', 'https://api.example.test/v1/'], [], { onUnclassified: (e) => unclassified.push(e) }), [
      { environmentId: 'url-127.0.0.1-7450', environmentClass: 'local', baseUrl: 'http://127.0.0.1:7450', generation: 0 },
    ]);
    assert.deepEqual(unclassified, ['https://api.example.test/v1/']);
    assert.equal(urlEnvironmentId(new URL('http://[::1]:9000/x')), 'url-__1-9000');
  });

  test('an origin an operator environment already serves is not duplicated (the operator registration wins)', () => {
    const operator: EnvironmentDescriptor = { environmentId: 'price', environmentClass: 'staging', baseUrl: 'http://127.0.0.1:7450/api', generation: 3 };
    assert.deepEqual(urlTargetEnvironments(['http://127.0.0.1:7450'], [operator]), []);
    assert.equal(urlResource(new URL('http://127.0.0.1:7450/x'), createEnvironmentRegistry([operator])), 'env/price');
    assert.equal(urlResource(new URL('http://127.0.0.1:7451/x'), createEnvironmentRegistry([operator])), 'url/127.0.0.1:7451');
    // fail closed on ambiguity: two environments serving one origin never let a URL pick one (classes differ ⇒ unclassified)
    const twins = createEnvironmentRegistry([operator, { ...operator, environmentId: 'price-prod', environmentClass: 'production' }]);
    assert.equal(urlResource(new URL('http://127.0.0.1:7450/x'), twins), 'url/127.0.0.1:7450');
    assert.equal(environmentClassForUrl(new URL('http://127.0.0.1:7450/x'), twins), undefined);
    // malformed or non-http entries are ignored (config validation reports them)
    assert.deepEqual(urlTargetEnvironments(['ftp://h/x', 'http://user:pw@h/'], []), []);
  });
});

describe('URL-addressed calls on a URL target environment under the production executor grant', () => {
  let sut: TestServer;
  let stray: TestServer;
  let env: BlackboxEnv;
  let targetEnv: EnvironmentDescriptor;

  before(async () => {
    sut = await startServer((req, res) => {
      if (req.url?.startsWith('/metrics')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('requests_total 7\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"total":10}');
    });
    stray = await startServer((_req, res) => {
      res.end('stray');
    });
    targetEnv = urlTargetEnvironments([sut.url], [])[0]!;
    env = await openBlackboxEnv({ environments: [targetEnv] });
  });
  after(async () => {
    await sut?.close();
    await stray?.close();
    await env?.dispose();
  });

  test('http.request {url} on the target is permitted as env/<id>, reaches the SUT and records evidence anchored to the environment', async () => {
    const runtime = newRuntime(env, [httpRequestTool({ httpAllowlist: [sut.url] })]);
    const r = await runtime.execute(toolRequest('http.request', { method: 'GET', url: `${sut.url}/price?qty=10` }, { capability: executorCapability() }));
    assert.equal(r.status, 'success', r.modelText);
    assert.equal(r.evidenceRefs.length, 1);
    const [ev] = await env.evidence.getMany(r.evidenceRefs);
    assert.equal(ev!.evidenceType, 'api-response');
    assert.equal(ev!.environment?.environmentId, targetEnv.environmentId);
    assert.equal(ev!.environment?.environmentClass, 'local');
    const called = env.events.events.filter((e) => e.eventType === 'tool.called').at(-1)!;
    assert.deepEqual((called.payload as { resources: string[] }).resources, [`env/${targetEnv.environmentId}`]);
    assert.ok(sut.requests.some((q) => q.url === '/price?qty=10'));
  });

  test('metrics.scrape {url} on the target is permitted and records metric evidence', async () => {
    const runtime = newRuntime(env, [metricsScrapeTool({ httpAllowlist: [sut.url] })]);
    const r = await runtime.execute(toolRequest('metrics.scrape', { url: `${sut.url}/metrics` }, { capability: executorCapability() }));
    assert.equal(r.status, 'success', r.modelText);
    assert.ok(r.evidenceRefs.length >= 1);
  });

  test('load.start {targetUrl} on the target addresses env/<id> and its load generator (no url/** scope needed)', () => {
    const spec = loadStartTool({ httpAllowlist: [sut.url] });
    assert.deepEqual(spec.resources({ method: 'GET', targetUrl: `${sut.url}/price`, ratePerSecond: 1, durationMs: 100 }, { workspace: undefined as never, runId: RUN, environments: env.environments }), [
      `env/${targetEnv.environmentId}`, `loadgen/127.0.0.1:${sut.port}`,
    ]);
    assert.equal(spec.environmentClass!({ method: 'GET', targetUrl: `${sut.url}/price`, ratePerSecond: 1, durationMs: 100 }, { environments: env.environments }), 'local');
  });

  test('failure path: a URL no environment serves stays url/<host> and is refused at the capability check (nothing is sent)', async () => {
    const runtime = newRuntime(env, [httpRequestTool({ httpAllowlist: [sut.url, stray.url] })]);
    const r = await runtime.execute(toolRequest('http.request', { method: 'GET', url: `${stray.url}/x` }, { capability: executorCapability() }));
    assert.equal(r.status, 'denied');
    assert.match(r.modelText, /resource_out_of_scope: url\/127\.0\.0\.1:\d+/);
    assert.equal(stray.requests.length, 0);
  });
});
