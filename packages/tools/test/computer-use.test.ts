/**
 * (row 246: Computer Use) The computer.* tools over pluggable backends: the documented fake backend (classification,
 * grant, ledger, evidence), the xdotool backend against a fake xdotool binary that records its argv, and the native X11
 * backend LIVE against Xvfb with a real Chromium window (skipped with the reason when Xvfb or Chromium is missing): a
 * click on the page's button and text typed into its input reach the page.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { computerTools, fakeComputerBackend, x11Backend, xdotoolBackend, type ToolSpec } from '../src/index.ts';
import { BLACKBOX_PROFILE, capability, fakeContext, newGateway, newRuntime, openBlackboxEnv, toolRequest, type BlackboxEnv } from './blackbox-helpers.ts';

const BIN = fileURLToPath(new URL('./fixtures/bin', import.meta.url));
const CHROMIUM = process.env['HYPERTEST_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

describe('computer.* with the fake backend (documented test backend)', () => {
  let env: BlackboxEnv;
  before(async () => (env = await openBlackboxEnv()));
  after(() => env.dispose());

  test('classification: desktop/<id> granted to the configured profiles, screenshot read, input external', () => {
    const tools = new Map(computerTools({ backend: fakeComputerBackend(), displayId: 'desk-1', grantTo: ['test_executor'] }).map((t) => [t.id, t]));
    assert.deepEqual([...tools.keys()], ['computer.screenshot', 'computer.click', 'computer.type', 'computer.key']);
    for (const t of tools.values()) {
      assert.deepEqual(t.resources({}, { workspace: undefined as never, runId: 'r', environments: env.environments }), ['desktop/desk-1']);
      assert.deepEqual(t.grant, { scopes: ['desktop/desk-1'], profiles: ['test_executor'] });
      assert.equal(t.environmentClass!({}, { environments: env.environments }), 'local');
    }
    assert.equal(tools.get('computer.screenshot')!.effect, 'read');
    for (const id of ['computer.click', 'computer.type', 'computer.key']) assert.equal(tools.get(id)!.effect, 'external');
  });

  test('through the runtime: a click is one ledgered operation with ui-action + screenshot evidence; a screenshot is screenshot evidence', async () => {
    const backend = fakeComputerBackend();
    const { gateway, ledger } = newGateway(env, []);
    const runtime = newRuntime(env, computerTools({ backend, displayId: 'desk-1' }), gateway);
    // the grant the control plane adds for profiles listed in ToolSpec.grant
    const granted = capability({ profile: { ...BLACKBOX_PROFILE, resourceScopes: ['env/**', 'desktop/desk-1'] } });
    const shot = await runtime.execute(toolRequest('computer.screenshot', {}, { capability: granted }));
    assert.equal(shot.status, 'success', shot.modelText);
    const [png] = await env.evidence.getMany(shot.evidenceRefs);
    assert.equal(png!.evidenceType, 'screenshot');
    assert.equal(png!.artifact.mimeType, 'image/png');
    const click = await runtime.execute(toolRequest('computer.click', { x: 10, y: 20 }, { capability: granted }));
    assert.equal(click.status, 'success', click.modelText);
    assert.equal((await ledger.get(click.operationId!))?.status, 'verified');
    const ev = await env.evidence.getMany(click.evidenceRefs);
    assert.deepEqual(ev.map((e) => e.evidenceType), ['ui-action', 'screenshot']);
    assert.equal(ev[0]!.operationId, click.operationId);
    assert.deepEqual(backend.actions, [{ action: 'click', x: 10, y: 20, button: 'left' }]);
    // a capability without the desktop scope is refused before anything happens
    const denied = await runtime.execute(toolRequest('computer.click', { x: 1, y: 1 }, { capability: capability({ profile: { name: 'p', allowedEffects: ['read', 'external'], maxRiskClass: 'high', resourceScopes: ['env/**'], environmentClasses: ['local'], credentialScopes: [] } }) }));
    assert.equal(denied.status, 'denied');
    assert.match(denied.modelText, /resource_out_of_scope: desktop\/desk-1/);
    assert.equal(backend.actions.length, 1);
  });

  test('failure paths: coordinates outside the desktop, untypeable text and unknown keys are refused without acting', async () => {
    const backend = fakeComputerBackend();
    const tools = new Map(computerTools({ backend, displayId: 'desk-1' }).map((t) => [t.id, t]));
    const { ctx } = fakeContext();
    assert.equal((await tools.get('computer.click')!.execute({ x: 5000, y: 1 }, ctx)).error?.code, 'invalid_argument');
    assert.equal((await tools.get('computer.type')!.execute({ text: 'emoji 😀' }, ctx)).error?.code, 'invalid_argument');
    assert.equal((await tools.get('computer.key')!.execute({ keys: 'ctrl+nosuchkey' }, ctx)).error?.code, 'invalid_argument');
    assert.deepEqual(backend.actions, []);
  });
});

describe('computer.* with the xdotool backend (fake xdotool binary recording argv)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ht-xdotool-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('click, type and key become exact xdotool argv on the configured display; screenshots come from the screenshot command', async () => {
    const log = join(dir, 'argv.log');
    process.env['FAKE_XDOTOOL_LOG'] = log;
    try {
      const backend = xdotoolBackend({ display: ':42', xdotool: join(BIN, 'xdotool'), screenshotCommand: [join(BIN, 'fake-screenshot')] });
      const tools = new Map(computerTools({ backend, displayId: 'x-42' }).map((t) => [t.id, t]));
      const { ctx, evidence } = fakeContext();
      assert.equal((await tools.get('computer.click')!.execute({ x: 100, y: 200, button: 'right' }, ctx)).status, 'success');
      assert.equal((await tools.get('computer.type')!.execute({ text: '-n hello' }, ctx)).status, 'success');
      assert.equal((await tools.get('computer.key')!.execute({ keys: 'ctrl+a' }, ctx)).status, 'success');
      const lines = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { display: string; argv: string[] });
      assert.ok(lines.every((l) => l.display === ':42'));
      assert.deepEqual(lines.map((l) => l.argv).filter((a) => a[0] !== 'getdisplaygeometry'), [
        ['mousemove', '--sync', '100', '200', 'click', '3'],
        ['type', '--delay', '1', '--', '-n hello'],
        ['key', '--clearmodifiers', '--', 'ctrl+a'],
      ]);
      assert.ok(evidence.filter((e) => e.input.evidenceType === 'screenshot').every((e) => (e.input.data as Uint8Array)[0] === 0x89));
    } finally {
      delete process.env['FAKE_XDOTOOL_LOG'];
    }
  });

  test('a missing xdotool binary is unavailable, never a silent success', async () => {
    const backend = xdotoolBackend({ display: ':42', xdotool: join(dir, 'no-such-xdotool') });
    const out = await computerTools({ backend, displayId: 'x-42' })[1]!.execute({ x: 1, y: 1 }, fakeContext().ctx);
    assert.equal(out.status, 'failed');
    assert.equal(out.error?.code, 'unavailable');
  });
});

describe('computer.* LIVE: the native X11 backend on Xvfb driving a real Chromium window', () => {
  let skip: string | undefined;
  let xvfb: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let server: Server | undefined;
  let profile: string | undefined;
  const events: string[] = [];
  const display = `:${70 + (process.pid % 20)}`;
  let tools: Map<string, ToolSpec>;
  let backend: ReturnType<typeof x11Backend>;

  before(async () => {
    const which = (bin: string) => (process.env['PATH'] ?? '').split(':').some((d) => existsSync(join(d, bin)));
    if (!which('Xvfb')) return void (skip = 'Xvfb is not installed (live desktop deferred on this host)');
    if (!existsSync(CHROMIUM)) return void (skip = `no Chromium at ${CHROMIUM}`);
    const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
    xvfb = spawn('Xvfb', [display, '-ac', '-screen', '0', '800x600x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(socket)) return void (skip = `Xvfb did not create ${socket}`);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        if (req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<!doctype html><html><body style="margin:0;background:#fff" onload="fetch('/event',{method:'POST',body:'ready'})">
<button id="b" style="position:absolute;left:0;top:0;width:800px;height:280px;background:#3366cc;color:#fff;font-size:40px" onclick="fetch('/event',{method:'POST',body:'clicked'})">Order</button>
<input id="q" style="position:absolute;left:0;top:320px;width:800px;height:120px;font-size:40px" onkeydown="if(event.key==='Enter')fetch('/event',{method:'POST',body:'typed:'+this.value})">
</body></html>`);
          return;
        }
        if (req.url === '/event') events.push(body);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    profile = mkdtempSync(join(tmpdir(), 'ht-chrome-'));
    chrome = spawn(CHROMIUM, ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-position=0,0', '--window-size=800,600', '--kiosk', `http://127.0.0.1:${(server.address() as AddressInfo).port}/`], {
      // its own process group: the teardown kills Chromium with every child (renderers keep writing the profile otherwise)
      env: { ...process.env, DISPLAY: display }, stdio: 'ignore', detached: true,
    });
    backend = x11Backend({ display });
    tools = new Map(computerTools({ backend, displayId: `xvfb-${display.slice(1)}` }).map((t) => [t.id, t]));
    // wait until the page has loaded (it says so) and is painted (the button's blue reaches the framebuffer) — generous
    // bounds: a loaded host (the full suite) starts Chromium slowly
    for (let i = 0; i < 300 && !events.includes('ready'); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 60; i++) {
      const png = await backend.screenshot(new AbortController().signal).catch(() => undefined);
      if (png && png.byteLength > 1500) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  after(async () => {
    await backend?.close?.();
    await killGroup(chrome);
    xvfb?.kill('SIGKILL');
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('screenshot is a real PNG of the desktop; click and typing reach the page', async (t) => {
    if (skip) return t.skip(skip);
    const { ctx, evidence } = fakeContext();
    const shot = await tools.get('computer.screenshot')!.execute({}, ctx);
    assert.equal(shot.status, 'success', JSON.stringify(shot.error));
    assert.deepEqual([(shot.structured as { width: number }).width, (shot.structured as { height: number }).height], [800, 600]);
    assert.deepEqual([...(evidence[0]!.input.data as Uint8Array).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await tools.get('computer.click')!.execute({ x: 400, y: 140 }, ctx)).status, 'success');
    for (let i = 0; i < 150 && !events.includes('clicked'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.includes('clicked'), `the click reached the page: ${JSON.stringify(events)}`);
    assert.equal((await tools.get('computer.click')!.execute({ x: 400, y: 380 }, ctx)).status, 'success');
    assert.equal((await tools.get('computer.type')!.execute({ text: 'Ada' }, ctx)).status, 'success');
    assert.equal((await tools.get('computer.key')!.execute({ keys: 'Return' }, ctx)).status, 'success');
    for (let i = 0; i < 150 && !events.includes('typed:Ada'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.includes('typed:Ada'), `the typed text reached the page: ${JSON.stringify(events)}`);
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
