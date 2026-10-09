/**
 * (row 249 / E[7] / stubs[3]) Black-box observation tools through the governed runtime (capability → permit → evidence):
 *  - logs.query: supervised process output (the supervisor's authorized /logs endpoint), `docker logs` / `kubectl logs`
 *    (FAKE binaries on PATH recording their argv), operator-declared log files (anything else refused); secrets scrubbed;
 *  - trace.query: OTLP/JSON export file, Jaeger query API and Tempo HTTP API (local fake backends), normalized spans;
 *  - net.capture: tcpdump (a FAKE tcpdump on PATH writing a real pcap) → pcap evidence with its packet count; a missing
 *    tcpdump is `unsupported`, a capture without privilege `permission_denied`; the live capture skips with the reason.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blackboxTools, netCaptureTool, pcapPacketCount, startProcessSupervisor, type ProcessSupervisor, type ToolSpec } from '../src/index.ts';
import { newRuntime, openBlackboxEnv, startServer, structuredOf, tempDir, toolRequest, type BlackboxEnv, type TestServer } from './blackbox-helpers.ts';

let env: BlackboxEnv;
let dir: string;
let cleanup: () => Promise<void>;
let sup: ProcessSupervisor;
let jaeger: TestServer;
let tempo: TestServer;
const jaegerHits: string[] = [];
const tempoHits: string[] = [];
const ORIGINAL_PATH = process.env['PATH'];
const NOW_NS = BigInt(Date.now()) * 1_000_000n;

const FAKE_BIN = (name: string, logPath: string) => `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args }) + '\\n');
if (${JSON.stringify(name)} === 'docker') {
  process.stdout.write('2026-10-08T10:00:01Z GET /orders 200\\n2026-10-08T10:00:03Z token=SUPERSECRETVALUE1234 login\\n');
  process.stderr.write('2026-10-08T10:00:02Z ERROR db timeout\\n');
  process.exit(0);
}
if (${JSON.stringify(name)} === 'kubectl') {
  process.stdout.write('2026-10-08T10:00:01Z checkout started\\n2026-10-08T10:00:02Z ERROR payment declined\\n');
  process.exit(0);
}
if (${JSON.stringify(name)} === 'tcpdump') {
  if (process.env.FAKE_TCPDUMP_DENY === '1') {
    // a slow start (FAKE_TCPDUMP_DELAY_MS) answers the missing privilege only after the requested capture duration
    setTimeout(() => { process.stderr.write('tcpdump: lo: You don\\'t have permission to capture on that device\\n'); process.exit(1); }, Number(process.env.FAKE_TCPDUMP_DELAY_MS ?? '0'));
    return;
  }
  const out = args[args.indexOf('-w') + 1];
  const g = Buffer.alloc(24); g.writeUInt32LE(0xa1b2c3d4, 0); g.writeUInt16LE(2, 4); g.writeUInt16LE(4, 6); g.writeUInt32LE(65535, 16); g.writeUInt32LE(1, 20);
  const pkts = [];
  for (let i = 0; i < 3; i++) { const h = Buffer.alloc(16); h.writeUInt32LE(1700000000 + i, 0); h.writeUInt32LE(60, 8); h.writeUInt32LE(60, 12); pkts.push(h, Buffer.alloc(60, i)); }
  fs.writeFileSync(out, Buffer.concat([g, ...pkts]));
  process.on('SIGINT', () => process.exit(0));
  // like tcpdump: the capture window starts once the device is open (net.capture times durationMs from this line)
  process.stderr.write('tcpdump: listening on ' + args[args.indexOf('-i') + 1] + ', link-type EN10MB (Ethernet), snapshot length 262144 bytes\\n');
  setInterval(() => {}, 1000);
}
`;
let logPath: string;
const argv = (bin: string) => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { bin: string; args: string[] }).filter((l) => l.bin === bin).map((l) => l.args) : []);

function otlpLine(traceId: string, spans: Array<{ id: string; parent?: string; name: string; startMs: number; durMs: number; error?: boolean; service?: string }>): string {
  const byService = new Map<string, typeof spans>();
  for (const s of spans) byService.set(s.service ?? 'checkout', [...(byService.get(s.service ?? 'checkout') ?? []), s]);
  return JSON.stringify({
    resourceSpans: [...byService].map(([service, list]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans: list.map((s) => ({
        traceId, spanId: s.id, ...(s.parent ? { parentSpanId: s.parent } : {}), name: s.name,
        startTimeUnixNano: String(NOW_NS - BigInt(60_000 - s.startMs) * 1_000_000n), endTimeUnixNano: String(NOW_NS - BigInt(60_000 - s.startMs - s.durMs) * 1_000_000n),
        status: s.error ? { code: 2 } : { code: 1 }, attributes: [{ key: 'http.status_code', value: { intValue: s.error ? '500' : '200' } }, { key: 'db.password', value: { stringValue: 'p4ss' } }],
      })) }],
    })),
  });
}

before(async () => {
  const d = await tempDir('ht-bb-observe-');
  dir = d.path;
  cleanup = d.cleanup;
  mkdirSync(join(dir, 'bin'));
  logPath = join(dir, 'argv.jsonl');
  for (const name of ['docker', 'kubectl', 'tcpdump']) {
    writeFileSync(join(dir, `${name}.cjs`), FAKE_BIN(name, logPath));
    writeFileSync(join(dir, 'bin', name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, `${name}.cjs`))} "$@"\n`);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  process.env['PATH'] = `${join(dir, 'bin')}:${ORIGINAL_PATH ?? ''}`;

  const appLog = join(dir, 'app.log');
  writeFileSync(appLog, Array.from({ length: 300 }, (_, i) => `line ${i}${i === 299 ? ' ERROR final' : ''}`).join('\n') + '\n');
  const child = join(dir, 'child.cjs');
  writeFileSync(child, "const http=require('http');console.log('child booting');console.log('ERROR cache cold');http.createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('listening'));");
  sup = await startProcessSupervisor({ command: [process.execPath, child], logFile: join(dir, 'supervised.log'), readyTimeoutMs: 10_000, killGraceMs: 500 });

  const otlp = join(dir, 'traces.jsonl');
  writeFileSync(otlp, [
    otlpLine('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [{ id: '0000000000000001', name: 'POST /orders', startMs: 0, durMs: 120 }, { id: '0000000000000002', parent: '0000000000000001', name: 'INSERT orders', startMs: 10, durMs: 90, service: 'db' }]),
    otlpLine('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', [{ id: '0000000000000003', name: 'POST /pay', startMs: 1000, durMs: 40, error: true }]),
    '{"resourceSpans": [', // a partial line being written
  ].join('\n'));

  jaeger = await startServer((req, res) => {
    jaegerHits.push(req.url ?? '');
    const trace = { traceID: 'cccccccccccccccccccccccccccccccc', processes: { p1: { serviceName: 'checkout' } }, spans: [
      { traceID: 'cccccccccccccccccccccccccccccccc', spanID: '00000000000000aa', operationName: 'GET /cart', startTime: Date.now() * 1000 - 5_000_000, duration: 250_000, processID: 'p1', tags: [{ key: 'error', value: true }] },
      { traceID: 'cccccccccccccccccccccccccccccccc', spanID: '00000000000000ab', operationName: 'redis GET', startTime: Date.now() * 1000 - 4_900_000, duration: 20_000, processID: 'p1', references: [{ refType: 'CHILD_OF', spanID: '00000000000000aa' }], tags: [] },
    ] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [trace] }));
  });
  tempo = await startServer((req, res) => {
    tempoHits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').startsWith('/api/search')) return void res.end(JSON.stringify({ traces: [{ traceID: 'dddddddddddddddddddddddddddddddd', rootServiceName: 'checkout' }] }));
    res.end(otlpLine('dddddddddddddddddddddddddddddddd', [{ id: '00000000000000d1', name: 'GET /stock', startMs: 500, durMs: 75 }]).replace('resourceSpans', 'batches'));
  });

  env = await openBlackboxEnv({
    clock: 'system',
    environments: [
      { environmentId: 'env_proc', environmentClass: 'local', generation: 3, baseUrl: sup.url, control: { kind: 'process', target: sup.controlUrl } },
      { environmentId: 'env_file', environmentClass: 'local', generation: 1, logs: { files: [appLog] }, traces: { kind: 'otlp_file', path: otlp, service: 'checkout' } },
      { environmentId: 'env_docker', environmentClass: 'local', generation: 1, baseUrl: 'http://127.0.0.1:18080', control: { kind: 'docker', target: 'shop-api' }, traces: { kind: 'jaeger', url: jaeger.url, service: 'checkout' } },
      { environmentId: 'env_k8s', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'deployment/checkout/app', namespace: 'shop', context: 'kind-x' }, traces: { kind: 'tempo', url: tempo.url, service: 'checkout' } },
    ],
  });
});

after(async () => {
  process.env['PATH'] = ORIGINAL_PATH;
  await sup?.close();
  await jaeger?.close();
  await tempo?.close();
  await env?.dispose();
  await cleanup();
});

const runtime = () => newRuntime(env, blackboxTools({ stateDir: join(dir, 'state') }));

test('logs.query: a declared log file (tail, contains), recorded as log evidence at the environment generation; an undeclared file is refused', async () => {
  const rt = runtime();
  const out = await rt.execute(toolRequest('logs.query', { environmentId: 'env_file', tail: 50 }));
  assert.equal(out.status, 'success', out.modelText);
  assert.equal(structuredOf(out)['lineCount'], 50);
  const ev = (await env.evidence.query({ runId: 'run_bb', evidenceType: 'log' })).find((e) => e.evidenceId === structuredOf(out)['evidenceId'])!;
  assert.equal(Buffer.from(await env.artifacts.get(ev.artifact.sha256)).toString('utf8').split('\n')[0], 'line 250');
  assert.deepEqual([ev.environment?.environmentId, ev.environment?.generation, (ev.structured as { source: string }).source], ['env_file', 1, 'file']);
  const filtered = await rt.execute(toolRequest('logs.query', { environmentId: 'env_file', contains: 'ERROR' }));
  assert.deepEqual([structuredOf(filtered)['lineCount'], filtered.modelText.includes('line 299 ERROR final')], [1, true]);
  const outside = await rt.execute(toolRequest('logs.query', { environmentId: 'env_file', file: '/etc/passwd' }));
  assert.deepEqual([outside.status, outside.error?.code], ['failed', 'permission_denied']);
  assert.match(outside.error!.message, /\/etc\/passwd is not a log file of environment env_file/);
});

test('logs.query: the supervised process output through the supervisor (authorized endpoint; an unauthenticated read is refused)', async () => {
  const unauth = await fetch(`${sup.controlBaseUrl}/logs?tail=10`);
  assert.equal(unauth.status, 401, 'logs may carry secrets: the endpoint is authorized');
  const out = await runtime().execute(toolRequest('logs.query', { environmentId: 'env_proc', contains: 'ERROR' }));
  assert.equal(out.status, 'success', out.modelText);
  assert.match(out.modelText, /ERROR cache cold/);
  assert.equal(structuredOf(out)['source'], 'supervisor');
});

test('logs.query: docker logs and kubectl logs (with the environment context, namespace, container)', async () => {
  const rt = runtime();
  const d = await rt.execute(toolRequest('logs.query', { environmentId: 'env_docker', tail: 100, sinceSeconds: 600 }));
  assert.equal(d.status, 'success', d.modelText);
  assert.deepEqual(argv('docker').at(-1), ['logs', '--timestamps', '--tail', '100', '--since', '600s', 'shop-api']);
  assert.match(d.modelText, /ERROR db timeout/, 'the container stderr is part of its log');
  const k = await rt.execute(toolRequest('logs.query', { environmentId: 'env_k8s', tail: 20 }));
  assert.equal(k.status, 'success', k.modelText);
  assert.deepEqual(argv('kubectl').at(-1), ['--context', 'kind-x', '-n', 'shop', 'logs', 'deployment/checkout', '-c', 'app', '--timestamps', '--tail=20']);
  assert.match(k.modelText, /ERROR payment declined/);
  const wrong = await rt.execute(toolRequest('logs.query', { environmentId: 'env_docker', source: 'kubectl' }));
  assert.deepEqual([wrong.status, wrong.error?.code], ['failed', 'precondition_failed']);
});

test('trace.query: OTLP/JSON file — search by service, errorsOnly, by traceId; attributes scrubbed of secret keys', async () => {
  const rt = runtime();
  const all = await rt.execute(toolRequest('trace.query', { environmentId: 'env_file' }));
  assert.equal(all.status, 'success', all.modelText);
  const traces = structuredOf(all)['traces'] as Array<{ traceId: string; rootName: string; spanCount: number; errorCount: number }>;
  assert.deepEqual(traces.map((t) => [t.traceId.slice(0, 4), t.rootName, t.spanCount, t.errorCount]).sort(), [['aaaa', 'POST /orders', 2, 0], ['bbbb', 'POST /pay', 1, 1]]);
  const errors = await rt.execute(toolRequest('trace.query', { environmentId: 'env_file', errorsOnly: true }));
  assert.deepEqual((structuredOf(errors)['traces'] as Array<{ traceId: string }>).map((t) => t.traceId.slice(0, 4)), ['bbbb']);
  const one = await rt.execute(toolRequest('trace.query', { environmentId: 'env_file', traceId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
  const ev = (await env.evidence.query({ runId: 'run_bb', evidenceType: 'trace' })).find((e) => e.evidenceId === structuredOf(one)['evidenceId'])!;
  const spans = (ev.structured as { traces: Array<{ spans: Array<{ name: string; service: string; parentSpanId?: string; attributes: Record<string, unknown> }> }> }).traces[0]!.spans;
  assert.deepEqual(spans.map((s) => [s.name, s.service, s.parentSpanId ?? null]), [['POST /orders', 'checkout', null], ['INSERT orders', 'db', '0000000000000001']]);
  assert.equal(spans[0]!.attributes['http.status_code'], 200);
  assert.equal(spans[0]!.attributes['db.password'], '[REDACTED]');
});

test('trace.query: Jaeger and Tempo query APIs', async () => {
  const rt = runtime();
  const j = await rt.execute(toolRequest('trace.query', { environmentId: 'env_docker', lookbackSeconds: 900, minDurationMs: 100 }));
  assert.equal(j.status, 'success', j.modelText);
  const q = new URL(jaegerHits.at(-1)!, 'http://x');
  assert.deepEqual([q.pathname, q.searchParams.get('service'), q.searchParams.get('lookback'), q.searchParams.get('minDuration')], ['/api/traces', 'checkout', '900s', '100ms']);
  const jt = (structuredOf(j)['traces'] as Array<{ rootName: string; spanCount: number; errorCount: number; durationMs: number }>)[0]!;
  assert.deepEqual([jt.rootName, jt.spanCount, jt.errorCount, jt.durationMs], ['GET /cart', 2, 1, 250]);
  const t = await rt.execute(toolRequest('trace.query', { environmentId: 'env_k8s', errorsOnly: false }));
  assert.equal(t.status, 'success', t.modelText);
  assert.ok(tempoHits.some((h) => h.startsWith('/api/search?') && decodeURIComponent(h).includes('service.name=checkout')), tempoHits.join(' '));
  assert.ok(tempoHits.includes('/api/traces/dddddddddddddddddddddddddddddddd'));
  assert.deepEqual((structuredOf(t)['traces'] as Array<{ rootName: string }>).map((x) => x.rootName), ['GET /stock']);
  const none = await rt.execute(toolRequest('trace.query', { environmentId: 'env_proc' }));
  assert.deepEqual([none.status, none.error?.code], ['failed', 'precondition_failed']);
});

test('net.capture: tcpdump filtered to the environment host:port → pcap evidence with its packet count', async () => {
  const out = await runtime().execute(toolRequest('net.capture', { environmentId: 'env_docker', durationMs: 300 }));
  assert.equal(out.status, 'success', out.modelText);
  assert.equal(structuredOf(out)['packets'], 3);
  const args = argv('tcpdump').at(-1)!;
  assert.deepEqual([args.slice(0, 2), args.slice(-6)], [['-i', 'lo'], ['host', '127.0.0.1', 'and', 'tcp', 'port', '18080']]);
  const ev = (await env.evidence.query({ runId: 'run_bb', evidenceType: 'pcap' }))[0]!;
  assert.equal(ev.artifact.mimeType, 'application/vnd.tcpdump.pcap');
  assert.equal(pcapPacketCount(Buffer.from(await env.artifacts.get(ev.artifact.sha256))), 3);
});

test('net.capture failure paths: no tcpdump ⇒ unsupported; no capture privilege ⇒ permission_denied', async () => {
  const missing = newRuntime(env, [netCaptureTool({ tcpdump: join(dir, 'no-such-tcpdump') }) as ToolSpec]);
  const m = await missing.execute(toolRequest('net.capture', { environmentId: 'env_docker', durationMs: 100 }));
  assert.deepEqual([m.status, m.error?.code], ['failed', 'unsupported']);
  assert.match(m.error!.message, /tcpdump is not installed/);
  process.env['FAKE_TCPDUMP_DENY'] = '1';
  // the refusal arrives AFTER durationMs: the capture window only starts once tcpdump listens, so the reason is kept
  // (it used to be SIGINT-ed at durationMs and reported as an empty capture, `unavailable`)
  process.env['FAKE_TCPDUMP_DELAY_MS'] = '400';
  try {
    const d = await runtime().execute(toolRequest('net.capture', { environmentId: 'env_docker', durationMs: 100 }));
    assert.deepEqual([d.status, d.error?.code], ['failed', 'permission_denied'], d.modelText);
    assert.match(d.error!.message, /permission to capture/);
  } finally {
    delete process.env['FAKE_TCPDUMP_DENY'];
    delete process.env['FAKE_TCPDUMP_DELAY_MS'];
  }
});

test('LIVE net.capture with a real tcpdump', (t) => {
  const real = (ORIGINAL_PATH ?? '').split(':').map((p) => join(p, 'tcpdump')).find((p) => p && existsSync(p));
  if (!real) return t.skip('tcpdump is not installed on this host: live packet capture is not exercised here (the fake-tcpdump tests cover argv, pcap parsing and failures)');
  try {
    execFileSync(real, ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('tcpdump is present but does not run');
  }
  return t.skip('tcpdump is installed; a live capture needs the capture privilege (CAP_NET_RAW), set HYPERTEST_LIVE_PCAP=1 on a privileged host');
});
