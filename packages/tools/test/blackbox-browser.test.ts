import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionManager, browserTools, chromiumExecutablePath, createEnvironmentRegistry, type EnvironmentRegistry, type ToolSpec } from '../src/index.ts';
import { fakeContext, startServer, structuredOf, type TestServer } from './blackbox-helpers.ts';

const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
<h1 id="h">Welcome</h1>
<label for="name">Name</label><input id="name" />
<button onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value">Greet</button>
<p id="out"></p>
</body></html>`;

let server: TestServer;
let other: TestServer;
let manager: BrowserSessionManager;
let tools: Map<string, ToolSpec>;
let envs: EnvironmentRegistry;
let skipReason: string | undefined;

before(async () => {
  other = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Other</title>');
  });
  server = await startServer((req, res) => {
    if (req.url === '/links') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Links</title><p id="p">links page</p><a id="away" href="${other.url}/secret">away</a><img src="${other.url}/pixel.png">`);
      return;
    }
    if (req.url === '/go-elsewhere') {
      res.writeHead(302, { location: `${other.url}/` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  envs = createEnvironmentRegistry([
    { environmentId: 'env_ui', environmentClass: 'local', generation: 1, baseUrl: server.url },
    { environmentId: 'env_stage', environmentClass: 'staging', generation: 1, baseUrl: server.url },
    { environmentId: 'env_other', environmentClass: 'local', generation: 1, baseUrl: other.url },
  ]);
  manager = new BrowserSessionManager({ idleTimeoutMs: 60_000 });
  try {
    const probe = await manager.page('probe', 'probe');
    await probe.close();
    await manager.closeSession('probe', 'probe');
  } catch (e) {
    skipReason = `chromium cannot be launched from ${chromiumExecutablePath()}: ${(e as Error).message.split('\n')[0]}`;
  }
  tools = new Map(browserTools({ manager }).map((t) => [t.id, t]));
});

after(async () => {
  await manager.closeAll();
  await server.close();
  await other.close();
});

const call = (id: string, input: unknown, ctx = fakeContext({ environments: envs })) => tools.get(id)!.execute(input, ctx.ctx);

test('navigate, fill, click by role, read text, screenshot evidence', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = fakeContext({ environments: envs });
  const nav = await call('browser.navigate', { environmentId: 'env_ui', path: '/' }, ctx);
  assert.equal(nav.status, 'success', JSON.stringify(nav.error));
  assert.deepEqual(structuredOf(nav), { url: `${server.url}/`, status: 200, title: 'Shop', sessionId: 'default', evidenceId: 'ev_fake_1' });
  assert.equal((await call('browser.fill', { selector: '#name', value: 'Ada', environmentId: 'env_ui' }, ctx)).status, 'success');
  const click = await call('browser.click', { role: 'button', name: 'Greet', environmentId: 'env_ui' }, ctx);
  assert.equal(click.status, 'success', JSON.stringify(click.error));
  // env_ui and env_stage serve the same origin: the page's environment is ambiguous unless the call names it
  const text = await call('browser.text', { selector: '#out', environmentId: 'env_ui' }, ctx);
  assert.equal(text.status, 'success');
  assert.equal(structuredOf(text)['text'], 'Hello Ada');
  const shot = await call('browser.screenshot', { fullPage: true }, ctx);
  assert.equal(shot.status, 'success');
  // (e2e[1]) navigate → api-response (the page load), text → dom-snapshot (the DOM check), screenshot → screenshot
  assert.deepEqual(ctx.evidence.map((e) => e.input.evidenceType), ['api-response', 'dom-snapshot', 'screenshot']);
  const [load, dom] = ctx.evidence;
  assert.deepEqual(nav.evidenceRefs, [load!.record.evidenceId]);
  const loaded = load!.input.structured as { request: { method: string; path: string }; response: { status: number; body: string }; page: { title: string } };
  assert.deepEqual([loaded.request.method, loaded.request.path, loaded.response.status, loaded.page.title], ['GET', '/', 200, 'Shop']);
  assert.match(loaded.response.body, /<h1 id="h">Welcome<\/h1>/);
  assert.equal(load!.input.environment?.environmentId, 'env_ui', 'the page load is anchored to the environment the page is on');
  assert.deepEqual(text.evidenceRefs, [dom!.record.evidenceId]);
  assert.equal((dom!.input.structured as { text: string; selector: string }).text, 'Hello Ada');
  assert.equal(dom!.input.environment?.environmentId, 'env_ui');
  assert.equal(ctx.evidence[2]!.input.environment, undefined, 'a screenshot naming no environment on an origin two environments serve is not attributed to either (fail closed)');
  const ev = ctx.evidence[2]!;
  assert.equal(ev.input.evidenceType, 'screenshot');
  assert.equal(ev.input.mimeType, 'image/png');
  assert.deepEqual([...(ev.input.data as Uint8Array).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(structuredOf(shot)['evidenceId'], ev.record.evidenceId);
  assert.equal(manager.sessionCount, 1, 'one context per (run, agent)');
});

test('egress guard: disallowed hosts are never opened; redirects off the allowlist are refused', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = fakeContext({ environments: envs });
  const denied = await call('browser.navigate', { url: 'http://shop.example.test/' }, ctx);
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error?.code, 'permission_denied');
  const redirected = await call('browser.navigate', { environmentId: 'env_stage', path: '/go-elsewhere' }, ctx);
  assert.equal(redirected.status, 'failed');
  assert.equal(redirected.error?.code, 'permission_denied');
  assert.match(redirected.error!.message, /redirected off the allowlist/);
});

test('interactions need a page and must stay on the named environment', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const fresh = fakeContext({ environments: envs });
  fresh.ctx.agentId = 'agent_without_page';
  const none = await call('browser.click', { selector: '#x' }, fresh);
  assert.equal(none.status, 'failed');
  assert.equal(none.error?.code, 'precondition_failed');
  const ctx = fakeContext({ environments: envs });
  assert.equal((await call('browser.navigate', { environmentId: 'env_ui' }, ctx)).status, 'success');
  const wrongEnv = await call('browser.fill', { selector: '#name', value: 'x', environmentId: 'env_other' }, ctx);
  assert.equal(wrongEnv.status, 'failed');
  assert.equal(wrongEnv.error?.code, 'permission_denied');
  const missing = await call('browser.click', { selector: '#does-not-exist', timeoutMs: 300 }, ctx);
  assert.equal(missing.status, 'timeout');
  // (e2e[1]) reads may name the environment too: refused when the page is elsewhere
  const offEnvText = await call('browser.text', { environmentId: 'env_other' }, ctx);
  assert.equal(offEnvText.error?.code, 'permission_denied');
  const spec = tools.get('browser.click')!;
  assert.equal(spec.effect, 'external');
  assert.equal(spec.environmentClass!({ selector: 'x', environmentId: 'env_ui' }, { environments: envs }), 'local');
  assert.equal(spec.environmentClass!({ selector: 'x' }, { environments: envs }), undefined, 'without environmentId the policy cannot classify it');
});

test('a missing Chromium executable is reported as unavailable, not thrown', async () => {
  const broken = new BrowserSessionManager({ chromiumPath: '/nonexistent/chromium', launchTimeoutMs: 5000 });
  const nav = browserTools({ manager: broken }).find((s) => s.id === 'browser.navigate')!;
  const out = await nav.execute({ environmentId: 'env_ui' }, fakeContext({ environments: envs }).ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'unavailable');
  await broken.closeAll();
});

test('egress guard covers the whole context: link clicks and subresources off the allowlist are blocked and reported', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = fakeContext({ environments: envs });
  ctx.ctx.agentId = 'agent_guard';
  const otherHits = () => other.requests.length;
  const before = otherHits();
  // env_stage is staging: loopback hosts other than its own origin are off the allowlist
  const nav = await call('browser.navigate', { environmentId: 'env_stage', path: '/links' }, ctx);
  assert.equal(nav.status, 'success', JSON.stringify(nav.error));
  const blockedOnLoad = structuredOf(nav)['blockedRequests'] as Array<{ url: string; reason: string }>;
  assert.deepEqual(blockedOnLoad.map((b) => b.url), [`${other.url}/pixel.png`], 'the off-allowlist image was refused');
  assert.match(blockedOnLoad[0]!.reason, /loopback is only allowed for environment class local/);
  const click = await call('browser.click', { selector: '#away' }, ctx);
  assert.equal(click.status, 'success');
  assert.deepEqual((structuredOf(click)['blockedRequests'] as Array<{ url: string }>).map((b) => b.url), [`${other.url}/secret`]);
  assert.match(click.text!, /egress guard refused 1 request/);
  // the aborted navigation leaves Chromium on its local error page — never on the other host
  const url = String(structuredOf(click)['url']);
  assert.ok(url === `${server.url}/links` || url.startsWith('chrome-error://'), url);
  assert.equal(url.startsWith(other.url), false);
  assert.equal(otherHits(), before, 'the other host never received a request');
  await manager.closeSession(ctx.ctx.runId, 'agent_guard');
});

test('fail closed: a browser context without an egress policy (no browser.navigate) sends nothing', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const before = other.requests.length;
  const page = await manager.page('run_raw', 'agent_raw');
  await assert.rejects(page.goto(`${other.url}/raw`), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(other.requests.length, before);
  assert.equal((await manager.drainBlocked('run_raw', 'agent_raw'))[0]?.reason, 'no egress policy for this browser session (call browser.navigate first)');
  await manager.closeSession('run_raw', 'agent_raw');
});
