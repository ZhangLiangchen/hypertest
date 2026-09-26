import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { ToolRegistry, toolIdToName, toolNameToId, type ToolSpec } from '../src/index.ts';
import { capability } from './helpers.ts';

function spec(id: string, overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    id,
    title: id,
    description: `tool ${id}`,
    inputSchema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    effect: 'read',
    riskClass: 'low',
    resources: () => [],
    timeoutMs: 1000,
    execute: async () => ({ status: 'success' }),
    ...overrides,
  };
}

test('model-visible names map "." to "__" and back', () => {
  assert.equal(toolIdToName('fs.apply_patch'), 'fs__apply_patch');
  assert.equal(toolNameToId('fs__apply_patch'), 'fs.apply_patch');
  assert.equal(toolNameToId(toolIdToName('mcp.github.search_code')), 'mcp.github.search_code');
});

test('register: duplicate id is a conflict; ids that cannot round-trip or are malformed are rejected', () => {
  const reg = new ToolRegistry([spec('fs.read')]);
  assert.throws(() => reg.register(spec('fs.read')), (e) => isHypertestError(e, 'conflict'));
  assert.throws(() => reg.register(spec('bad__id')), (e) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => reg.register(spec('has space')), (e) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => reg.register(spec('trailing.')), (e) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => reg.register(spec('x'.repeat(70))), (e) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => reg.register(spec('ok.tool', { inputSchema: { type: 'no-such-type' } })), (e) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => reg.register(spec('ok.tool', { timeoutMs: 0 })), (e) => isHypertestError(e, 'invalid_argument'));
  assert.deepEqual(reg.list().map((s) => s.id), ['fs.read']);
  assert.equal(reg.getByName('fs__read')?.id, 'fs.read');
  assert.equal(reg.get('nope'), undefined);
});

test('definitionsFor: allow ∧ ¬deny ∧ capability.tools, sorted, with model-visible names', () => {
  const reg = new ToolRegistry([spec('git.diff'), spec('fs.write'), spec('fs.read'), spec('git.commit'), spec('shell.exec')]);
  const cap = capability({ tools: ['fs.*', 'git.diff', 'git.commit'] });
  const defs = reg.definitionsFor(cap, ['fs.*', 'git.*', 'shell.exec'], ['fs.write']);
  assert.deepEqual(defs.map((d) => d.name), ['fs__read', 'git__commit', 'git__diff']);
  assert.deepEqual(defs[0], { name: 'fs__read', description: 'tool fs.read', inputSchema: reg.get('fs.read')!.inputSchema });
  // shell.exec is allowed by the role but not by the capability; fs.write is denied
  assert.equal(defs.some((d) => d.name === 'shell__exec' || d.name === 'fs__write'), false);
  assert.deepEqual(reg.definitionsFor(cap, [], []), []);
});

test('revision: order-independent, changes with schemas and static effects, dynamic effect is stable', () => {
  const a = new ToolRegistry([spec('fs.read'), spec('git.diff')]);
  const b = new ToolRegistry([spec('git.diff'), spec('fs.read')]);
  assert.equal(a.revision(), b.revision());
  assert.match(a.revision(), /^[0-9a-f]{64}$/);
  const c = new ToolRegistry([spec('fs.read', { inputSchema: { type: 'object', properties: { b: { type: 'string' } } } }), spec('git.diff')]);
  assert.notEqual(a.revision(), c.revision());
  const d = new ToolRegistry([spec('fs.read', { effect: 'execute' }), spec('git.diff')]);
  assert.notEqual(a.revision(), d.revision());
  const e1 = new ToolRegistry([spec('fs.read', { effect: () => 'read' }), spec('git.diff')]);
  const e2 = new ToolRegistry([spec('fs.read', { effect: () => 'external' }), spec('git.diff')]);
  assert.equal(e1.revision(), e2.revision(), 'dynamic effects hash as "dynamic"');
  assert.notEqual(e1.revision(), a.revision());
  // description changes do not move the revision (not part of the catalog contract)
  assert.equal(new ToolRegistry([spec('fs.read', { description: 'other' }), spec('git.diff')]).revision(), a.revision());
});
