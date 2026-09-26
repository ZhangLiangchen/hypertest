/**
 * Test helpers for @hypertest/app: scripted brains keyed by the machine-readable header line of the system prompt
 * (`[hypertest role=… work_item=… kind=… run=…]`), a git repository with a real node:test suite, and a configuration
 * builder over a temporary data directory with one scripted provider + route.
 */
import type { JsonValue } from '@hypertest/core';
import type { ChatMessage } from '@hypertest/domain';
import type { ModelCallRequest, ScriptedBrain, ScriptedReply } from '@hypertest/model';
import { parseAgentHeader } from '@hypertest/control';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '@hypertest/store';
import { createGitRepo, infraEnv } from '@hypertest/testkit';
import { defaultConfig } from '../src/index.ts';
import type { HypertestConfig, HypertestConfigInput } from '../src/index.ts';

export interface BrainView {
  role: string;
  kind: string;
  workItemId: string;
  runId: string;
  step: number;
  userText: string;
  toolResults: Array<{ name: string; content: string; isError: boolean }>;
}

export type RoleBrain = (view: BrainView) => ScriptedReply | Promise<ScriptedReply>;

export function viewOf(request: ModelCallRequest): BrainView {
  const system = request.messages[0]?.role === 'system' ? request.messages[0].content : '';
  const header = parseAgentHeader(system);
  if (!header) throw new Error(`request without a hypertest header: ${system.slice(0, 120)}`);
  const toolResults = request.messages
    .filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')
    .map((m) => ({ name: m.toolName, content: m.content, isError: m.isError === true }));
  const userText = request.messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')))
    .join('\n');
  return { ...header, step: request.messages.filter((m) => m.role === 'assistant').length, userText, toolResults };
}

/** One brain for every agent: dispatches on the header's role; unknown roles fail their work (never hang). */
export function roleRouter(brains: Record<string, RoleBrain>, calls?: BrainView[]): ScriptedBrain {
  return (request) => {
    const view = viewOf(request);
    calls?.push(view);
    const brain = brains[view.role];
    if (!brain) return call('fail_work', { reason: 'no_brain', message: `no scripted brain for role ${view.role}` });
    return brain(view);
  };
}

export function call(name: string, args: JsonValue): ScriptedReply {
  return { toolCalls: [{ name: name.replaceAll('.', '__'), arguments: args }] };
}

export function evidenceIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bev_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

export const OBJECTIVE = {
  objectiveId: 'obj-sum',
  description: 'Decide whether the sum module is releasable: its test suite passes on the candidate commit.',
  priority: 'P1',
  acceptanceCriteria: ['the suite ran on the candidate with recorded test-result evidence'],
};

/**
 * The tiny product loop: lead Plan v1 = one executor item (critical test-result evidence) → the executor runs the real
 * node:test suite and completes with its evidence → plan drained → the lead queries the test-result evidence and
 * proposes Plan v2 readyForGate → QualityGate.
 */
export function tinyRunBrains(): Record<string, RoleBrain> {
  return {
    lead: (v) => {
      if (v.kind === 'initial_plan') {
        if (v.step === 0) {
          return call('plan.propose_revision', {
            rationale: 'Execute the existing suite on the candidate commit.',
            objectives: [OBJECTIVE],
            workItems: [
              {
                localId: 'run-suite', title: 'Run the sum suite', objective: 'Run the node:test suite of the repository on the candidate commit and report the outcome with evidence.',
                role: 'executor', dependsOn: [], objectiveIds: ['obj-sum'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
              },
            ],
          });
        }
        return call('complete_work', { summary: 'Plan v1 proposed', output: { summary: 'Plan v1: execute the suite', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-sum', status: 'open', evidenceRefs: [] }] } });
      }
      // replan: look the execution evidence up, hand over to the gate, complete citing it
      if (v.step === 0) return call('evidence.query', { evidenceType: 'test-result' });
      const ev = evidenceIds(v.toolResults[0]!.content);
      if (v.step === 1) {
        return call('plan.propose_revision', {
          rationale: 'The suite passed on the candidate with recorded evidence; hand over to the gate.',
          objectives: [{ ...OBJECTIVE, status: 'satisfied' }],
          workItems: [],
          readyForGate: true,
        });
      }
      return call('complete_work', {
        summary: 'Plan v2: ready for the gate', evidenceRefs: ev.slice(0, 1),
        output: { summary: 'ready for gate', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-sum', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] },
      });
    },
    executor: (v) => {
      if (v.step === 0) return call('test.run', { framework: 'node_test' });
      const ids = evidenceIds(v.toolResults[0]!.content);
      return call('complete_work', {
        summary: 'The sum suite passes on the candidate.', evidenceRefs: ids,
        output: { summary: 'suite passed', executed: [{ selector: 'test/sum.test.js', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] },
      });
    },
  };
}

export const SUM_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.js';

test('adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
});

test('adds negatives', () => {
  assert.equal(sum(-2, -3), -5);
});
`;

/** A git repository with a passing node:test suite. */
export async function sumRepo(): Promise<{ path: string; head: string; cleanup(): Promise<void> }> {
  const repo = await createGitRepo({
    'package.json': '{ "name": "calc", "type": "module", "private": true }\n',
    'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n',
    'test/sum.test.js': SUM_TEST,
  });
  return { path: repo.path, head: repo.commits[0]!, cleanup: repo.cleanup };
}

/** Every capability, high quality: a route every built-in role can use. */
export const FULL_ROUTE = {
  capabilities: ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'],
  quality: { default: 0.9 },
  maxActionRisk: 'critical',
} as const;

/** defaultConfig over `dataDir` with one scripted provider `sim` and one route `sim-large`. */
export function scriptedConfig(dataDir: string, extra: HypertestConfigInput = {}): HypertestConfig {
  return defaultConfig({
    project: { name: 'app-test', dataDir },
    models: {
      providers: [{ id: 'sim', kind: 'scripted' }],
      routes: [{ routeId: 'sim-large', provider: 'sim', model: 'sim-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }],
    },
    observability: { logLevel: 'warn' },
    ...extra,
  } as HypertestConfigInput);
}

/**
 * The store of a test Hypertest: PGlite under the data directory by default; with HYPERTEST_TEST_DB=postgres a fresh
 * schema on HYPERTEST_TEST_PG_URL (dropped by dispose()).
 */
export async function testStore(): Promise<{ store?: HypertestConfig['store']; dispose(): Promise<void> }> {
  if (process.env['HYPERTEST_TEST_DB'] !== 'postgres') return { dispose: async () => undefined };
  const url = infraEnv().pgUrl;
  if (!url) throw new Error('HYPERTEST_TEST_DB=postgres needs HYPERTEST_TEST_PG_URL');
  const schema = `ht_app_${randomBytes(5).toString('hex')}`;
  return {
    store: { kind: 'postgres', url, schema },
    async dispose() {
      const db = await openDatabase({ kind: 'postgres', url });
      try {
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await db.close();
      }
    },
  };
}
