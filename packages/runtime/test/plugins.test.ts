/**
 * A[6] / coverage[2] the kernel plugin runtime: Plugin ABI (manifest + digest), lifecycle init → start → health → stop,
 * the Service Registry and the Capability Registry; refusals (digest mismatch, undeclared contribution, unhealthy plugin).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { HypertestError, MemoryLogger, sha256Hex } from '@hypertest/core';
import { FixedClock } from '@hypertest/core';
import { createPluginKernel, pluginDigest, validatePluginManifest, type PluginManifest } from '../src/index.ts';

type Log = string[];
const g = globalThis as unknown as { __htPluginLog?: Log };

/** A plugin module that records its lifecycle in globalThis.__htPluginLog. */
function moduleSource(id: string, body: string): string {
  return `const log = (e) => (globalThis.__htPluginLog ??= []).push('${id}:' + e);
log('imported');
export function createPlugin() {
  return {
    init(ctx) { log('init'); this.ctx = ctx; },
    start() { log('start'); },
    health() { log('health'); return { ok: true }; },
    stop() { log('stop'); },
    ${body}
  };
}
`;
}

describe('A[6] kernel plugin runtime', () => {
  let dir: string;
  const deps = { logger: new MemoryLogger(), clock: new FixedClock('2026-07-01T00:00:00.000Z') };
  before(async () => (dir = await mkdtemp(join(tmpdir(), 'ht-plugins-'))));
  after(async () => rm(dir, { recursive: true, force: true }));
  beforeEach(() => (g.__htPluginLog = []));

  async function plugin(id: string, kind: PluginManifest['kind'], capabilities: string[], body = '', file = `${id}.mjs`): Promise<PluginManifest> {
    const entry = join(dir, file);
    const src = moduleSource(id, body);
    await writeFile(entry, src);
    return { id, version: '1.0.0', kind, entry, capabilities, digest: `sha256:${sha256Hex(Buffer.from(src))}` };
  }

  test('lifecycle order: import → init (config order) → start → health; stop in reverse; services cross plugins; manifest entries', async () => {
    const cache = await plugin('acme-cache', 'tool', ['service:acme.cache'], `services() { return { 'acme.cache': { get: (k) => 'v:' + k } }; },`);
    const user = await plugin('acme-tools', 'tool', ['tool:acme.lookup'], `tools() { return [{ id: 'acme.lookup', title: 'Lookup', description: 'cache lookup', inputSchema: { type: 'object' }, effect: 'read', riskClass: 'low', resources: () => [], timeoutMs: 1000, execute: async () => ({ status: 'succeeded', output: { v: this.ctx.services.get('acme.cache').get('k') } }) }]; },`);
    const kernel = await createPluginKernel([{ ...cache, config: { size: 3 } }, user], deps);
    try {
      assert.deepEqual(g.__htPluginLog, [
        'acme-cache:imported', 'acme-cache:init', 'acme-tools:imported', 'acme-tools:init', 'acme-cache:start', 'acme-tools:start', 'acme-cache:health', 'acme-tools:health',
      ]);
      assert.deepEqual(kernel.plugins.map((p) => [p.manifest.id, p.state]), [['acme-cache', 'started'], ['acme-tools', 'started']]);
      assert.deepEqual(kernel.services.list(), [{ name: 'acme.cache', owner: 'acme-cache' }]);
      assert.deepEqual(kernel.capabilities.list(), [{ capability: 'service:acme.cache', pluginId: 'acme-cache' }, { capability: 'tool:acme.lookup', pluginId: 'acme-tools' }]);
      const [tool] = kernel.tools();
      assert.equal(tool!.id, 'acme.lookup');
      assert.deepEqual(await tool!.execute({}, {} as never), { status: 'succeeded', output: { v: 'v:k' } }, 'the tool reached the other plugin\'s service');
      assert.deepEqual(await kernel.health(), [{ pluginId: 'acme-cache', ok: true }, { pluginId: 'acme-tools', ok: true }]);
      assert.deepEqual(kernel.manifestEntries().map((e) => [e.id, e.kind, e.digest]), [['acme-cache', 'tool', cache.digest], ['acme-tools', 'tool', user.digest]]);
    } finally {
      g.__htPluginLog = [];
      await kernel.stop();
      await kernel.stop(); // idempotent
      assert.deepEqual(g.__htPluginLog, ['acme-tools:stop', 'acme-cache:stop']);
    }
  });

  test('a digest mismatch is refused before anything of the module runs', async () => {
    const p = await plugin('tampered', 'tool', ['tool:x.y']);
    await writeFile(p.entry, moduleSource('tampered', '/* edited after pinning */'));
    await assert.rejects(createPluginKernel([p], deps), (e: unknown) => {
      assert.ok(e instanceof HypertestError);
      assert.equal(e.code, 'precondition_failed');
      assert.match(e.message, /^plugin tampered: digest mismatch — the configuration pins sha256:[0-9a-f]{64}, the entry .+ is sha256:[0-9a-f]{64}: refused \(nothing of it was loaded\)$/);
      return true;
    });
    assert.deepEqual(g.__htPluginLog, [], 'not imported');
  });

  test('an unhealthy plugin fails the start; the plugins already started are stopped in reverse order', async () => {
    const good = await plugin('good', 'tool', ['service:good.svc'], `services() { return { 'good.svc': 1 }; },`);
    const sick = await plugin('sick', 'context-hook', ['context-hook:notes'], `health() { log('health'); return { ok: false, detail: 'index not built' }; }, contextHooks() { return { notes: { sections: () => [] } }; },`);
    await assert.rejects(createPluginKernel([good, sick], deps), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && e.message === 'plugin sick is unhealthy after start: index not built');
    assert.deepEqual(g.__htPluginLog!.slice(-2), ['sick:stop', 'good:stop']);
  });

  test('an undeclared or foreign-kind contribution is refused; init and start failures stop what started', async () => {
    const sneaky = await plugin('sneaky', 'tool', ['tool:declared.one'], `tools() { return [{ id: 'undeclared.two' }]; },`);
    await assert.rejects(createPluginKernel([sneaky], deps), /plugin sneaky contributes tool:undeclared\.two, which its manifest does not declare/);
    assert.throws(() => validatePluginManifest({ id: 'x', version: '1', kind: 'tool', entry: '/abs/x.mjs', capabilities: ['engine:fast'], digest: `sha256:${'0'.repeat(64)}` }), /a tool plugin may not contribute engines/);
    assert.throws(() => validatePluginManifest({ id: 'x', version: '1', kind: 'tool', entry: 'rel.mjs', capabilities: ['tool:a'], digest: `sha256:${'0'.repeat(64)}` }), /entry must be an absolute path/);
    assert.throws(() => validatePluginManifest({ id: 'x', version: '1', kind: 'tool', entry: '/abs/x.mjs', capabilities: ['tool:a'], digest: 'md5:00' }), /digest must be sha256/);
    g.__htPluginLog = [];
    const first = await plugin('first', 'tool', ['service:f']);
    const broken = await plugin('broken', 'tool', ['service:b'], `start() { throw new Error('port in use'); },`);
    await assert.rejects(createPluginKernel([first, broken], deps), /plugin broken: start failed: port in use/);
    assert.ok(g.__htPluginLog!.includes('first:stop'));
    const dup = await plugin('dup', 'tool', ['service:f'], `services() { return { f: 2 }; },`, 'dup.mjs');
    const dup2 = { ...(await plugin('dup2', 'tool', ['service:f'], `services() { return { f: 3 }; },`, 'dup2.mjs')) };
    await assert.rejects(createPluginKernel([dup, dup2], deps), (e: unknown) => e instanceof HypertestError && e.code === 'conflict');
    assert.equal(pluginDigest(Buffer.from('x')), `sha256:${sha256Hex(Buffer.from('x'))}`);
  });
});
