/**
 * PoC B brains — event-driven black-box defect loop on the bank API (environment `bank`).
 *
 *   lead Plan v1: one executor probing the transfer contract (oracle bank-api B1/B2) with api-response evidence
 *   → the executor opens two accounts, transfers 0 (400: correct) and -30 (201: DEFECT), reads the accounts back
 *     (money moved backwards) and /health (total conserved), and posts a P1 finding citing the HTTP evidence
 *   → finding.created wakes RCA and the TestDesigner through the reactors — the lead is not in the path:
 *     RCA reproduces with a direct request (stdout evidence), posts a hypothesis and confirms the finding;
 *     the TestDesigner writes, registers and runs a black-box regression test (it fails on the defect: known-bad
 *     test-result of that artifact) — Finding → Hypothesis → Test → Evidence
 *   → finding.confirmed wakes the independent reviewer, who judges the recorded HTTP exchange
 *   → plan drained → lead Plan v2 readyForGate ⇒ fail (B1 violated, unresolved P1).
 */
import type { JsonValue } from '@hypertest/core';
import { evIds, inputRecord, jsonOf, leadReply, recIds, resultText, str, toolCall, type BrainView, type RoleBrain } from './kit.ts';
import { pocReviewer, reviewerOfFinding, reviewerOfRun } from './poc-a.ts';

export const BANK_ENV_ID = 'bank';
export const BANK_ORACLE_ID = 'bank-api';
export const REGRESSION_TEST_PATH = 'regression/negative-transfer.test.mjs';

const OBJECTIVE = {
  objectiveId: 'obj-transfers',
  description: 'Decide from HTTP evidence whether the bank API transfer contract (oracle bank-api B1, B2) holds on the candidate.',
  priority: 'P1',
  acceptanceCriteria: ['non-positive transfer amounts were exercised against POST /transfers with api-response evidence', 'the balance invariant was checked on /health'],
};

function leadComplete(summary: string, ready: boolean, evidenceRefs: string[]) {
  return toolCall('complete_work', {
    summary, evidenceRefs,
    output: { summary, planProposed: true, readyForGate: ready, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status: ready ? 'satisfied' : 'open', evidenceRefs }] },
  });
}

/** The lead plans ONE executor item; everything after the finding happens through reactors, not through the lead. */
export const pocBLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return leadReply('black-box target: probe the transfer contract directly, the reactors take the defect loop', 'plan.propose_revision', {
        rationale: 'Plan v1: probe POST /transfers of environment bank against oracle bank-api (B1 non-positive amounts ⇒ 400, B2 balance conservation) and record every exchange.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'probe-transfers', title: 'Probe the transfer contract', role: 'executor', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Against environment ${BANK_ENV_ID}: open two accounts, POST /transfers with amount 0 and with a negative amount (oracle bank-api B1 expects 400 for both), read the accounts back and GET /health (B2: balanceConserved). Post an evidence-backed finding for every violation.`,
            evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1, critical: true }],
          },
        ],
      });
    }
    return leadComplete('Plan v1 proposed: one executor probing the transfer contract.', false, []);
  }
  if (v.step === 0) return toolCall('evidence.query', { evidenceType: 'api-response' });
  const ev = evIds(resultText(v, 0)).slice(0, 3);
  if (v.step === 1) {
    return leadReply('the probe ran, the reactions analysed and reviewed the defect: the gate decides', 'plan.propose_revision', {
      rationale: `Plan v2: the transfer contract was probed with HTTP evidence (${ev.join(', ')}); the defect was analysed by RCA, covered by a regression test and independently reviewed through the blackboard. Hand over to the QualityGate.`,
      objectives: [{ ...OBJECTIVE, status: 'satisfied' }],
      workItems: [],
      readyForGate: true,
    });
  }
  return leadComplete('Plan v2: ready for the gate.', true, ev);
};

// ------------------------------------------------------------------------------------------------ executor

/** `HTTP <status>` of an http.request result. */
function statusOf(text: string): number | undefined {
  const m = /^HTTP (\d{3})/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** The request URL of an http.request result (`— POST http://host:port/path (`). */
function urlOf(text: string): string | undefined {
  return /— [A-Z]+ (https?:\/\/\S+) \(/.exec(text)?.[1];
}

/** Executor: accounts → transfers (0, -30) → read back → /health → finding for the accepted negative transfer → complete. */
export const pocBExecutor: RoleBrain = (v) => {
  const acc = (i: number): string | undefined => /"id":"(acc-\d+)"/.exec(resultText(v, i))?.[1];
  switch (v.step) {
    case 0:
      return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/accounts', json: { owner: 'alice', balance: 100 } });
    case 1:
      return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/accounts', json: { owner: 'bob', balance: 50 } });
    case 2:
      return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/transfers', json: { from: acc(0)!, to: acc(1)!, amount: 0 } });
    case 3:
      return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/transfers', json: { from: acc(0)!, to: acc(1)!, amount: -30 } });
    case 4:
      return toolCall('http.request', { method: 'GET', environmentId: BANK_ENV_ID, path: `/accounts/${acc(0)!}` });
    case 5:
      return toolCall('http.request', { method: 'GET', environmentId: BANK_ENV_ID, path: '/health' });
    default:
      break;
  }
  const zero = resultText(v, 2);
  const negative = resultText(v, 3);
  const readBack = resultText(v, 4);
  const health = resultText(v, 5);
  const zeroEv = evIds(zero);
  const negEv = evIds(negative);
  const readEv = evIds(readBack);
  const healthEv = evIds(health);
  const defect = statusOf(negative) !== 400;
  if (defect && v.step === 6) {
    const balance = /"balance":(-?\d+)/.exec(readBack)?.[1] ?? '?';
    const url = urlOf(negative) ?? `(environment ${BANK_ENV_ID}) /transfers`;
    return toolCall('blackboard.post_finding', {
      title: 'POST /transfers accepts a negative amount and moves money backwards',
      description: `POST /transfers with amount -30 from ${acc(0)} to ${acc(1)} returned ${statusOf(negative)} instead of 400; afterwards ${acc(0)} holds ${balance} (it opened with 100): the recipient paid the sender. Amount 0 is rejected with ${statusOf(zero)}. Oracle bank-api B1 requires every non-positive transfer amount to be rejected with 400.`,
      severity: 'P1',
      category: 'product_defect',
      component: 'POST /transfers',
      expected: '400 for a non-positive amount (bank-api B1)',
      actual: `${statusOf(negative)} and the balances moved backwards`,
      reproduction: `POST ${url} {"from":"${acc(0)}","to":"${acc(1)}","amount":-30}`,
      oracleRef: { oracleId: BANK_ORACLE_ID, revision: 1, assertionId: 'B1' },
      evidenceRefs: [...negEv, ...readEv],
    });
  }
  const findings = defect ? recIds(resultText(v, 6)).slice(0, 1) : [];
  const conserved = /"balanceConserved":true/.test(health);
  const summary = `Transfer probe: amount 0 ⇒ ${statusOf(zero)}, amount -30 ⇒ ${statusOf(negative)}${defect ? ' (DEFECT: accepted)' : ''}; /health balanceConserved=${conserved}.`;
  const executed: JsonValue[] = [
    { selector: 'POST /transfers amount 0', passed: statusOf(zero) === 400, outcome: statusOf(zero) === 400 ? 'passed' : 'failed', evidenceIds: zeroEv },
    { selector: 'POST /transfers amount -30', passed: !defect, outcome: defect ? 'failed' : 'passed', evidenceIds: [...negEv, ...readEv] },
    { selector: 'GET /health balanceConserved', passed: conserved, outcome: conserved ? 'passed' : 'failed', evidenceIds: healthEv },
  ];
  return toolCall('complete_work', { summary, evidenceRefs: [...zeroEv, ...negEv, ...readEv, ...healthEv], recordRefs: findings, output: { summary, executed, findings } });
};

// ------------------------------------------------------------------------------------------------ RCA (reaction)

function reproScript(url: string, from: string, to: string): string {
  return `const r = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, amount: -1 }) }); console.log(JSON.stringify({ status: r.status, body: await r.json() }));`;
}

/** RCA: inspect the HTTP evidence → reproduce with a direct request (stdout evidence) → hypothesis → confirm → complete. */
export const pocBRca: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  const p = finding.payload;
  const repro = /^POST (\S+) (\{.*\})$/.exec(String(p['reproduction'] ?? ''));
  switch (v.step) {
    case 0:
      return toolCall('evidence.get', { evidenceId: finding.evidenceRefs[0]! });
    case 1: {
      if (!repro) return toolCall('fail_work', { reason: 'agent_failed', message: 'the finding has no reproducible request' });
      const body = JSON.parse(repro[2]!) as { from: string; to: string };
      return toolCall('shell.exec', { command: ['node', '--input-type=module', '-e', reproScript(repro[1]!, body.from, body.to)] });
    }
    case 2:
      return toolCall('blackboard.post_hypothesis', {
        findingRecordId: finding.recordId,
        statement: 'The POST /transfers validation rejects only amount === 0 instead of every amount <= 0: a negative amount passes validation, the insufficient-funds check (balance < amount) can never trigger for it, and the debit/credit then runs backwards.',
        status: 'supported',
        confidence: 0.85,
        suggestedChecks: ['POST /transfers with amount -1 (reproduced: 201)', 'POST /transfers with amount 0 (400)'],
        evidenceRefs: [...finding.evidenceRefs, ...evIds(resultText(v, 1))],
      });
    case 3: {
      const out = resultText(v, 1);
      if (!/"status":201/.test(out)) return toolCall('fail_work', { reason: 'agent_failed', message: `the reproduction did not show the defect: ${out.slice(0, 300)}` });
      return toolCall('blackboard.post_finding', {
        updatesRecordId: finding.recordId,
        title: String(p['title']), description: String(p['description']), severity: String(p['severity']), category: String(p['category']),
        component: String(p['component'] ?? 'POST /transfers'), expected: String(p['expected'] ?? ''), actual: String(p['actual'] ?? ''),
        reproduction: String(p['reproduction'] ?? ''), oracleRef: p['oracleRef'] as JsonValue, status: 'confirmed',
        evidenceRefs: [...finding.evidenceRefs, ...evIds(out)],
      });
    }
    default: {
      const hypothesis = str(jsonOf(resultText(v, 2)), 'recordId')!;
      const reproEv = evIds(resultText(v, 1));
      const summary = 'Reproduced (amount -1 ⇒ 201): the transfer validation only rejects zero; hypothesis posted, finding confirmed.';
      return toolCall('complete_work', {
        summary, evidenceRefs: reproEv, recordRefs: [hypothesis, finding.recordId],
        output: { summary, hypotheses: [hypothesis], rootCause: { status: 'hypothesis', statement: 'validation rejects only amount === 0 instead of amount <= 0', evidenceRefs: reproEv }, reproduction: 'always', findingRecordId: finding.recordId },
      });
    }
  }
};

// ------------------------------------------------------------------------------------------------ TestDesigner (reaction)

export function regressionTest(baseUrl: string): string {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = ${JSON.stringify(baseUrl)};

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

// bank-api B1: non-positive transfer amounts are rejected with 400
test('a negative transfer amount is rejected with 400', async () => {
  const a = await post('/accounts', { owner: 'regression-a', balance: 10 });
  const b = await post('/accounts', { owner: 'regression-b', balance: 10 });
  const t = await post('/transfers', { from: a.json.id, to: b.json.id, amount: -5 });
  assert.equal(t.status, 400);
});
`;
}

/** TestDesigner reaction: write → register → run (fails on the defect: known-bad of this artifact) → validate → complete. */
export const pocBTestDesigner: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  const base = /^POST (https?:\/\/[^/\s]+)\//.exec(String(finding.payload['reproduction'] ?? ''))?.[1];
  if (!base) return toolCall('fail_work', { reason: 'agent_failed', message: 'the finding names no reproducible endpoint' });
  switch (v.step) {
    case 0:
      return toolCall('fs.write', { path: REGRESSION_TEST_PATH, content: regressionTest(base) });
    case 1:
      return toolCall('test_artifact.register', {
        path: REGRESSION_TEST_PATH, sourceType: 'generated', runner: { framework: 'node_test', selector: REGRESSION_TEST_PATH },
        oracleRefs: [{ oracleId: BANK_ORACLE_ID, revision: 1, assertionIds: ['B1'] }],
      });
    case 2:
      return toolCall('test.run', { framework: 'node_test', selector: REGRESSION_TEST_PATH, testArtifactIds: [str(jsonOf(resultText(v, 1)), 'artifactId')!] });
    case 3: {
      const run = resultText(v, 2);
      const artifactId = str(jsonOf(resultText(v, 1)), 'artifactId')!;
      return toolCall('test_artifact.validate', /NOT PASSED/.test(run) ? { artifactId, knownBadEvidenceId: evIds(run).at(-1)! } : { artifactId, knownGoodEvidenceId: evIds(run).at(-1)! });
    }
    default: {
      const artifactId = str(jsonOf(resultText(v, 1)), 'artifactId')!;
      const ev = evIds(resultText(v, 2)).at(-1)!;
      const summary = `Regression test ${REGRESSION_TEST_PATH} (artifact ${artifactId}) for finding ${finding.recordId}: it fails on the defective service (known-bad ${ev}); the known-good run awaits a fix.`;
      return toolCall('complete_work', { summary, evidenceRefs: [ev], recordRefs: [finding.recordId], output: { summary, testArtifacts: [{ artifactId, path: REGRESSION_TEST_PATH, covers: [finding.recordId], evidenceRefs: [ev] }] } });
    }
  }
};

// ------------------------------------------------------------------------------------------------ reviewer (reaction)

/** An api-response of POST /transfers with a negative amount that was answered 201. */
function acceptedNegativeTransfer(structured: unknown): boolean {
  const s = structured as { request?: { method?: unknown; path?: unknown; body?: unknown }; response?: { status?: unknown } } | undefined;
  if (!s?.request || s.request.method !== 'POST' || s.request.path !== '/transfers' || s.response?.status !== 201) return false;
  try {
    const body = JSON.parse(String(s.request.body)) as { amount?: unknown };
    return typeof body.amount === 'number' && body.amount < 0;
  } catch {
    return false;
  }
}

export const pocBReviewer: RoleBrain = pocReviewer(
  reviewerOfFinding({ evidenceType: 'api-response', supports: acceptedNegativeTransfer, what: 'POST /transfers with a negative amount answered 201' }),
  reviewerOfRun({ evidenceType: 'api-response', supports: acceptedNegativeTransfer, what: 'POST /transfers with a negative amount answered 201' }),
);

export const POC_B_ROLES: Record<string, RoleBrain> = {
  lead: pocBLead,
  executor: pocBExecutor,
  rca: pocBRca,
  test_designer: pocBTestDesigner,
  reviewer: pocBReviewer,
};

export type { BrainView };
