/**
 * (e2e[1], row 119) The vision/GUI tester in a real run with a real Chromium (/opt/pw-browsers/chromium, or
 * HYPERTEST_CHROMIUM_PATH; skipped with the reason when it cannot be launched) over the production composition (PGlite,
 * or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres). The scripted vision_gui agent works DOM first: it opens the shop
 * page (browser.navigate — the page load is api-response evidence), defines the experiment its interaction runs for,
 * fills the name field and clicks "Greet" (external effects, ledgered, naming the environment), reads the greeting back
 * (browser.text — dom-snapshot evidence), confirms the backend with http.request, and takes a screenshot (a PNG
 * screenshot evidence artifact). The oracle (GET / serves the shop page) is judged by the QualityGate on the browser's
 * own api-response evidence. Before the fix browser.text / click / fill / screenshot were refused at the capability check
 * (`resource_out_of_scope: browser/<session>`) and navigate recorded no evidence: the run ended inconclusive.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { BrowserSessionManager, chromiumExecutablePath } from '@hypertest/tools';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, type HypertestConfig, type HypertestConfigInput } from '../src/index.ts';
import { FULL_ROUTE, call, evidenceIds, roleRouter, testStore, type BrainView, type RoleBrain } from './helpers.ts';

const ENV_ID = 'shop-ui';
const GOAL = 'Does the shop page greet a customer by name?';

const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Welcome to the shop</h1>
<label for="name">Name</label><input id="name" />
<button id="greet">Greet</button>
<p id="out"></p>
<script>
document.getElementById('greet').addEventListener('click', async () => {
  const name = document.getElementById('name').value;
  const res = await fetch('/api/greet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  const body = await res.json();
  document.getElementById('out').textContent = body.greeting;
});
</script>
</body></html>`;

async function startShop(): Promise<{ url: string; requests: string[]; greeted: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const greeted: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/api/greet') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const { name } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { name?: string };
        greeted.push(String(name));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ greeting: `Hello ${name}` }));
      });
      return;
    }
    if (req.url === '/api/greetings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: greeted.length }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests, greeted, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const SHOP_ORACLE = {
  oracleId: 'shop-page',
  scope: { components: ['shop-ui'], description: 'the shop page is served' },
  assertions: [
    { assertionId: 'page-served', description: 'GET / serves the shop page', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'GET', path: '/', expectStatus: 200, expectBodyContains: '<title>Shop</title>' } },
  ],
  judgePolicy: { independentReviewerRequired: false },
  establishedBy: 'alice',
} as const;

const OBJECTIVE = { objectiveId: 'obj-gui', description: 'The shop page greets a customer by name.', priority: 'P1', acceptanceCriteria: ['DOM, API and screenshot evidence of the greeting'] };

function config(dataDir: string, store: HypertestConfig['store'] | undefined, sutUrl: string): HypertestConfig {
  const c = defaultConfig({
    project: { name: 'vision-gui', dataDir },
    models: {
      providers: [{ id: 'sim', kind: 'scripted' }],
      routes: [{ routeId: 'sim-vision', provider: 'sim', model: 'sim-v', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities, 'vision'], quality: { ...FULL_ROUTE.quality } }],
    },
    // a black-box GUI deployment: the gate requires the browser's own evidence (page load + screenshot), not test results
    gate: { requireIndependentReview: false, requiredEvidence: [{ evidenceType: 'api-response', minCount: 1 }, { evidenceType: 'screenshot', minCount: 1 }] },
    observability: { logLevel: 'warn' },
    oracles: [SHOP_ORACLE],
    tools: { enableBrowser: true },
    environments: [{ environmentId: ENV_ID, environmentClass: 'local', baseUrl: sutUrl, generation: 0 }],
  } as unknown as HypertestConfigInput);
  return store ? { ...c, store } : c;
}

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'shop-ui', name: 'shop page', kind: 'ui', paths: [] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'The greeting is UI behaviour: check it in the browser, DOM first.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'gui', title: 'Check the greeting in the browser', role: 'vision_gui', dependsOn: [], objectiveIds: ['obj-gui'],
            objective: `On environment ${ENV_ID}: type a name, press Greet, check the greeting in the DOM and on the API, screenshot it.`,
            evidenceRequirements: [{ evidenceType: 'screenshot', minCount: 1, critical: true }],
          },
        ],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-gui', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'screenshot' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'The GUI check ran with evidence; hand over to the gate.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', {
    summary: 'ready for the gate', evidenceRefs: ev.slice(0, 1),
    output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-gui', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] },
  });
};

/** The GUI tester: DOM first (navigate, fill, click, text), API second (http.request), pixels last (screenshot). */
function visionGui(results: Array<{ name: string; content: string; isError: boolean }>): RoleBrain {
  return (v: BrainView) => {
    const last = v.toolResults.at(-1);
    if (last) results.push(last);
    const ids = (i: number) => evidenceIds(v.toolResults[i]?.content ?? '');
    switch (v.step) {
      case 0: return call('browser.navigate', { environmentId: ENV_ID, path: '/' });
      case 1: return call('experiment.define', {
        hypothesis: 'typing a name and pressing Greet shows "Hello <name>" and records one greeting', environmentId: ENV_ID,
        isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'screenshot', minCount: 1 }],
      });
      case 2: return call('browser.fill', { selector: '#name', value: 'Ada', environmentId: ENV_ID });
      case 3: return call('browser.click', { role: 'button', name: 'Greet', environmentId: ENV_ID });
      case 4: return call('browser.text', { selector: '#out', environmentId: ENV_ID });
      case 5: return call('http.request', { method: 'GET', environmentId: ENV_ID, path: '/api/greetings', expectJson: true });
      // the audit's exact call (no environmentId): a read of the page navigate already admitted, attributed to its environment
      case 6: return call('browser.screenshot', {});
      default: {
        const [nav, dom, api, shot] = [ids(0), ids(4), ids(5), ids(6)];
        return call('complete_work', {
          summary: 'The greeting works: DOM, API and screenshot agree.', evidenceRefs: [...nav, ...dom, ...api, ...shot],
          output: {
            summary: 'greeting shown and recorded',
            checks: [
              { check: 'greeting text after Greet', method: 'dom', outcome: 'passed', expected: 'Hello Ada', actual: 'Hello Ada', evidenceIds: dom },
              { check: 'the backend recorded one greeting', method: 'api', outcome: 'passed', expected: 'count 1', actual: 'count 1', evidenceIds: api },
              { check: 'the greeting is visible', method: 'visual', outcome: 'passed', expected: 'greeting under the button', actual: 'greeting under the button', evidenceIds: shot },
            ],
            findings: [],
            screenshots: shot,
          },
        });
      }
    }
  };
}

describe('vision_gui in a real run: DOM first, API second, screenshots as evidence (real Chromium)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let shop: Awaited<ReturnType<typeof startShop>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let skipReason: string | undefined;

  before(async () => {
    dir = await tempDir('ht-app-vision-gui-');
    shop = await startShop();
    db = await testStore();
    const probe = new BrowserSessionManager({ idleTimeoutMs: 10_000 });
    try {
      await (await probe.page('probe', 'probe')).close();
    } catch (e) {
      skipReason = `chromium cannot be launched from ${chromiumExecutablePath()}: ${(e as Error).message.split('\n')[0]}`;
    } finally {
      await probe.closeAll();
    }
  });
  after(async () => {
    await db?.dispose();
    await shop?.close();
    await dir?.cleanup();
  });

  test('every browser tool is permitted under the role grant; navigate/text/screenshot record evidence; the gate judges it', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const ht = await createHypertest(config(dir.path, db.store, shop.url), { scriptedBrains: { sim: roleRouter({ lead, vision_gui: visionGui(results) }) }, logger: new MemoryLogger() });
    try {
      const outcome = await ht.run({ goal: GOAL, target: { environmentId: ENV_ID } }, { timeoutMs: 180_000 });
      const denied = await ht.events(outcome.runId, { types: ['tool.denied'] });
      assert.deepEqual(denied.map((e) => e.payload), [], 'no browser (or other) call was denied');
      assert.deepEqual(results.filter((r) => r.isError).map((r) => r.content), [], 'every GUI call succeeded');
      // the page's own requests reached the SUT through the egress guard: the click posted the greeting
      assert.deepEqual(shop.greeted, ['Ada']);
      const evidence = await ht.services.evidence.query({ runId: outcome.runId });
      const byType = (t: string) => evidence.filter((e) => e.evidenceType === t);
      const pageLoad = byType('api-response').find((e) => (e.structured as { via?: string } | undefined)?.via === 'browser.navigate');
      assert.ok(pageLoad, 'browser.navigate recorded the page load');
      assert.equal(pageLoad.environment?.environmentId, ENV_ID);
      const dom = byType('dom-snapshot');
      assert.equal(dom.length, 1);
      assert.equal((dom[0]!.structured as { text: string }).text, 'Hello Ada');
      const shots = byType('screenshot');
      assert.equal(shots.length, 1);
      assert.equal(shots[0]!.artifact.mimeType, 'image/png');
      assert.equal(shots[0]!.environment?.environmentId, ENV_ID, 'the screenshot is attributed to the environment the page is on');
      const png = await ht.services.artifacts.get(shots[0]!.artifact.uri);
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the screenshot is stored as a PNG artifact');
      // the interactions changed the SUT: they ran as ledgered operations on the environment
      const ops = await ht.services.operations.list({ runId: outcome.runId });
      assert.deepEqual(ops.filter((o) => o.operationType.startsWith('browser.')).map((o) => [o.operationType, o.status]).sort(), [['browser.click', 'verified'], ['browser.fill', 'verified']]);
      // the QualityGate judged the oracle on the browser's api-response evidence: a verdict, not inconclusive
      assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
      assert.equal(outcome.decision?.verdict, 'pass', JSON.stringify(outcome.decision));
    } finally {
      await ht.close();
    }
  });
});
