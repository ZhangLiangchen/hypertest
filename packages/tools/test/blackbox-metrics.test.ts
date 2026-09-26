import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import {
  createEnvironmentRegistry, histogramQuantile, metricsQueryTool, metricsScrapeTool, parsePrometheusApiResponse, parsePrometheusText, parsePromValue, summarizeMetrics, type ToolSpec,
} from '../src/index.ts';
import { fakeContext, startServer, structuredOf, type TestServer } from './blackbox-helpers.ts';

const EXPOSITION = [
  '# HELP http_request_duration_seconds Request latency.\\nSecond line with a \\\\ backslash',
  '# TYPE http_request_duration_seconds histogram',
  'http_request_duration_seconds_bucket{route="/a",le="0.1"} 10',
  'http_request_duration_seconds_bucket{route="/a",le="0.5"} 60',
  'http_request_duration_seconds_bucket{route="/a",le="1"} 90',
  'http_request_duration_seconds_bucket{route="/a",le="+Inf"} 100',
  'http_request_duration_seconds_sum{route="/a"} 31.5',
  'http_request_duration_seconds_count{route="/a"} 100',
  'http_request_duration_seconds_bucket{route="/b",le="0.1"} 0',
  'http_request_duration_seconds_bucket{route="/b",le="0.5"} 0',
  'http_request_duration_seconds_bucket{route="/b",le="1"} 0',
  'http_request_duration_seconds_bucket{route="/b",le="+Inf"} 100',
  'http_request_duration_seconds_sum{route="/b"} 250',
  'http_request_duration_seconds_count{route="/b"} 100',
  '# HELP http_requests_total Total requests.',
  '# TYPE http_requests_total counter',
  'http_requests_total{method="GET",path="/q\\"uote\\\\d\\nx"} 1027 1395066363000',
  'http_requests_total{method="POST",} 3',
  '# TYPE temperature gauge',
  'temperature NaN',
  'temperature{sensor="hot"} +Inf',
  'temperature{sensor="cold"} -Inf',
  'untyped_thing 4.2e1',
  'this is not a sample',
  '# TYPE rpc summary',
  'rpc{quantile="0.99"} 7',
  'rpc_sum 12',
  'rpc_count 3',
  '# EOF',
].join('\n');

test('text exposition parser: HELP/TYPE, label escapes, timestamps, special floats, lenient errors', () => {
  const r = parsePrometheusText(EXPOSITION);
  assert.deepEqual(r.families.map((f) => [f.name, f.type, f.samples.length]), [
    ['http_request_duration_seconds', 'histogram', 12],
    ['http_requests_total', 'counter', 2],
    ['temperature', 'gauge', 3],
    ['untyped_thing', 'untyped', 1],
    ['rpc', 'summary', 3],
  ]);
  assert.equal(r.families[0]!.help, 'Request latency.\nSecond line with a \\ backslash');
  const req = r.families[1]!.samples[0]!;
  assert.deepEqual(req.labels, { method: 'GET', path: '/q"uote\\d\nx' });
  assert.equal(req.value, 1027);
  assert.equal(req.timestampMs, 1395066363000);
  assert.deepEqual(r.families[1]!.samples[1]!.labels, { method: 'POST' }, 'trailing comma tolerated');
  const temps = r.families[2]!.samples.map((s) => s.value);
  assert.ok(Number.isNaN(temps[0]));
  assert.equal(temps[1], Number.POSITIVE_INFINITY);
  assert.equal(temps[2], Number.NEGATIVE_INFINITY);
  assert.equal(r.families[3]!.samples[0]!.value, 42);
  assert.equal(r.sampleCount, 21);
  assert.deepEqual(r.errors, [{ line: 24, message: 'unexpected trailing fields' }]);
  assert.deepEqual(parsePrometheusText('m{a="unterminated} 1\nm{1a="x"} 2\nm{a="x",a="y"} 3\nm{a="\\q"} 4\nm 1 notatime\n# TYPE m bogus').errors.map((e) => e.line), [1, 2, 3, 4, 5, 6]);
  assert.equal(parsePromValue('Inf'), Number.POSITIVE_INFINITY);
  assert.equal(parsePromValue('-1.5e-3'), -0.0015);
  assert.throws(() => parsePromValue('1,5'), /invalid sample value/);
});

test('histogram quantiles use linear interpolation inside the rank bucket (Prometheus semantics)', () => {
  const b = [
    { le: 0.1, count: 10 },
    { le: 0.5, count: 60 },
    { le: 1, count: 90 },
    { le: Number.POSITIVE_INFINITY, count: 100 },
  ];
  assert.equal(histogramQuantile(0.5, b), 0.1 + 0.4 * (40 / 50)); // 0.42
  assert.equal(histogramQuantile(0.05, b), 0.05);
  assert.equal(histogramQuantile(0.9, b), 1);
  assert.equal(histogramQuantile(0.95, b), 1, 'rank in the +Inf bucket ⇒ highest finite bound');
  assert.equal(histogramQuantile(0, b), 0);
  assert.equal(histogramQuantile(1.5, b), Number.POSITIVE_INFINITY);
  assert.equal(histogramQuantile(-1, b), Number.NEGATIVE_INFINITY);
  assert.ok(Number.isNaN(histogramQuantile(0.5, b.slice(0, 3))), 'no +Inf bucket ⇒ NaN');
  assert.ok(Number.isNaN(histogramQuantile(0.5, [{ le: 1, count: 0 }, { le: Number.POSITIVE_INFINITY, count: 0 }])), 'no observations ⇒ NaN');
  assert.equal(histogramQuantile(0.5, [{ le: -1, count: 5 }, { le: Number.POSITIVE_INFINITY, count: 5 }]), -1, 'first bucket with upper bound ≤ 0');
  // unsorted input + duplicate bounds from several series are merged; non-monotonic counts are repaired
  assert.equal(histogramQuantile(0.625, [{ le: Number.POSITIVE_INFINITY, count: 4 }, { le: 2, count: 1 }, { le: 2, count: 1 }, { le: 4, count: 3 }]), 3);
  assert.equal(histogramQuantile(0.5, [{ le: 1, count: 5 }, { le: 2, count: 3 }, { le: Number.POSITIVE_INFINITY, count: 6 }]), 0.6);
});

test('summarizeMetrics aggregates histogram buckets across label sets and totals counters', () => {
  const s = summarizeMetrics(parsePrometheusText(EXPOSITION));
  const q = s.quantiles['http_request_duration_seconds']!;
  // merged: le 0.1:10, 0.5:60, 1:90, +Inf:200 ⇒ p50 rank 100 lands in +Inf ⇒ 1
  assert.deepEqual(q, { p50: 1, p95: 1, p99: 1, count: 200, sum: 281.5, series: 2 });
  assert.deepEqual(s.counters, { http_requests_total: 1030 });
  assert.equal(s.families.length, 5);
  assert.equal(s.sampleCount, 21);
  assert.equal(s.parseErrors.length, 1);
  const single = summarizeMetrics(parsePrometheusText(EXPOSITION.split('\n').filter((l) => !l.includes('route="/b"')).join('\n')));
  assert.deepEqual(single.quantiles['http_request_duration_seconds'], { p50: 0.1 + 0.4 * (40 / 50), p95: 1, p99: 1, count: 100, sum: 31.5, series: 1 });
});

test('Prometheus API results: vector, matrix, scalar and error payloads', () => {
  assert.deepEqual(parsePrometheusApiResponse({ status: 'success', data: { resultType: 'vector', result: [{ metric: { job: 'a' }, value: [1700000000.5, '0.25'] }, { metric: {}, value: [1, 'NaN'] }] } }), {
    resultType: 'vector',
    series: [
      { metric: { job: 'a' }, values: [[1700000000.5, 0.25]] },
      { metric: {}, values: [[1, 'NaN']] },
    ],
  });
  assert.deepEqual(parsePrometheusApiResponse({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { i: '1' }, values: [[1, '1'], [2, '+Inf']] }] } }).series[0]!.values, [[1, 1], [2, '+Inf']]);
  assert.deepEqual(parsePrometheusApiResponse({ status: 'success', data: { resultType: 'scalar', result: [5, '3'] } }), { resultType: 'scalar', series: [{ metric: {}, values: [[5, 3]] }] });
  assert.throws(
    () => parsePrometheusApiResponse({ status: 'error', errorType: 'bad_data', error: 'parse error at char 3' }),
    (e: unknown) => isHypertestError(e, 'invalid_argument') && (e.details as { errorType: string }).errorType === 'bad_data' && /parse error/.test(e.message),
  );
  assert.throws(() => parsePrometheusApiResponse({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: ['x', '1'] }] } }), /malformed timestamp/);
  assert.throws(() => parsePrometheusApiResponse('nope'), /not a JSON object/);
});

// ----------------------------------------------------------------------------- tools against local servers

let prom: TestServer;
let target: TestServer;

before(async () => {
  prom = await startServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams.get('query');
    res.setHeader('content-type', 'application/json');
    if (q === 'bad(') {
      res.writeHead(400);
      res.end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: '1:5: parse error: unclosed left parenthesis' }));
      return;
    }
    if (url.pathname === '/prom/api/v1/query') {
      res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'svc' }, value: [Number(url.searchParams.get('time') ?? 1), '1'] }] } }));
      return;
    }
    if (url.pathname === '/prom/api/v1/query_range') {
      res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { job: 'svc' }, values: [[10, '0.5'], [20, '0.75']] }] } }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  target = await startServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(EXPOSITION);
      return;
    }
    if (req.url === '/metrics-broken') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': String(EXPOSITION.length) });
      res.write(EXPOSITION.slice(0, 200));
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    res.writeHead(503);
    res.end('down');
  });
});

after(async () => {
  await prom.close();
  await target.close();
});

test('metrics.query: instant query via environment prometheusUrl, numbers parsed, metric evidence with raw JSON', async () => {
  const envs = createEnvironmentRegistry([{ environmentId: 'env_m', environmentClass: 'local', generation: 1, prometheusUrl: `${prom.url}/prom/`, metricsUrl: `${target.url}/metrics` }]);
  const tool = metricsQueryTool({}) as ToolSpec;
  const { ctx, evidence } = fakeContext({ environments: envs });
  const out = await tool.execute({ environmentId: 'env_m', query: 'up{job="svc"}', time: 1700000000 }, ctx);
  assert.equal(out.status, 'success');
  assert.deepEqual(structuredOf(out)['series'], [{ metric: { __name__: 'up', job: 'svc' }, values: [[1700000000, 1]] }]);
  assert.equal(structuredOf(out)['resultType'], 'vector');
  const last = prom.requests.at(-1)!;
  assert.equal(last.url, '/prom/api/v1/query?query=up%7Bjob%3D%22svc%22%7D&time=1700000000');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.input.evidenceType, 'metric');
  assert.equal(evidence[0]!.input.mimeType, 'application/json');
  assert.equal(JSON.parse(evidence[0]!.input.data as string).status, 'success');
  assert.equal((evidence[0]!.input.structured as any)['query'], 'up{job="svc"}');
  assert.equal(structuredOf(out)['evidenceId'], evidence[0]!.record.evidenceId);
});

test('metrics.query: range query hits query_range with start/end/step', async () => {
  const { ctx } = fakeContext();
  const out = await metricsQueryTool({}).execute({ prometheusUrl: `${prom.url}/prom`, query: 'rate(x[1m])', range: { start: 10, end: 20, step: '10s' } }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(prom.requests.at(-1)!.url, '/prom/api/v1/query_range?query=rate%28x%5B1m%5D%29&start=10&end=20&step=10s');
  assert.deepEqual(structuredOf(out)['series'][0]['values'], [[10, 0.5], [20, 0.75]]);
});

test('metrics.query: a Prometheus error is a failed call with the Prometheus error type, and no evidence', async () => {
  const { ctx, evidence } = fakeContext();
  const out = await metricsQueryTool({}).execute({ prometheusUrl: `${prom.url}/prom`, query: 'bad(' }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'prometheus_bad_data');
  assert.match(out.error!.message, /unclosed left parenthesis/);
  assert.equal(evidence.length, 0);
});

test('metrics.query: hosts outside the allowlist are denied; environments without Prometheus are a precondition failure', async () => {
  const { ctx } = fakeContext({ environments: createEnvironmentRegistry([{ environmentId: 'env_np', environmentClass: 'local', generation: 1 }]) });
  const before = prom.requests.length;
  const out = await metricsQueryTool({}).execute({ prometheusUrl: 'http://prometheus.example.test:9090', query: 'up' }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'permission_denied');
  const none = await metricsQueryTool({}).execute({ environmentId: 'env_np', query: 'up' }, ctx);
  assert.equal(none.error?.code, 'precondition_failed');
  assert.equal(prom.requests.length, before);
});

test('metrics.scrape: environment metricsUrl → families, histogram quantiles, counters, metric evidence with the raw text', async () => {
  const envs = createEnvironmentRegistry([{ environmentId: 'env_m', environmentClass: 'local', generation: 1, metricsUrl: `${target.url}/metrics` }]);
  const { ctx, evidence } = fakeContext({ environments: envs });
  const out = await metricsScrapeTool({}).execute({ environmentId: 'env_m' }, ctx);
  assert.equal(out.status, 'success');
  const s = structuredOf(out);
  assert.deepEqual(s['quantiles']['http_request_duration_seconds'], { p50: 1, p95: 1, p99: 1, count: 200, sum: 281.5, series: 2 });
  assert.deepEqual(s['counters'], { http_requests_total: 1030 });
  assert.equal(s['samples'].length, 21);
  assert.deepEqual(s['samples'][18], { name: 'rpc', labels: { quantile: '0.99' }, value: 7 });
  assert.equal(s['samples'].find((x: { name: string; labels: Record<string, string> }) => x.name === 'temperature' && x.labels['sensor'] === 'hot').value, '+Inf');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.input.evidenceType, 'metric');
  assert.equal(evidence[0]!.input.data, EXPOSITION);
  const st = evidence[0]!.input.structured as any;
  assert.equal(st['quantiles']['http_request_duration_seconds']['p95'], 1);
  assert.equal(st['counters']['http_requests_total'], 1030);
  assert.match(evidence[0]!.input.summary, /5 families, 21 samples; http_request_duration_seconds p50=1 p95=1 p99=1/);
});

test('metrics.scrape: a non-2xx endpoint is a failed call without evidence', async () => {
  const { ctx, evidence } = fakeContext();
  const out = await metricsScrapeTool({}).execute({ url: `${target.url}/down` }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'unavailable');
  assert.match(out.error!.message, /HTTP 503/);
  assert.equal(evidence.length, 0);
});

test('metrics.scrape: a body that breaks off mid-stream is unavailable, never a partial scrape with silently missing series', async () => {
  const { ctx, evidence } = fakeContext();
  const out = await metricsScrapeTool({}).execute({ url: `${target.url}/metrics-broken` }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'unavailable');
  assert.equal(evidence.length, 0);
});

test('metrics.*: the environment-control namespace is never scraped or queried', async () => {
  const { ctx } = fakeContext();
  const before = target.requests.length;
  const out = await metricsScrapeTool({}).execute({ url: `${target.url}/__hypertest/status` }, ctx);
  assert.equal(out.error?.code, 'permission_denied');
  const q = await metricsQueryTool({}).execute({ prometheusUrl: `${target.url}/__hypertest`, query: 'up' }, ctx);
  assert.equal(q.error?.code, 'permission_denied');
  assert.equal(target.requests.length, before);
});
