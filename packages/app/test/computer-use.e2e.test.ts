/**
 * (row 246: Computer Use) The vision/GUI tester using computer use in a real run of the production composition (PGlite,
 * or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres) against a LIVE desktop: Xvfb with a Chromium kiosk window showing a
 * kiosk page (skipped with the reason when Xvfb or Chromium is missing — live desktop deferred on such hosts).
 * `tools.computerUse` (backend x11) offers computer.* to vision_gui and grants it the desktop; the agent screenshots the
 * desktop, defines its experiment, clicks the page's button by pixel coordinates (a ledgered external effect with
 * ui-action + screenshot evidence) and confirms the effect on the kiosk's API. The QualityGate judges the API evidence.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { x11Backend } from '@hypertest/tools';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, type HypertestConfig, type HypertestConfigInput } from '../src/index.ts';
import { FULL_ROUTE, call, evidenceIds, roleRouter, testStore, type RoleBrain } from './helpers.ts';

const CHROMIUM = process.env['HYPERTEST_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const DISPLAY = `:${50 + (process.pid % 19)}`;
const OBJECTIVE = { objectiveId: 'obj-kiosk', description: 'The kiosk order button places an order.', priority: 'P1', acceptanceCriteria: ['api evidence after a real click'] };
const KIOSK_ORACLE = {
  oracleId: 'kiosk',
  scope: { components: ['kiosk'], description: 'pressing Order places exactly one order' },
  assertions: [{ assertionId: 'one-order', description: 'one order after one press', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'GET', path: '/status', expectStatus: 200, expectBodyContains: '"orders":1' } }],
  judgePolicy: { independentReviewerRequired: false },
  establishedBy: 'alice',
} as const;

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'kiosk', name: 'kiosk UI', kind: 'ui', paths: [] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'The kiosk is only reachable on its desktop: computer use, confirmed on the API.', objectives: [OBJECTIVE],
        workItems: [{ localId: 'kiosk', title: 'Press Order on the kiosk', objective: 'Press the Order button on the kiosk desktop and confirm the order on environment kiosk-env.', role: 'vision_gui', dependsOn: [], objectiveIds: ['obj-kiosk'], evidenceRequirements: [{ evidenceType: 'screenshot', minCount: 1, critical: true }] }],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-kiosk', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'api-response' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'Pressed and confirmed.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'ready', evidenceRefs: ev.slice(0, 1), output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-kiosk', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] } });
};

function visionGui(results: Array<{ name: string; content: string; isError: boolean }>): RoleBrain {
  return (v) => {
    const last = v.toolResults.at(-1);
    if (last) results.push(last);
    const ids = (i: number) => evidenceIds(v.toolResults[i]?.content ?? '');
    switch (v.step) {
      case 0: return call('computer.screenshot', {});
      case 1: return call('experiment.define', { hypothesis: 'pressing Order places one order', environmentId: 'kiosk-env', isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'screenshot', minCount: 1 }] });
      case 2: return call('computer.click', { x: 400, y: 140 });
      case 3: return call('http.request', { method: 'GET', environmentId: 'kiosk-env', path: '/status', expectJson: true });
      default: return call('complete_work', {
        summary: 'Order pressed on the desktop; the API shows one order.', evidenceRefs: [...ids(0), ...ids(2), ...ids(3)],
        output: {
          summary: 'order placed',
          checks: [
            { check: 'pressing Order records an order', method: 'api', outcome: 'passed', expected: 'orders 1', actual: 'orders 1', evidenceIds: ids(3) },
            { check: 'the button is on screen before the press', method: 'visual', outcome: 'passed', expected: 'Order button', actual: 'Order button', evidenceIds: ids(0) },
          ],
          findings: [], screenshots: [...ids(0), ...ids(2)].filter((x, i, a) => a.indexOf(x) === i),
        },
      });
    }
  };
}

describe('computer use in a real run on a live desktop (Xvfb + Chromium kiosk)', () => {
  let skip: string | undefined;
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let xvfb: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let server: Server | undefined;
  let profile: string | undefined;
  let kioskUrl = '';
  let orders = 0;
  let ready = false;

  before(async () => {
    dir = await tempDir('ht-app-computer-');
    db = await testStore();
    const has = (bin: string) => (process.env['PATH'] ?? '').split(':').some((d) => existsSync(join(d, bin)));
    if (!has('Xvfb')) return void (skip = 'Xvfb is not installed: the live desktop is deferred on this host');
    if (!existsSync(CHROMIUM)) return void (skip = `no Chromium at ${CHROMIUM}`);
    const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
    xvfb = spawn('Xvfb', [DISPLAY, '-ac', '-screen', '0', '800x600x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(socket)) return void (skip = `Xvfb did not create ${socket}`);
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url === '/ready') {
          ready = true;
          res.end('ok');
        } else if (req.url === '/order' && req.method === 'POST') {
          orders++;
          res.end('ok');
        } else if (req.url === '/status') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ orders }));
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<!doctype html><body style="margin:0" onload="fetch('/ready',{method:'POST'})"><button style="position:absolute;left:0;top:0;width:800px;height:280px;font-size:48px" onclick="fetch('/order',{method:'POST'})">Order</button></body>`);
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    kioskUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    profile = mkdtempSync(join(tmpdir(), 'ht-kiosk-'));
    chrome = spawn(CHROMIUM, ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-position=0,0', '--window-size=800,600', '--kiosk', `${kioskUrl}/`], { env: { ...process.env, DISPLAY }, stdio: 'ignore', detached: true });
    // the page has loaded (it says so) before the desktop is probed for its pixels (a loaded host starts Chromium slowly)
    for (let i = 0; i < 300 && !ready; i++) await new Promise((r) => setTimeout(r, 100));
    const probe = x11Backend({ display: DISPLAY });
    for (let i = 0; i < 60; i++) {
      const png = await probe.screenshot(new AbortController().signal).catch(() => undefined);
      if (png && png.byteLength > 1500) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await probe.close?.();
  });
  after(async () => {
    await killGroup(chrome);
    xvfb?.kill('SIGKILL');
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await db?.dispose();
    await dir?.cleanup();
  });

  test('vision_gui clicks the kiosk by pixel coordinates: ledgered, evidenced, judged', async (t) => {
    if (skip) return t.skip(skip);
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const c = defaultConfig({
      project: { name: 'computer-use', dataDir: dir.path },
      models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [{ routeId: 'sim-vision', provider: 'sim', model: 'v', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities, 'vision'], quality: { ...FULL_ROUTE.quality } }] },
      gate: { requireIndependentReview: false, requiredEvidence: [{ evidenceType: 'screenshot', minCount: 1 }, { evidenceType: 'api-response', minCount: 1 }] },
      observability: { logLevel: 'warn' },
      oracles: [KIOSK_ORACLE],
      environments: [{ environmentId: 'kiosk-env', environmentClass: 'local', baseUrl: kioskUrl, generation: 0 }],
      tools: { computerUse: { backend: 'x11', display: DISPLAY, displayId: 'kiosk' } },
    } as unknown as HypertestConfigInput);
    const config: HypertestConfig = db.store ? { ...c, store: db.store } : c;
    const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter({ lead, vision_gui: visionGui(results) }) }, logger: new MemoryLogger() });
    try {
      assert.ok(ht.services.roles.require('vision_gui').toolPolicy.allow.includes('computer.*'));
      const outcome = await ht.run({ goal: 'Does the kiosk place an order?', target: { environmentId: 'kiosk-env' } }, { timeoutMs: 120_000 });
      assert.deepEqual(results.filter((r) => r.isError).map((r) => r.content), []);
      assert.equal(orders, 1, 'the pixel click reached the kiosk page exactly once');
      const ops = (await ht.services.operations.list({ runId: outcome.runId })).filter((o) => o.operationType === 'computer.click');
      assert.deepEqual(ops.map((o) => o.status), ['verified']);
      const shots = await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'screenshot' });
      assert.equal(shots.length, 2, 'the screenshot before and the one after the click');
      const action = (await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'ui-action' }))[0]!;
      assert.deepEqual([(action.structured as { action: string; x: number }).action, (action.structured as { x: number }).x, action.operationId], ['click', 400, ops[0]!.operationId]);
      assert.equal(outcome.decision?.verdict, 'pass', JSON.stringify(outcome.decision?.reasons));
    } finally {
      await ht.close();
    }
  });
});

/** (review) Kills a detached process and its whole process group (Chromium's children), and waits for it to exit. */
async function killGroup(child: import('node:child_process').ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000).unref())]);
}
