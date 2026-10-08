import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOL_IDS,
  DOMAIN_TOOL_IDS,
  DYNAMIC_TOOL_NAMESPACES,
  KNOWN_TOOL_IDS,
  TERMINAL_TOOLS,
  WORKSPACE_WRITE_TOOL_IDS,
  isKnownToolPattern,
  matchesToolPattern,
  toolPermitted,
} from '../src/index.ts';

test('KNOWN_TOOL_IDS is exactly the built-in (tools) and domain (control) tool catalog', () => {
  assert.deepEqual([...BUILTIN_TOOL_IDS], [
    'fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.apply_patch',
    'git.status', 'git.diff', 'git.log', 'git.show', 'git.blame', 'git.commit',
    'shell.exec', 'test.run', 'coverage.collect', 'mutation.run', 'code.symbols', 'code.references',
    'http.request', 'metrics.query', 'metrics.scrape', 'load.start', 'load.observe', 'load.stop',
    'env.restart', 'env.inject_fault', 'env.deploy',
    'browser.navigate', 'browser.click', 'browser.fill', 'browser.screenshot', 'browser.text',
  ]);
  assert.deepEqual([...DOMAIN_TOOL_IDS], [
    'blackboard.read', 'blackboard.post_finding', 'blackboard.post_hypothesis', 'blackboard.report_coverage_gap', 'blackboard.post_risk',
    'blackboard.post_review', 'blackboard.post_note', 'plan.propose_revision', 'plan.read', 'work.propose', 'system_model.record',
    'oracle.get', 'oracle.list', 'oracle.propose_change', 'experiment.define', 'experiment.stop', 'test_artifact.register', 'test_artifact.validate',
    'evidence.get', 'evidence.query', 'evidence.claim', 'delegate', 'delegate.status', 'delegate.collect', 'delegate.message', 'delegate.release',
    'request_approval', 'complete_work', 'fail_work',
  ]);
  assert.equal(KNOWN_TOOL_IDS.length, 60);
  assert.equal(new Set(KNOWN_TOOL_IDS).size, KNOWN_TOOL_IDS.length, 'tool ids are unique');
  assert.deepEqual([...KNOWN_TOOL_IDS], [...BUILTIN_TOOL_IDS, ...DOMAIN_TOOL_IDS]);
});

test('tool id lists are frozen (catalog data cannot be widened at runtime)', () => {
  for (const list of [BUILTIN_TOOL_IDS, DOMAIN_TOOL_IDS, KNOWN_TOOL_IDS, TERMINAL_TOOLS, WORKSPACE_WRITE_TOOL_IDS, DYNAMIC_TOOL_NAMESPACES]) {
    assert.ok(Object.isFrozen(list));
    assert.throws(() => (list as unknown as string[]).push('shell.anything'), TypeError);
  }
  assert.ok(!KNOWN_TOOL_IDS.includes('shell.anything' as never));
});

test('TERMINAL_TOOLS are complete_work and fail_work', () => {
  assert.deepEqual([...TERMINAL_TOOLS], ['complete_work', 'fail_work']);
});

test('matchesToolPattern: exact, prefix glob and wildcard (same semantics as policy)', () => {
  assert.equal(matchesToolPattern('fs.read', 'fs.read'), true);
  assert.equal(matchesToolPattern('fs.read', 'fs.readme'), false);
  assert.equal(matchesToolPattern('git.*', 'git.diff'), true);
  assert.equal(matchesToolPattern('git.*', 'git'), false);
  assert.equal(matchesToolPattern('git.*', 'gitx.diff'), false);
  assert.equal(matchesToolPattern('oracle.propose*', 'oracle.propose_change'), true);
  assert.equal(matchesToolPattern('*', 'env.deploy'), true);
  assert.equal(matchesToolPattern('fs.*.x', 'fs.a.x'), false, 'a star that is not trailing is literal');
});

test('isKnownToolPattern accepts known ids and namespaced globs over known tools', () => {
  for (const ok of ['git.*', 'git.commit', 'evidence.*', 'oracle.propose*', 'complete_work', 'delegate']) assert.equal(isKnownToolPattern(ok), true, ok);
});

test('isKnownToolPattern rejects typos, bare wildcards, un-namespaced and malformed globs', () => {
  for (const bad of ['git.push', 'fs.reads', '*', 'g*', 'f*', 'fs.*.x', '', 'blackboard.post_findings', 'git.*x']) {
    assert.equal(isKnownToolPattern(bad), false, bad);
  }
});

test('isKnownToolPattern: dynamic MCP namespace and extra tool ids', () => {
  assert.equal(isKnownToolPattern('mcp.github.search_code'), true);
  assert.equal(isKnownToolPattern('mcp.*'), true);
  assert.equal(isKnownToolPattern('mcp.'), false, 'the bare namespace names no tool');
  assert.equal(isKnownToolPattern('custom.lint'), false);
  assert.equal(isKnownToolPattern('custom.lint', ['custom.lint']), true);
  assert.equal(isKnownToolPattern('custom.*', ['custom.lint']), true);
});

test('toolPermitted: allow must match and deny wins', () => {
  const policy = { allow: ['git.*', 'fs.read'], deny: ['git.commit'] };
  assert.equal(toolPermitted(policy, 'git.diff'), true);
  assert.equal(toolPermitted(policy, 'git.commit'), false);
  assert.equal(toolPermitted(policy, 'fs.write'), false);
  assert.equal(toolPermitted({ allow: ['fs.read'] }, 'fs.read'), true);
});

test('WORKSPACE_WRITE_TOOL_IDS are the built-in write_workspace tools (tools contract)', () => {
  assert.deepEqual([...WORKSPACE_WRITE_TOOL_IDS], ['fs.write', 'fs.apply_patch', 'git.commit']);
  for (const t of WORKSPACE_WRITE_TOOL_IDS) assert.ok((BUILTIN_TOOL_IDS as readonly string[]).includes(t), t);
});
