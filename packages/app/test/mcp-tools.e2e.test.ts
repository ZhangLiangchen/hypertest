/**
 * (E[5], stubs[1], coverage[3]) MCP in the production composition: `tools.mcpServers` configures two real MCP servers (the
 * @modelcontextprotocol/sdk fixture packages/tools/test/mcp-tickets-server.mjs) — `tickets` over stdio, bound to the
 * registered environment `tickets` (its tools address env/tickets), with its secrets passed by NAME (envFrom), and
 * `tracker` over streamable HTTP (a separate process; its bearer header from headersFromEnv), not bound to an environment
 * (its tools address mcp/tracker/**, the scope the operator grants to test_executor by default). createHypertest registers
 * `mcp.<id>.<tool>` and offers them to the executor; a scripted executor defines its experiment, creates a ticket
 * (external effect) and lists the tickets on both servers. Proven end to end: capability → policy permit (decision log) →
 * Operation Ledger (the create is one verified operation) → `mcp-response` evidence → QualityGate (pass). Before the fix
 * the configuration refused `tools.mcpServers` (unknown key) and no composition path could register an MCP server.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, validateConfig, type HypertestConfig, type HypertestConfigInput } from '../src/index.ts';
import { FULL_ROUTE, call, evidenceIds, roleRouter, testStore, type RoleBrain } from './helpers.ts';

const SERVER = fileURLToPath(new URL('../../tools/test/mcp-tickets-server.mjs', import.meta.url));
const TOKEN = 'mcp-test-token-7f3a';

const TICKETS_ORACLE = {
  oracleId: 'tickets',
  scope: { components: ['tracker'], description: 'a reported defect becomes exactly one ticket' },
  assertions: [
    { assertionId: 'one-ticket', description: 'the tracker lists exactly one ticket', kind: 'requirement', severity: 'P1', check: { type: 'evidence_predicate', evidenceType: 'mcp-response', field: 'structuredContent.count', comparator: '==', value: 1 } },
  ],
  judgePolicy: { independentReviewerRequired: false },
  establishedBy: 'alice',
} as const;

const OBJECTIVE = { objectiveId: 'obj-ticket', description: 'File the defect as one ticket.', priority: 'P1', acceptanceCriteria: ['mcp-response evidence'] };

async function startHttpServer(env: Record<string, string>): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [SERVER, '--http', '0'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve((JSON.parse(line) as { url: string }).url);
    });
    child.once('exit', (code) => reject(new Error(`MCP HTTP fixture exited (${code})`)));
  });
  return { url, child };
}

function config(dataDir: string, store: HypertestConfig['store'] | undefined, trackerUrl: string): HypertestConfig {
  const c = defaultConfig({
    project: { name: 'mcp-tools', dataDir },
    models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [{ routeId: 'sim-large', provider: 'sim', model: 'sim-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }] },
    gate: { requireIndependentReview: false, requiredEvidence: [{ evidenceType: 'mcp-response', minCount: 1 }] },
    observability: { logLevel: 'warn' },
    oracles: [TICKETS_ORACLE],
    environments: [{ environmentId: 'tickets', environmentClass: 'local', generation: 0 }],
    tools: {
      mcpServers: [
        {
          id: 'tickets', command: process.execPath, args: [SERVER], envFrom: { TICKETS_FILE: 'HT_TEST_TICKETS_FILE', TICKETS_TOKEN: 'HT_TEST_TICKETS_TOKEN' },
          allowTools: ['create_ticket', 'list_tickets'], toolEffects: { list_tickets: { effect: 'read', riskClass: 'low' } }, environmentId: 'tickets', timeoutMs: 20_000,
        },
        { id: 'tracker', url: trackerUrl, headersFromEnv: { authorization: 'HT_TEST_TRACKER_AUTH' }, allowTools: ['list_tickets'], effect: 'read', riskClass: 'low', timeoutMs: 20_000 },
      ],
    },
  } as unknown as HypertestConfigInput);
  return store ? { ...c, store } : c;
}

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'tracker', name: 'ticket tracker', kind: 'external', paths: [] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'File the defect through the tracker MCP server and confirm it.',
        objectives: [OBJECTIVE],
        workItems: [{ localId: 'file', title: 'File the ticket', objective: 'Create one ticket for the defect and confirm the tracker lists it.', role: 'executor', dependsOn: [], objectiveIds: ['obj-ticket'], evidenceRequirements: [{ evidenceType: 'mcp-response', minCount: 1, critical: true }] }],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-ticket', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'mcp-response' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'Filed with evidence; hand over to the gate.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'ready', evidenceRefs: ev.slice(0, 1), output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-ticket', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] } });
};

function executor(results: Array<{ name: string; content: string; isError: boolean }>): RoleBrain {
  return (v) => {
    const last = v.toolResults.at(-1);
    if (last) results.push(last);
    switch (v.step) {
      case 0: return call('experiment.define', { hypothesis: 'filing the defect creates exactly one ticket', environmentId: 'tickets', isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'mcp-response', minCount: 1 }] });
      case 1: return call('mcp.tickets.create_ticket', { title: 'login rejects valid passwords' });
      case 2: return call('mcp.tickets.list_tickets', {});
      case 3: return call('mcp.tracker.list_tickets', {});
      default: {
        const ids = [1, 2, 3].flatMap((i) => evidenceIds(v.toolResults[i]?.content ?? ''));
        return call('complete_work', { summary: 'one ticket filed and listed', evidenceRefs: ids, output: { summary: 'filed', executed: [{ selector: 'mcp tickets', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] } });
      }
    }
  };
}

describe('MCP servers configured in production: permit → ledger → evidence → gate', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let tracker: Awaited<ReturnType<typeof startHttpServer>>;
  let ticketsFile: string;

  before(async () => {
    dir = await tempDir('ht-app-mcp-');
    db = await testStore();
    ticketsFile = join(dir.path, 'tickets.jsonl');
    tracker = await startHttpServer({ TICKETS_FILE: ticketsFile, TICKETS_TOKEN: TOKEN });
  });
  after(async () => {
    tracker?.child.kill('SIGTERM');
    await db?.dispose();
    await dir?.cleanup();
  });

  test('the configuration accepts tools.mcpServers (it used to be an unknown key)', () => {
    assert.deepEqual(validateConfig(config(dir.path, undefined, 'http://127.0.0.1:1/mcp')), []);
  });

  test('a run creates one ticket through the ledger and records mcp-response evidence the gate judges', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const env = { ...process.env, HT_TEST_TICKETS_FILE: ticketsFile, HT_TEST_TICKETS_TOKEN: TOKEN, HT_TEST_TRACKER_AUTH: `Bearer ${TOKEN}` };
    const ht = await createHypertest(config(join(dir.path, 'data'), db.store, tracker.url), { scriptedBrains: { sim: roleRouter({ lead, executor: executor(results) }) }, logger: new MemoryLogger(), env });
    try {
      assert.ok(ht.services.tools.get('mcp.tickets.create_ticket') && ht.services.tools.get('mcp.tracker.list_tickets'), 'the configured MCP tools are registered');
      assert.ok(ht.services.roles.require('executor').toolPolicy.allow.includes('mcp.tickets.*'), 'the executor is offered the MCP tools');
      const outcome = await ht.run({ goal: 'File the login defect', target: { environmentId: 'tickets' } }, { timeoutMs: 120_000 });
      assert.deepEqual(results.filter((r) => r.isError).map((r) => r.content), [], 'every MCP call succeeded');
      const denied = await ht.events(outcome.runId, { types: ['tool.denied'] });
      assert.deepEqual(denied.map((e) => e.payload), []);
      // capability: the bound server's tool addresses env/tickets; the unbound one mcp/tracker/** (granted to test_executor)
      const called = (await ht.events(outcome.runId, { types: ['tool.called'] })).map((e) => e.payload as { toolId: string; resources: string[] });
      assert.deepEqual(called.find((c) => c.toolId === 'mcp.tickets.create_ticket')?.resources, ['env/tickets']);
      assert.deepEqual(called.find((c) => c.toolId === 'mcp.tracker.list_tickets')?.resources, ['mcp/tracker/list_tickets']);
      // permit: every MCP call was allowed by the policy and is in the decision log
      const decisions = (await ht.services.decisionLog.list(outcome.runId)).filter((d) => d.request.tool.startsWith('mcp.') && (d.request.phase ?? 'before_action') === 'before_action');
      assert.deepEqual(decisions.map((d) => [d.request.tool, d.permit.decision]).sort(), [['mcp.tickets.create_ticket', 'allow'], ['mcp.tickets.list_tickets', 'allow'], ['mcp.tracker.list_tickets', 'allow']]);
      // ledger: the external create is ONE verified operation; the reads are not ledgered
      const ops = (await ht.services.operations.list({ runId: outcome.runId })).filter((o) => o.operationType.startsWith('mcp.'));
      assert.deepEqual(ops.map((o) => [o.operationType, o.status]), [['mcp.tickets.create_ticket', 'verified']]);
      // evidence: one mcp-response per call; the create's names its operation; the secret never reached the evidence
      const ev = (await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'mcp-response' })).sort((a, b) => a.seq - b.seq);
      assert.equal(ev.length, 3);
      assert.equal(ev[0]!.operationId, ops[0]!.operationId);
      assert.equal(ev[0]!.environment?.environmentId, 'tickets');
      assert.equal((ev[2]!.structured as { transport: string }).transport, 'http');
      assert.equal(JSON.stringify(ev).includes(TOKEN), false);
      // the side effect happened exactly once
      const lines = (await readFile(ticketsFile, 'utf8')).split('\n').filter(Boolean);
      assert.deepEqual(lines.map((l) => (JSON.parse(l) as { title: string }).title), ['login rejects valid passwords']);
      assert.equal(outcome.decision?.verdict, 'pass', JSON.stringify(outcome.decision?.reasons));
    } finally {
      await ht.close();
    }
  });

  test('failure path: a server whose *Env variable is missing is unavailable (nothing spawned), never unauthenticated', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const logger = new MemoryLogger();
    const env = { ...process.env, HT_TEST_TICKETS_FILE: join(dir.path, 'unused.jsonl'), HT_TEST_TRACKER_AUTH: `Bearer ${TOKEN}` };
    const own = await testStore();
    const ht = await createHypertest(config(join(dir.path, 'data-missing'), own.store, tracker.url), { scriptedBrains: { sim: roleRouter({ lead, executor: executor(results) }) }, logger, env });
    try {
      assert.ok(logger.entries.some((e) => e.msg.startsWith('MCP server is unavailable') && (e.fields?.['missing'] as string[]).includes('HT_TEST_TICKETS_TOKEN')));
      const outcome = await ht.run({ goal: 'File the login defect', target: { environmentId: 'tickets' } }, { timeoutMs: 120_000 });
      const create = results.find((r) => r.name === 'mcp__tickets__create_ticket' || r.name === 'mcp.tickets.create_ticket');
      assert.ok(create?.isError, JSON.stringify(results));
      assert.match(create!.content, /unavailable: .*HT_TEST_TICKETS_TOKEN/);
      // nothing reached the tracker: the server was never started without its credential
      await assert.rejects(readFile(join(dir.path, 'unused.jsonl'), 'utf8'), /ENOENT/);
      assert.ok(outcome.runId);
    } finally {
      await ht.close();
      await own.dispose();
    }
  });
});
