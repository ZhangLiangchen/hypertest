import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import type { DomainEvent, RuntimeManifest, TestRun } from '@hypertest/domain';
import type { ApprovalRequest } from '@hypertest/policy';
import type { RunReport, StartRunInput } from '@hypertest/control';
import { isLoopbackHost, startApiServer, type ApiServer, type Hypertest } from '../src/index.ts';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json(): any;
}

function request(base: string, method: string, path: string, options: { body?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function run(runId: string, status: TestRun['status'] = 'running'): TestRun {
  return { runId, goal: 'g', target: {}, status, budget: {}, runtimeManifestId: 'rm_x', policyRevision: 'p', currentPlanRevision: 0, oracleRevisions: {}, experimentIds: [], labels: {}, createdAt: 't', updatedAt: 't' } as unknown as TestRun;
}

function event(seq: number, eventType: string): DomainEvent<unknown> {
  return { eventId: `evt_${seq}`, seq, eventType, runId: 'run_1', payload: { n: seq } } as unknown as DomainEvent<unknown>;
}

/** An in-memory Hypertest facade recording every call. */
function fakeHypertest() {
  const calls: Array<[string, unknown[]]> = [];
  const runs = new Map<string, TestRun>([['run_1', run('run_1')]]);
  const events: DomainEvent<unknown>[] = [event(1, 'run.created'), event(2, 'work.created')];
  let startError: unknown;
  let reportError: unknown;
  const ht: Hypertest & { calls: typeof calls; runs: typeof runs; eventLog: typeof events; failStart(e: unknown): void; failReport(e: unknown): void } = {
    calls,
    runs,
    eventLog: events,
    failStart: (e) => (startError = e),
    failReport: (e) => (reportError = e),
    config: {} as Hypertest['config'],
    control: {} as Hypertest['control'],
    durable: { kind: 'local' } as Hypertest['durable'],
    manifest: { manifestId: 'rm_fake' } as RuntimeManifest,
    async start(input: StartRunInput) {
      calls.push(['start', [input]]);
      if (startError) throw startError;
      const r = run('run_2');
      runs.set('run_2', r);
      return r;
    },
    async run() {
      throw new Error('unused');
    },
    async resumeIncomplete() {
      return [];
    },
    async status(runId: string) {
      return runs.get(runId);
    },
    async report(runId: string) {
      calls.push(['report', [runId]]);
      if (reportError) throw reportError;
      return { runId, verdict: 'pass', markdown: '# Report run_1\n' } as unknown as RunReport;
    },
    async verifyEvidence(runId: string) {
      calls.push(['verifyEvidence', [runId]]);
      return { ok: false, problems: ['chain_break ev_9: tampered'] };
    },
    async approve(...args: unknown[]) {
      calls.push(['approve', args]);
      if (args[0] === 'apr_missing') throw new HypertestError('not_found', 'approval apr_missing not found');
    },
    async decideOracleProposal(...args: unknown[]) {
      calls.push(['decideOracleProposal', args]);
    },
    async close() {},
    async listRuns(filter?: unknown) {
      calls.push(['listRuns', [filter]]);
      return [...runs.values()];
    },
    async events(runId: string, options: { afterSeq?: number; limit?: number } = {}) {
      return events.filter((e) => e.runId === runId && (e.seq ?? 0) > (options.afterSeq ?? 0)).slice(0, options.limit ?? 500);
    },
    async listApprovals(filter?: unknown) {
      calls.push(['listApprovals', [filter]]);
      return [{ approvalId: 'apr_1', status: 'pending' } as ApprovalRequest];
    },
    async cancel(...args: unknown[]) {
      calls.push(['cancel', args]);
    },
  };
  return ht;
}

describe('REST API (fake facade)', () => {
  let ht: ReturnType<typeof fakeHypertest>;
  let api: ApiServer;
  before(async () => {
    ht = fakeHypertest();
    api = await startApiServer(ht, { port: 0, eventPollMs: 20, maxBodyBytes: 2048 });
  });
  after(async () => api.close());

  test('binds loopback by default; GET /health reports the pinned manifest', async () => {
    assert.match(api.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await request(api.url, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, manifestId: 'rm_fake', durable: 'local' });
  });

  test('POST /runs starts a run (202) with exactly the validated input', async () => {
    const input = { goal: 'assess', target: { repoPath: '/repo', commit: 'abc' }, budget: { maxToolCalls: 10 }, labels: { team: 'qa' }, oracleIds: ['oracle.x'] };
    const r = await request(api.url, 'POST', '/runs', json(input));
    assert.equal(r.status, 202);
    assert.equal(r.json().run.runId, 'run_2');
    assert.deepEqual(ht.calls.findLast((c) => c[0] === 'start')![1], [input]);
  });

  test('POST /runs failures: invalid fields (400), wrong media type (415), bad JSON (400), oversized body (413), refused start (409)', async () => {
    const before = ht.calls.filter((c) => c[0] === 'start').length;
    let r = await request(api.url, 'POST', '/runs', json({ target: {} }));
    assert.deepEqual([r.status, r.json()], [400, { error: { code: 'invalid_argument', message: 'goal must be a non-empty string' } }]);
    r = await request(api.url, 'POST', '/runs', json({ goal: 'g', target: {}, sneaky: 1 }));
    assert.deepEqual([r.status, r.json().error.message], [400, "unknown field 'sneaky'"]);
    r = await request(api.url, 'POST', '/runs', json({ goal: 'g', target: 'x' }));
    assert.deepEqual([r.status, r.json().error.message], [400, 'target must be an object']);
    r = await request(api.url, 'POST', '/runs', { body: 'goal=g', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.deepEqual([r.status, r.json().error.code], [415, 'unsupported_media_type']);
    r = await request(api.url, 'POST', '/runs', { body: '{nope', headers: { 'content-type': 'application/json' } });
    assert.deepEqual([r.status, r.json().error.code], [400, 'invalid_json']);
    r = await request(api.url, 'POST', '/runs', json({ goal: 'x'.repeat(4096), target: {} }));
    assert.deepEqual([r.status, r.json().error.code], [413, 'payload_too_large']);
    assert.equal(ht.calls.filter((c) => c[0] === 'start').length, before, 'no invalid request reached start()');
    ht.failStart(new HypertestError('precondition_failed', 'no model routes are configured'));
    r = await request(api.url, 'POST', '/runs', json({ goal: 'g', target: {} }));
    ht.failStart(undefined);
    assert.deepEqual([r.status, r.json()], [409, { error: { code: 'precondition_failed', message: 'no model routes are configured' } }]);
  });

  test('GET /runs (filters), GET /runs/:id (404 for unknown ids)', async () => {
    let r = await request(api.url, 'GET', '/runs?status=running,paused&limit=5');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().runs.map((x: TestRun) => x.runId).sort(), ['run_1', 'run_2']);
    assert.deepEqual(ht.calls.findLast((c) => c[0] === 'listRuns')![1], [{ status: ['running', 'paused'], limit: 5 }]);
    r = await request(api.url, 'GET', '/runs?limit=0');
    assert.deepEqual([r.status, r.json().error.message], [400, 'limit must be an integer ≥ 1']);
    r = await request(api.url, 'GET', '/runs/run_1');
    assert.deepEqual([r.status, r.json().run.runId], [200, 'run_1']);
    r = await request(api.url, 'GET', '/runs/run_nope');
    assert.deepEqual([r.status, r.json()], [404, { error: { code: 'not_found', message: 'run run_nope not found' } }]);
  });

  test('report (JSON or markdown), evidence verification, cancellation', async () => {
    let r = await request(api.url, 'GET', '/runs/run_1/report');
    assert.deepEqual([r.status, r.json().verdict], [200, 'pass']);
    r = await request(api.url, 'GET', '/runs/run_1/report?format=markdown');
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /^text\/markdown/);
    assert.equal(r.text, '# Report run_1\n');
    r = await request(api.url, 'GET', '/runs/run_1/evidence/verify');
    assert.deepEqual([r.status, r.json()], [200, { ok: false, problems: ['chain_break ev_9: tampered'] }]);
    r = await request(api.url, 'POST', '/runs/run_1/cancel', json({ reason: 'operator abort' }));
    assert.deepEqual([r.status, r.json()], [200, { ok: true }]);
    assert.deepEqual(ht.calls.findLast((c) => c[0] === 'cancel')![1], ['run_1', 'operator abort']);
    r = await request(api.url, 'POST', '/runs/run_1/cancel', json({}));
    assert.deepEqual([r.status, r.json().error.message], [400, 'reason must be a non-empty string']);
  });

  test('without a token, human decisions are refused (403) and never reach the facade: loopback is not a trust boundary', async () => {
    const before = ht.calls.filter((c) => c[0] === 'approve' || c[0] === 'decideOracleProposal').length;
    for (const path of ['/approvals/apr_1', '/oracle-proposals/ocp_1']) {
      const r = await request(api.url, 'POST', path, json({ approve: true, by: 'qa-lead', rationale: 'posted by code under test' }));
      assert.deepEqual([r.status, r.json().error.code], [403, 'token_required'], path);
    }
    assert.equal(ht.calls.filter((c) => c[0] === 'approve' || c[0] === 'decideOracleProposal').length, before);
    // reads, starting and cancelling runs stay available on the loopback listener
    const r = await request(api.url, 'GET', '/approvals?runId=run_1&status=pending');
    assert.deepEqual([r.status, r.json().approvals.length], [200, 1]);
    assert.deepEqual(ht.calls.findLast((c) => c[0] === 'listApprovals')![1], [{ runId: 'run_1', status: ['pending'] }]);
  });

  test('with a token, approvals and oracle proposals are decided by a named human; malformed decisions are refused', async () => {
    const TOKEN = 'operator-token-0123456789';
    const tokenApi = await startApiServer(ht, { port: 0, token: TOKEN });
    const auth = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
    try {
    let r = await request(tokenApi.url, 'POST', '/approvals/apr_1', auth({ approve: true, by: 'alice', rationale: 'reviewed the diff' }));
    assert.deepEqual([r.status, r.json()], [200, { ok: true }]);
    assert.deepEqual(ht.calls.findLast((c) => c[0] === 'approve')![1], ['apr_1', true, { kind: 'human', id: 'alice' }, 'reviewed the diff']);
    r = await request(tokenApi.url, 'POST', '/approvals/apr_1', auth({ approve: 'yes', by: 'alice', rationale: 'x' }));
    assert.deepEqual([r.status, r.json().error.message], [400, 'approve must be a boolean']);
    r = await request(tokenApi.url, 'POST', '/approvals/apr_1', auth({ approve: false, rationale: 'x' }));
    assert.deepEqual([r.status, r.json().error.message], [400, 'by must be a non-empty string']);
    r = await request(tokenApi.url, 'POST', '/approvals/apr_missing', auth({ approve: false, by: 'bob', rationale: 'no' }));
    assert.deepEqual([r.status, r.json().error.code], [404, 'not_found']);
    r = await request(tokenApi.url, 'POST', '/oracle-proposals/ocp_1', auth({ approve: false, by: 'carol', rationale: 'weakens REQ-7' }));
    assert.deepEqual([r.status, r.json()], [200, { ok: true }]);
    assert.deepEqual(ht.calls.findLast((c) => c[0] === 'decideOracleProposal')![1], ['ocp_1', false, { kind: 'human', id: 'carol' }, 'weakens REQ-7']);
    r = await request(tokenApi.url, 'POST', '/oracle-proposals/ocp_1', json({ approve: true, by: 'mallory', rationale: 'no token' }));
    assert.deepEqual([r.status, r.json().error.code], [401, 'unauthenticated']);
    } finally {
      await tokenApi.close();
    }
  });

  test('routing errors: 405 with Allow, 404 for unknown paths, 403 for a foreign Host header (DNS rebinding), 500 hides internals', async () => {
    let r = await request(api.url, 'DELETE', '/runs/run_1');
    assert.deepEqual([r.status, r.headers['allow'], r.json().error.code], [405, 'GET', 'method_not_allowed']);
    r = await request(api.url, 'GET', '/nowhere');
    assert.deepEqual([r.status, r.json().error.code], [404, 'not_found']);
    r = await request(api.url, 'GET', '/runs/%E0%A4%A');
    assert.deepEqual([r.status, r.json()], [400, { error: { code: 'invalid_argument', message: 'malformed percent-encoding in the request path' } }]);
    r = await request(api.url, 'GET', '/health', { headers: { host: 'evil.example:80' } });
    assert.deepEqual([r.status, r.json().error.code], [403, 'forbidden_host']);
    ht.failReport(new Error('db password is hunter2'));
    r = await request(api.url, 'GET', '/runs/run_1/report');
    ht.failReport(undefined);
    assert.deepEqual([r.status, r.json()], [500, { error: { code: 'internal', message: 'internal error' } }]);
  });

  test('GET /runs/:id/events streams L0 events as SSE from afterSeq / Last-Event-ID and ends when the run is terminal', async () => {
    ht.runs.set('run_1', run('run_1', 'running'));
    const lines: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const url = new URL('/runs/run_1/events?afterSeq=1', api.url);
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type']), /^text\/event-stream/);
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            lines.push(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
          if (lines.length === 2) {
            // a new event arrives while streaming, then the run ends
            ht.eventLog.push(event(3, 'run.completed'));
            ht.runs.set('run_1', run('run_1', 'completed'));
          }
        });
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    await done;
    assert.equal(lines[0], ': hypertest event stream');
    assert.equal(lines[1], `id: 2\nevent: work.created\ndata: ${JSON.stringify(event(2, 'work.created'))}`);
    assert.equal(lines[2], `id: 3\nevent: run.completed\ndata: ${JSON.stringify(event(3, 'run.completed'))}`);
    assert.equal(lines[3], `event: end\ndata: ${JSON.stringify({ runId: 'run_1', status: 'completed', lastSeq: 3 })}`);
    assert.equal(lines.length, 4);
    // Last-Event-ID resumes after the last seen event; an unknown run is a JSON 404, not a stream
    const resumed = await request(api.url, 'GET', '/runs/run_1/events', { headers: { 'last-event-id': '3' } });
    assert.equal(resumed.text, `: hypertest event stream\n\nevent: end\ndata: ${JSON.stringify({ runId: 'run_1', status: 'completed', lastSeq: 3 })}\n\n`);
    const missing = await request(api.url, 'GET', '/runs/run_x/events');
    assert.deepEqual([missing.status, missing.json().error.code], [404, 'not_found']);
  });
});

describe('REST API security and lifecycle', () => {
  test('a non-loopback host requires a token; a token (≥ 16 chars) is required as a bearer on every request', async () => {
    const ht = fakeHypertest();
    await assert.rejects(startApiServer(ht, { port: 0, host: '0.0.0.0' }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /without a token/.test(e.message));
    await assert.rejects(startApiServer(ht, { port: 0, token: 'short' }), (e: unknown) => e instanceof HypertestError && /at least 16 characters/.test(e.message));
    const api = await startApiServer(ht, { port: 0, token: 'correct-horse-battery-staple' });
    try {
      let r = await request(api.url, 'GET', '/health');
      assert.deepEqual([r.status, r.json().error.code], [401, 'unauthenticated']);
      r = await request(api.url, 'GET', '/health', { headers: { authorization: 'Bearer correct-horse-battery-stapl3' } });
      assert.equal(r.status, 401);
      r = await request(api.url, 'GET', '/health', { headers: { authorization: 'Bearer correct-horse-battery-staple' } });
      assert.equal(r.status, 200);
    } finally {
      await api.close();
    }
    assert.equal(isLoopbackHost('127.0.0.2'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('10.0.0.1'), false);
  });

  test('SSE: the final events committed with the terminal status are never overtaken by `end`', async () => {
    const ht = fakeHypertest();
    const read = ht.events!.bind(ht);
    let commitDuringRead = true;
    ht.events = async (runId, options) => {
      const batch = await read(runId, options);
      if (commitDuringRead && (options?.afterSeq ?? 0) >= 2) {
        // the run's last transaction commits right after this read returned: its events and the terminal status together
        commitDuringRead = false;
        ht.eventLog.push(event(3, 'gate.evaluated'), event(4, 'run.completed'));
        ht.runs.set('run_1', run('run_1', 'completed'));
      }
      return batch;
    };
    const api = await startApiServer(ht, { port: 0, eventPollMs: 5 });
    try {
      const r = await request(api.url, 'GET', '/runs/run_1/events?afterSeq=2');
      const frames = r.text.split('\n\n').filter(Boolean);
      assert.deepEqual(frames, [
        ': hypertest event stream',
        `id: 3\nevent: gate.evaluated\ndata: ${JSON.stringify(event(3, 'gate.evaluated'))}`,
        `id: 4\nevent: run.completed\ndata: ${JSON.stringify(event(4, 'run.completed'))}`,
        `event: end\ndata: ${JSON.stringify({ runId: 'run_1', status: 'completed', lastSeq: 4 })}`,
      ]);
    } finally {
      await api.close();
    }
  });

  test('a client that disconnects mid-stream stops the server-side polling', async () => {
    const ht = fakeHypertest();
    let reads = 0;
    const read = ht.events!.bind(ht);
    ht.events = async (runId, options) => {
      reads++;
      return read(runId, options);
    };
    const api = await startApiServer(ht, { port: 0, eventPollMs: 10 });
    try {
      await new Promise<void>((resolve, reject) => {
        const url = new URL('/runs/run_1/events', api.url);
        const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => undefined);
        req.once('socket', (sock) => sock.once('error', reject));
        req.end();
      });
      await new Promise((r) => setTimeout(r, 100));
      const settled = reads;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(reads, settled, 'no polls after the client went away');
      assert.ok(settled >= 1);
    } finally {
      await api.close();
    }
  });

  test('a facade without the optional listing methods answers 501; close() ends open event streams', async () => {
    const ht = fakeHypertest() as Partial<ReturnType<typeof fakeHypertest>>;
    delete ht.listRuns;
    const api = await startApiServer(ht as Hypertest, { port: 0, eventPollMs: 10 });
    const r = await request(api.url, 'GET', '/runs');
    assert.deepEqual([r.status, r.json().error.code], [501, 'not_implemented']);
    const streamEnded = new Promise<void>((resolve, reject) => {
      const url = new URL('/runs/run_1/events', api.url);
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        res.once('data', () => void api.close());
        res.on('end', resolve);
        res.on('error', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    await streamEnded;
    await api.close();
  });
});

describe('REST API: model operations (A[0] resume, A[3] model switch, A[4] agent inspection)', () => {
  const TOKEN = 'operator-token-0123456789';
  function opsFacade() {
    const ht = fakeHypertest();
    return Object.assign(ht, {
      async resume(runId: string) {
        ht.calls.push(['resume', [runId]]);
        return { releasedPauses: 2 };
      },
      async agents(runId: string) {
        ht.calls.push(['agents', [runId]]);
        return [{ agentId: 'ag_1', role: 'lead', engine: { state: 'running' }, modelPause: null }];
      },
      async requestModelSwitch(...args: unknown[]) {
        ht.calls.push(['requestModelSwitch', args]);
        if (args[2] === 'ghost') throw new HypertestError('invalid_argument', 'route ghost is not in the model catalog (main, backup)');
        return { switchId: 'msw_1', runId: args[0], target: { kind: 'role', role: args[1] }, routeId: args[2], requestedBy: 'human:alice' };
      },
    });
  }

  test('POST /runs/:id/resume (an operator decision: token) releases the model pauses; GET /runs/:id/agents lists the inspected agents; unknown runs are 404', async () => {
    const ht = opsFacade();
    // without a token an agent reaching the loopback API could un-pause a run an operator or the budget paused (I1)
    const open = await startApiServer(ht as unknown as Hypertest, { port: 0 });
    try {
      const r = await request(open.url, 'POST', '/runs/run_1/resume', json({}));
      assert.deepEqual([r.status, r.json().error.code], [403, 'token_required']);
      assert.equal(ht.calls.filter((c) => c[0] === 'resume').length, 0, 'never reached the facade');
      const agents = await request(open.url, 'GET', '/runs/run_1/agents');
      assert.deepEqual([agents.status, agents.json().agents.map((a: { agentId: string }) => a.agentId)], [200, ['ag_1']], 'reading the agents needs no decision token');
    } finally {
      await open.close();
    }
    const api = await startApiServer(ht as unknown as Hypertest, { port: 0, token: TOKEN });
    const auth = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
    try {
      let r = await request(api.url, 'POST', '/runs/run_1/resume', auth({}));
      assert.deepEqual([r.status, r.json()], [200, { ok: true, releasedPauses: 2 }]);
      assert.deepEqual(ht.calls.findLast((c) => c[0] === 'resume')![1], ['run_1']);
      r = await request(api.url, 'POST', '/runs/run_nope/resume', auth({}));
      assert.deepEqual([r.status, r.json().error.code], [404, 'not_found']);
      r = await request(api.url, 'POST', '/runs/run_1/resume', json({}));
      assert.deepEqual([r.status, r.json().error.code], [401, 'unauthenticated']);
      r = await request(api.url, 'GET', '/runs/run_1/resume', { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.deepEqual([r.status, r.headers['allow']], [405, 'POST']);
    } finally {
      await api.close();
    }
  });

  test('POST /runs/:id/model-switch is an operator decision: refused without the token (never reaches the facade), validated with it', async () => {
    const ht = opsFacade();
    const open = await startApiServer(ht as unknown as Hypertest, { port: 0 });
    try {
      const r = await request(open.url, 'POST', '/runs/run_1/model-switch', json({ target: 'executor', routeId: 'backup', by: 'agent' }));
      assert.deepEqual([r.status, r.json().error.code], [403, 'token_required']);
      assert.equal(ht.calls.filter((c) => c[0] === 'requestModelSwitch').length, 0);
    } finally {
      await open.close();
    }
    const api = await startApiServer(ht as unknown as Hypertest, { port: 0, token: TOKEN });
    const auth = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
    try {
      let r = await request(api.url, 'POST', '/runs/run_1/model-switch', auth({ target: 'executor', routeId: 'backup', by: 'alice', reason: 'degraded' }));
      assert.deepEqual([r.status, r.json().switch.switchId], [200, 'msw_1']);
      assert.deepEqual(ht.calls.findLast((c) => c[0] === 'requestModelSwitch')![1], ['run_1', 'executor', 'backup', { kind: 'human', id: 'alice' }, 'degraded']);
      r = await request(api.url, 'POST', '/runs/run_1/model-switch', auth({ target: 'executor', routeId: 'backup', by: 'alice', force: true }));
      assert.deepEqual([r.status, r.json().error.message], [400, "unknown field 'force'"]);
      r = await request(api.url, 'POST', '/runs/run_1/model-switch', auth({ target: 'executor', routeId: 'backup' }));
      assert.deepEqual([r.status, r.json().error.message], [400, 'by must be a non-empty string']);
      r = await request(api.url, 'POST', '/runs/run_1/model-switch', auth({ target: 'executor', routeId: 'ghost', by: 'alice' }));
      assert.deepEqual([r.status, r.json().error], [400, { code: 'invalid_argument', message: 'route ghost is not in the model catalog (main, backup)' }]);
      r = await request(api.url, 'POST', '/runs/run_nope/model-switch', auth({ target: 'executor', routeId: 'backup', by: 'alice' }));
      assert.deepEqual([r.status, r.json().error.code], [404, 'not_found']);
      r = await request(api.url, 'POST', '/runs/run_1/model-switch', json({ target: 'executor', routeId: 'backup', by: 'mallory' }));
      assert.deepEqual([r.status, r.json().error.code], [401, 'unauthenticated']);
    } finally {
      await api.close();
    }
  });
});
