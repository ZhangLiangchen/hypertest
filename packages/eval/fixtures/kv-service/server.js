// kv-service — PoC C system under test (node:http, no dependencies). Runs under the Hypertest process supervisor,
// which gives it a private $PORT and proxies the public URL to it.
//
//   GET  /kv/:key      → 200 {key, value} | 404 {error}
//   PUT  /kv/:key      → 200 {key, value}  (body = the value, text)
//   GET  /health       → 200 {status, keys, uptimeMs}
//   GET  /metrics      → Prometheus text: kv_requests_total{method,status} counter and the
//                        kv_request_duration_seconds histogram (every /kv request)
//
// Every /kv request takes a small random latency (1..KV_MAX_LATENCY_MS ms, default 6). KV_WARMUP_MS (default 0) delays
// the listen after a (re)start, so a restart stays in flight long enough for a chaos kill to land in it.
// KV_WRITE_LOG (optional, an absolute path): every PUT is appended as a JSON line {key, value, idempotencyKey, pid,
// startedAt, at} — the environment's own record of the writes it served (eval ground truth; the store is in memory, so a
// restart loses it).
// KV_SLOW_EVERY / KV_SLOW_MS / KV_SLOW_KEY (optional): a seeded latency anomaly — every KV_SLOW_EVERY-th GET of key
// KV_SLOW_KEY (default k1) takes KV_SLOW_MS more (the hot-key regression of the PoC C anomaly and performance suites).
// KV_SLOW_PUT_MS (optional): a PUT is APPLIED (and logged) at once but answered only after this delay — a client that dies
// meanwhile cannot know whether its write landed (the unqueryable-target chaos case).
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const MAX_LATENCY_MS = Math.max(1, Number(process.env.KV_MAX_LATENCY_MS ?? 6));
const WRITE_LOG = process.env.KV_WRITE_LOG;
const WARMUP_MS = Math.max(0, Number(process.env.KV_WARMUP_MS ?? 0));
const SLOW_EVERY = Math.max(0, Number(process.env.KV_SLOW_EVERY ?? 0));
const SLOW_MS = Math.max(0, Number(process.env.KV_SLOW_MS ?? 0));
const SLOW_KEY = process.env.KV_SLOW_KEY ?? 'k1';
const SLOW_PUT_MS = Math.max(0, Number(process.env.KV_SLOW_PUT_MS ?? 0));
let slowCount = 0;
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];
const started = Date.now();
const store = new Map([['k1', 'v1'], ['k2', 'v2']]);
const counts = new Map();
const bucketCounts = new Array(BUCKETS.length).fill(0);
let durationSum = 0;
let durationCount = 0;

function observe(method, status, seconds) {
  const key = `${method} ${status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) bucketCounts[i]++;
  durationSum += seconds;
  durationCount++;
}

function metrics() {
  const lines = ['# HELP kv_requests_total Key-value requests served.', '# TYPE kv_requests_total counter'];
  for (const [key, n] of [...counts].sort()) {
    const [method, status] = key.split(' ');
    lines.push(`kv_requests_total{method="${method}",status="${status}"} ${n}`);
  }
  lines.push('# HELP kv_request_duration_seconds Latency of key-value requests.', '# TYPE kv_request_duration_seconds histogram');
  for (let i = 0; i < BUCKETS.length; i++) lines.push(`kv_request_duration_seconds_bucket{le="${BUCKETS[i]}"} ${bucketCounts[i]}`);
  lines.push(`kv_request_duration_seconds_bucket{le="+Inf"} ${durationCount}`);
  lines.push(`kv_request_duration_seconds_sum ${durationSum.toFixed(6)}`, `kv_request_duration_seconds_count ${durationCount}`);
  return `${lines.join('\n')}\n`;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', keys: store.size, uptimeMs: Date.now() - started });
  if (method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end(metrics());
  }
  const m = /^\/kv\/([A-Za-z0-9_.-]{1,128})$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'no_route' });
  const t0 = process.hrtime.bigint();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    setTimeout(() => {
      let status;
      let body;
      if (method === 'GET') {
        const value = store.get(m[1]);
        status = value === undefined ? 404 : 200;
        body = value === undefined ? { error: 'not_found', key: m[1] } : { key: m[1], value };
      } else if (method === 'PUT') {
        const value = Buffer.concat(chunks).toString('utf8');
        store.set(m[1], value);
        status = 200;
        body = { key: m[1], value };
        if (WRITE_LOG) {
          const idempotencyKey = req.headers['idempotency-key'] ?? null;
          appendFileSync(WRITE_LOG, `${JSON.stringify({ key: m[1], value, idempotencyKey, pid: process.pid, startedAt: started, at: Date.now() })}\n`);
        }
      } else {
        status = 405;
        body = { error: 'method_not_allowed' };
      }
      observe(method, status, Number(process.hrtime.bigint() - t0) / 1e9);
      if (method === 'PUT' && SLOW_PUT_MS > 0) setTimeout(() => json(res, status, body), SLOW_PUT_MS);
      else json(res, status, body);
    }, 1 + Math.floor(Math.random() * MAX_LATENCY_MS) + (method === 'GET' && SLOW_EVERY > 0 && m[1] === SLOW_KEY && ++slowCount % SLOW_EVERY === 0 ? SLOW_MS : 0));
  });
});

setTimeout(() => server.listen(Number(process.env.PORT), '127.0.0.1'), WARMUP_MS);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
