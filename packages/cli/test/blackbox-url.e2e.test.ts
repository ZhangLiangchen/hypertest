/**
 * (e2e[0]) Black-box testing of "the URL of a running system": `hypertest run --url <sutUrl>` with the URL on
 * `tools.httpAllowlist` (the operator's allowance) over the real stack (PGlite, or PostgreSQL 16 with
 * HYPERTEST_TEST_DB=postgres) and scripted brains whose executor probes the SUT BY URL. The allowlisted URL is a
 * black-box environment of the deployment (`url-<host>-<port>`, class local for loopback): the run targets it, the
 * URL-addressed call is permitted (env/<id> scope), records api-response evidence and reaches the QualityGate (the SUT
 * misses the discount ⇒ verdict fail, exit 3). Before the fix the same run was refused at the capability check
 * (`resource_out_of_scope: url/<host>`), recorded 0 evidence and ended inconclusive (exit 5).
 * Failure paths: a `--url` the operator did not allowlist (and no registered environment serves) is refused before any
 * run is created; a host the allowlist does not name stays refused by the egress guard.
 * Load and metrics by URL (scenario load-probe): in the same kind of run the executor also scrapes the SUT's metrics by
 * URL, defines a load experiment on the URL's environment and drives load by URL (load.start {targetUrl}) — permitted
 * under env/<id>, admitted by the experiment's claim on that environment, one verified load.start operation, metric
 * evidence from load.observe; the verdict is still the gate's (fail).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { URL_LOAD, toolOutcomes } from './fixtures/blackbox-brains.ts';
import { cli, parseJson, writeProject, type TestProject } from './helpers.ts';

const BB_BRAINS = join(import.meta.dirname, 'fixtures', 'blackbox-brains.ts');
const GOAL = 'Is the price API releasable?';

/** The price API under test: no discount at qty 10 (total 10, the oracle wants 9). */
async function startSut(): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const u = new URL(req.url ?? '/', 'http://sut');
    if (u.pathname === '/price') {
      const unit = Number(u.searchParams.get('unit') ?? '0');
      const qty = Number(u.searchParams.get('qty') ?? '0');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unit, qty, total: unit * qty }));
      return;
    }
    if (u.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end('# TYPE price_requests_total counter\nprice_requests_total 3\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const PRICE_ORACLE = {
  oracleId: 'price-api',
  establishedBy: 'alice',
  scope: { components: ['price-api'], description: 'GET /price?unit=1&qty=10 returns the discounted total 9' },
  judgePolicy: { independentReviewerRequired: false },
  assertions: [
    {
      assertionId: 'discount-at-10', description: 'qty 10 is discounted', kind: 'requirement', severity: 'P1',
      check: { type: 'http_expectation', method: 'GET', path: '/price', expectStatus: 200, expectBodyContains: '"total":9' },
    },
  ],
};

type RunJson = { runId: string; status: string; verdict: string | null; exitCode: number; evidenceRootHash: string | null };

describe('hypertest run --url <sutUrl>: the allowlisted URL is a black-box environment the agents may probe', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let sut: Awaited<ReturnType<typeof startSut>>;
  let project: TestProject;
  let env: Record<string, string>;
  let result: Awaited<ReturnType<typeof cli>>;
  let run: RunJson;

  before(async () => {
    dir = await tempDir('ht-cli-bb-');
    sut = await startSut();
    project = await writeProject(dir.path, { oracles: [PRICE_ORACLE], tools: { httpAllowlist: [sut.url] } });
    env = { ...project.env, HT_BB_SUT: sut.url, HT_BB_SCENARIO: 'url-probe' };
    result = await cli(['run', GOAL, '--url', sut.url, '--scripted-brains', BB_BRAINS, '--json', '--timeout-ms', '120000'], { cwd: dir.path, env });
    run = parseJson<RunJson>(result);
  });
  after(async () => {
    await project?.dispose();
    await sut?.close();
    await dir?.cleanup();
  });

  test('the URL-addressed probe is permitted, reaches the SUT and records api-response evidence', async () => {
    const probe = toolOutcomes.find((o) => o.name === 'http__request' || o.name === 'http.request');
    assert.ok(probe, `the executor saw no http.request result: ${JSON.stringify(toolOutcomes)}`);
    assert.equal(probe.isError, false, probe.content);
    assert.doesNotMatch(probe.content, /resource_out_of_scope|capability_denied/);
    assert.ok(sut.requests.includes('GET /price?unit=1&qty=10'), JSON.stringify(sut.requests));
    const ev = await cli(['events', run.runId, '--json'], { cwd: dir.path, env });
    assert.equal(ev.code, 0, ev.stderr);
    const events = ev.stdout.trim().split('\n').map((l) => JSON.parse(l) as { eventType: string; payload: Record<string, unknown> });
    assert.equal(events.filter((e) => e.eventType === 'tool.denied' && e.payload['toolId'] === 'http.request').length, 0, JSON.stringify(events.filter((e) => e.eventType === 'tool.denied')));
    assert.ok(events.some((e) => e.eventType === 'evidence.attached'), 'evidence was recorded');
  });

  test('the run targets the URL environment and the QualityGate judges the evidence: verdict fail (exit 3), not inconclusive', async () => {
    assert.equal(result.code, 3, `${result.stderr}\n${result.stdout}`);
    assert.equal(run.verdict, 'fail');
    assert.equal(run.exitCode, 3);
    const s = parseJson<{ run: { target: Record<string, unknown> } }>(await cli(['status', run.runId, '--json'], { cwd: dir.path, env }));
    const port = new URL(sut.url).port;
    assert.deepEqual(s.run.target, { sutUrl: sut.url, environmentId: `url-127.0.0.1-${port}` });
    const v = await cli(['evidence', 'verify', run.runId, '--json'], { cwd: dir.path, env });
    assert.equal(v.code, 0, v.stderr);
    const verified = parseJson<{ ok: boolean; records: number }>(v);
    assert.equal(verified.ok, true);
    assert.ok(verified.records > 0, 'the run recorded evidence');
  });

  test('a --url that is neither allowlisted nor a registered environment is refused before any run is created', async () => {
    const before = parseJson<unknown[]>(await cli(['status', '--json'], { cwd: dir.path, env })).length;
    const r = await cli(['run', GOAL, '--url', 'http://127.0.0.1:9/unlisted', '--scripted-brains', BB_BRAINS, '--json'], { cwd: dir.path, env });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /tools\.httpAllowlist/);
    const afterRuns = parseJson<unknown[]>(await cli(['status', '--json'], { cwd: dir.path, env })).length;
    assert.equal(afterRuns, before, 'no run was created');
  });
});

describe('hypertest run --url <sutUrl>: metrics and load by URL on the allowlisted environment', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let sut: Awaited<ReturnType<typeof startSut>>;
  let project: TestProject;
  let env: Record<string, string>;
  let result: Awaited<ReturnType<typeof cli>>;
  let run: RunJson;

  before(async () => {
    dir = await tempDir('ht-cli-bb-load-');
    sut = await startSut();
    project = await writeProject(dir.path, { oracles: [PRICE_ORACLE], tools: { httpAllowlist: [sut.url] } });
    env = { ...project.env, HT_BB_SUT: sut.url, HT_BB_SCENARIO: 'load-probe' };
    result = await cli(['run', GOAL, '--url', sut.url, '--scripted-brains', BB_BRAINS, '--json', '--timeout-ms', '180000'], { cwd: dir.path, env });
    run = parseJson<RunJson>(result);
  });
  after(async () => {
    await project?.dispose();
    await sut?.close();
    await dir?.cleanup();
  });

  test('metrics.scrape {url} and load.start {targetUrl} are permitted on env/<id>, ledgered and recorded as evidence; the gate decides', async () => {
    const ev = await cli(['events', run.runId, '--json'], { cwd: dir.path, env });
    assert.equal(ev.code, 0, ev.stderr);
    const events = ev.stdout.trim().split('\n').map((l) => JSON.parse(l) as { eventType: string; payload: Record<string, unknown> });
    assert.deepEqual(events.filter((e) => e.eventType === 'tool.denied').map((e) => e.payload), [], 'no call by URL was denied');
    const envId = `url-127.0.0.1-${new URL(sut.url).port}`;
    const called = (toolId: string) => events.filter((e) => e.eventType === 'tool.called' && e.payload['toolId'] === toolId);
    assert.deepEqual(called('metrics.scrape').map((e) => e.payload['resources']), [[`env/${envId}`]]);
    assert.deepEqual(called('load.start').map((e) => (e.payload['resources'] as string[])[0]), [`env/${envId}`], 'the load job by URL addresses the URL environment');
    // the job really ran against the SUT (by URL) and was observed
    const loadHits = sut.requests.filter((r) => r === 'GET /price?unit=1&qty=1').length;
    assert.ok(loadHits >= URL_LOAD.ratePerSecond * (URL_LOAD.durationMs / 1000) * 0.5, `the load job reached the SUT (${loadHits} requests)`);
    assert.ok(sut.requests.includes('GET /metrics'), 'metrics were scraped by URL');
    const ok = (name: string) => toolOutcomes.filter((o) => (o.name === name || o.name === name.replace('.', '__')) && !o.isError);
    for (const id of ['metrics.scrape', 'experiment.define', 'load.observe']) assert.equal(ok(id).length, 1, `${id}: ${JSON.stringify(toolOutcomes.filter((o) => o.name.replace('__', '.') === id))}`);
    const metricEvidence = events.filter((e) => e.eventType === 'evidence.attached' && e.payload['evidenceType'] === 'metric');
    assert.ok(metricEvidence.length >= 2, `metric evidence from the scrape and the load job (${metricEvidence.length})`);
    assert.equal(result.code, 3, `${result.stderr}\n${result.stdout}`);
    assert.equal(run.verdict, 'fail');
  });
});
