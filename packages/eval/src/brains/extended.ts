/**
 * Brains of the extended core suites (F[5], F[6], F[7]): API/UI black-box, FaultTolerance, MultiAgent (delegation and
 * convergence), the chaos cases (competing fault experiments, an unqueryable target) — deterministic role policies over
 * the request, like every PoC brain (see kit.ts). Performance, Evidence and the other chaos cases reuse the PoC C
 * policies (see brains/index.ts).
 */
import { sleep, type JsonValue } from '@hypertest/core';
import type { ScriptedReply } from '@hypertest/model';
import {
  evIds, inputRecord, jsonOf, leadReply, opIds, recIds, resultText, str, targetCommits, toolCall, type BrainView, type RoleBrain,
} from './kit.ts';
import { KV_ENV_ID, KV_LOAD, pocCEnvironment, settled } from './poc-c.ts';
import { BANK_ENV_ID, POC_B_ROLES, pocBExecutor, pocBLead } from './poc-b.ts';
import { pocReviewer, reviewerOfFinding, reviewerOfRun, POC_A_ROLES, LEDGER_ORACLE_ID } from './poc-a.ts';

/** Several tool calls in one assistant turn (they run in parallel). */
function toolCalls(calls: Array<{ name: string; args: JsonValue }>, text?: string): ScriptedReply {
  return { ...(text !== undefined ? { text } : {}), toolCalls: calls.map((c) => ({ name: c.name.split('.').join('__'), arguments: c.args })) };
}

/** A lead's final replan: query the evidence of `evidenceType`, hand over to the gate, complete. */
function finalLead(v: BrainView, objective: { objectiveId: string; description: string; priority: string; acceptanceCriteria: string[] }, evidenceType: string, rationale: string) {
  if (v.step === 0) return toolCall('evidence.query', { evidenceType });
  const ev = evIds(resultText(v, 0)).slice(0, 3);
  if (v.step === 1) {
    return leadReply('the planned work is done: the gate decides', 'plan.propose_revision', {
      rationale: `${rationale} (${ev.join(', ') || 'no evidence'}). Hand over to the QualityGate.`,
      objectives: [{ ...objective, status: 'satisfied' }],
      workItems: [],
      readyForGate: true,
    });
  }
  return toolCall('complete_work', { summary: 'Final plan: ready for the gate.', evidenceRefs: ev, output: { summary: 'Final plan: ready for the gate.', planProposed: true, readyForGate: true, objectives: [{ objectiveId: objective.objectiveId, status: 'satisfied', evidenceRefs: ev }] } });
}

function planned(summary: string, objectiveId: string) {
  return toolCall('complete_work', { summary, output: { summary, planProposed: true, readyForGate: false, objectives: [{ objectiveId, status: 'open', evidenceRefs: [] }] } });
}

// ================================================================================================ UI black-box

export const BANK_UI_ORACLE_ID = 'bank-ui';
/** What the UI must show for a rejected transfer of amount 0 (oracle bank-ui U1). */
export const UI_REJECTED_MESSAGE = 'Transfer rejected: amount must be positive';
export const UI_REGRESSION_TEST_PATH = 'regression/ui-result-message.test.mjs';

const UI_OBJECTIVE = {
  objectiveId: 'obj-ui-transfers',
  description: `Decide from what the bank UI shows (oracle ${BANK_UI_ORACLE_ID} U1) whether a rejected transfer is reported to the user as rejected.`,
  priority: 'P1',
  acceptanceCriteria: ['a transfer of amount 0 was submitted through the UI form', 'the outcome the page shows is dom-snapshot evidence'],
};

export const uiLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return toolCall('experiment.define', {
        hypothesis: `the bank UI reports a rejected transfer (amount 0, answered 400 by the API) as rejected (${BANK_UI_ORACLE_ID} U1)`,
        environmentId: BANK_ENV_ID, isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'dom-snapshot', minCount: 1 }],
      });
    }
    if (v.step === 1) {
      const experimentId = str(jsonOf(resultText(v, 0)), 'experimentId');
      return leadReply('a UI-only behaviour: drive the page in a real browser and read what it shows', 'plan.propose_revision', {
        rationale: 'Plan v1: exercise the transfer form of the bank UI with a rejected amount and record the page outcome as dom-snapshot evidence.',
        objectives: [UI_OBJECTIVE],
        workItems: [{
          localId: 'ui-transfer', title: 'Submit a rejected transfer through the UI', role: 'executor', dependsOn: [], objectiveIds: [UI_OBJECTIVE.objectiveId],
          ...(experimentId ? { inputRefs: [{ kind: 'experiment', id: experimentId }] } : {}),
          objective: `Against environment ${BANK_ENV_ID}: open two accounts (http.request POST /accounts), then in the browser open the page /ui, fill #from, #to and #amount (0), click #send and read the outcome shown in #result (oracle ${BANK_UI_ORACLE_ID} U1: "${UI_REJECTED_MESSAGE}"). Post an evidence-backed finding for every violation.`,
          evidenceRequirements: [{ evidenceType: 'dom-snapshot', minCount: 1, critical: true }],
        }],
      });
    }
    return planned('Plan v1 proposed: the UI transfer probe.', UI_OBJECTIVE.objectiveId);
  }
  return finalLead(v, UI_OBJECTIVE, 'dom-snapshot', 'Final plan: the UI was exercised with dom-snapshot evidence; the defect was analysed and covered through the blackboard');
};

/** UI executor: accounts → page → form → click → #result text → finding when it is not the rejection → complete. */
export const uiExecutor: RoleBrain = (v) => {
  const acc = (i: number): string | undefined => /"id":"(acc-\d+)"/.exec(resultText(v, i))?.[1];
  switch (v.step) {
    case 0: return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/accounts', json: { owner: 'ui-alice', balance: 100 } });
    case 1: return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/accounts', json: { owner: 'ui-bob', balance: 50 } });
    case 2: return toolCall('browser.navigate', { environmentId: BANK_ENV_ID, path: '/ui' });
    case 3: return toolCall('browser.fill', { environmentId: BANK_ENV_ID, selector: '#from', value: acc(0) ?? '' });
    case 4: return toolCall('browser.fill', { environmentId: BANK_ENV_ID, selector: '#to', value: acc(1) ?? '' });
    case 5: return toolCall('browser.fill', { environmentId: BANK_ENV_ID, selector: '#amount', value: '0' });
    case 6: return toolCall('browser.click', { environmentId: BANK_ENV_ID, selector: '#send' });
    // the outcome is rendered once the API answered: wait for a non-empty #result
    case 7: return toolCall('browser.text', { environmentId: BANK_ENV_ID, selector: '#result:not(:empty)' });
    case 8: return toolCall('browser.screenshot', { environmentId: BANK_ENV_ID });
    // what the API itself answers for the same transfer (the UI and the API are compared)
    case 9: return toolCall('http.request', { method: 'POST', environmentId: BANK_ENV_ID, path: '/transfers', json: { from: acc(0) ?? '', to: acc(1) ?? '', amount: 0 } });
    default: break;
  }
  // browser.text answers the text, then the evidence line
  const shown = resultText(v, 7).split('\n[dom-snapshot evidence')[0]!.trim();
  const domEv = evIds(resultText(v, 7));
  const shot = evIds(resultText(v, 8));
  const apiEv = evIds(resultText(v, 9));
  const apiStatus = /^HTTP (\d{3})/.exec(resultText(v, 9))?.[1] ?? '?';
  const pageEv = evIds(resultText(v, 2));
  const defect = shown !== UI_REJECTED_MESSAGE;
  const base = /"url":"(https?:\/\/[^/"]+)\//.exec(resultText(v, 2))?.[1];
  if (defect && v.step === 10) {
    return toolCall('blackboard.post_finding', {
      title: 'The transfer page reports a rejected transfer as complete',
      description: `Submitting a transfer of amount 0 through the bank UI shows "${shown}" in #result although the API rejects that transfer (POST /transfers answered ${apiStatus}). Oracle ${BANK_UI_ORACLE_ID} U1 requires "${UI_REJECTED_MESSAGE}".`,
      severity: 'P1', category: 'product_defect', component: 'bank UI /ui transfer form',
      expected: UI_REJECTED_MESSAGE, actual: shown,
      reproduction: `UI ${base ?? `(environment ${BANK_ENV_ID})`}/ui: amount 0 → #result`,
      oracleRef: { oracleId: BANK_UI_ORACLE_ID, revision: 1, assertionId: 'U1' },
      evidenceRefs: [...domEv, ...shot, ...apiEv],
    });
  }
  const findings = defect ? recIds(resultText(v, 10)).slice(0, 1) : [];
  const summary = `UI transfer of amount 0: the page shows "${shown}"${defect ? ' (DEFECT: the rejection is not shown)' : ''}.`;
  return toolCall('complete_work', {
    summary, evidenceRefs: [...pageEv, ...domEv, ...shot, ...apiEv], recordRefs: findings,
    output: { summary, executed: [{ selector: 'UI transfer amount 0 → #result', passed: !defect, outcome: defect ? 'failed' : 'passed', evidenceIds: domEv }], findings },
  });
};

/** A script printing what the served UI code renders for a 400 answer. */
export function uiProbeScript(base: string): string {
  return `const src = await (await fetch(${JSON.stringify(`${base}/ui/app.js`)})).text(); const resultMessage = new Function(src + '; return resultMessage;')(); console.log(JSON.stringify({ on400: resultMessage(400, { error: 'invalid_amount', message: 'amount must be positive' }), on201: resultMessage(201, { transferId: 'tx-1' }) }));`;
}

function uiBase(v: BrainView): string | undefined {
  return /^UI (https?:\/\/[^/\s]+)\/ui/.exec(String(inputRecord(v, 'finding')?.payload['reproduction'] ?? ''))?.[1];
}

/** RCA reaction: the served page code → what it renders for a 400 → hypothesis → confirm → complete. */
export const uiRca: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  const base = uiBase(v);
  if (!base) return toolCall('fail_work', { reason: 'agent_failed', message: 'the finding names no UI endpoint' });
  const p = finding.payload;
  switch (v.step) {
    case 0: return toolCall('shell.exec', { command: ['node', '--input-type=module', '-e', uiProbeScript(base)] });
    case 1:
      return toolCall('blackboard.post_hypothesis', {
        findingRecordId: finding.recordId,
        statement: `The page's resultMessage(status, body) ignores the HTTP status: for a 400 answer it renders ${JSON.stringify(str(jsonOf(resultText(v, 0)), 'on400') ?? '?')}, the same text as for a completed transfer — the UI never shows the API's rejection.`,
        status: 'supported', confidence: 0.9,
        suggestedChecks: ['resultMessage(400, …) in the served /ui/app.js (reproduced)'],
        evidenceRefs: [...finding.evidenceRefs, ...evIds(resultText(v, 0))],
      });
    case 2: {
      if (str(jsonOf(resultText(v, 0)), 'on400') === UI_REJECTED_MESSAGE) return toolCall('fail_work', { reason: 'agent_failed', message: 'the served UI code renders the rejection correctly: not reproduced' });
      return toolCall('blackboard.post_finding', {
        updatesRecordId: finding.recordId, title: String(p['title']), description: String(p['description']), severity: String(p['severity']), category: String(p['category']),
        component: String(p['component'] ?? 'bank UI'), expected: String(p['expected'] ?? ''), actual: String(p['actual'] ?? ''), reproduction: String(p['reproduction'] ?? ''),
        oracleRef: p['oracleRef'] as JsonValue, status: 'confirmed', evidenceRefs: [...finding.evidenceRefs, ...evIds(resultText(v, 0))],
      });
    }
    default: {
      const hypothesis = str(jsonOf(resultText(v, 1)), 'recordId')!;
      const ev = evIds(resultText(v, 0));
      const summary = 'Reproduced: the served UI code renders "Transfer complete" for a 400 answer; hypothesis posted, finding confirmed.';
      return toolCall('complete_work', { summary, evidenceRefs: ev, recordRefs: [hypothesis, finding.recordId], output: { summary, hypotheses: [hypothesis], rootCause: { status: 'hypothesis', statement: 'resultMessage ignores the HTTP status', evidenceRefs: ev }, reproduction: 'always', findingRecordId: finding.recordId } });
    }
  }
};

/** The UI regression test: the served page code must render the rejection for a 400 answer. */
export function uiRegressionTest(base: string): string {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = ${JSON.stringify(base)};

// bank-ui U1: a rejected transfer is shown as rejected
test('the transfer page renders the rejection of a 400 answer', async () => {
  const src = await (await fetch(BASE + '/ui/app.js')).text();
  const resultMessage = new Function(src + '; return resultMessage;')();
  assert.equal(resultMessage(400, { error: 'invalid_amount', message: 'amount must be positive' }), ${JSON.stringify(UI_REJECTED_MESSAGE)});
});
`;
}

/** TestDesigner reaction: write → register (U1) → run (fails on the defect) → validate → complete. */
export const uiTestDesigner: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  const base = uiBase(v);
  if (!base) return toolCall('fail_work', { reason: 'agent_failed', message: 'the finding names no UI endpoint' });
  const artifactId = () => str(jsonOf(resultText(v, 1)), 'artifactId')!;
  switch (v.step) {
    case 0: return toolCall('fs.write', { path: UI_REGRESSION_TEST_PATH, content: uiRegressionTest(base) });
    case 1:
      return toolCall('test_artifact.register', {
        path: UI_REGRESSION_TEST_PATH, sourceType: 'generated', runner: { framework: 'node_test', selector: UI_REGRESSION_TEST_PATH },
        oracleRefs: [{ oracleId: BANK_UI_ORACLE_ID, revision: 1, assertionIds: ['U1'] }],
      });
    case 2: return toolCall('test.run', { framework: 'node_test', selector: UI_REGRESSION_TEST_PATH, testArtifactIds: [artifactId()] });
    case 3: {
      const run = resultText(v, 2);
      return toolCall('test_artifact.validate', /NOT PASSED/.test(run)
        ? { artifactId: artifactId(), knownBadEvidenceId: evIds(run).at(-1)!, knownGoodUnavailableReason: 'the defective UI is the only deployment: no fixed build exists to run the regression against' }
        : { artifactId: artifactId(), knownGoodEvidenceId: evIds(run).at(-1)! });
    }
    default: {
      const ev = evIds(resultText(v, 2)).at(-1)!;
      const summary = `Regression ${UI_REGRESSION_TEST_PATH} (artifact ${artifactId()}) for finding ${finding.recordId}: it fails on the defective UI (known-bad ${ev}).`;
      return toolCall('complete_work', { summary, evidenceRefs: [ev], recordRefs: [finding.recordId], output: { summary, testArtifacts: [{ artifactId: artifactId(), path: UI_REGRESSION_TEST_PATH, covers: [finding.recordId], evidenceRefs: [ev] }] } });
    }
  }
};

/** A dom-snapshot showing a transfer as complete (what the UI finding rests on). */
export function showsComplete(structured: unknown): boolean {
  const s = structured as { text?: unknown } | undefined;
  return typeof s?.text === 'string' && s.text.trim() === 'Transfer complete';
}

export const uiReviewer: RoleBrain = pocReviewer(
  reviewerOfFinding({ evidenceType: 'dom-snapshot', supports: showsComplete, what: 'the page reporting the rejected transfer as complete' }),
  reviewerOfRun({ evidenceType: 'dom-snapshot', supports: showsComplete, what: 'the page reporting the rejected transfer as complete' }),
);

export const UI_ROLES: Record<string, RoleBrain> = { lead: uiLead, executor: uiExecutor, rca: uiRca, test_designer: uiTestDesigner, reviewer: uiReviewer };

// ================================================================================================ FaultTolerance

export const KV_RESILIENCE_ORACLE_ID = 'kv-resilience';
/** The controlled faults of the FaultTolerance suite. */
export const FT_FAULTS = Object.freeze({
  latency: { kind: 'latency', params: { ms: 120 } },
  errors: { kind: 'error_rate', params: { rate: 0.2, status: 503 } },
} as const);
export type FtVariant = keyof typeof FT_FAULTS;
/** How long an injected fault lasts (it covers the load job that follows it). */
export const FT_FAULT_MS = 6000;

export function ftVariantOf(taskId: string): FtVariant {
  return /errors|error-rate/.test(taskId) ? 'errors' : 'latency';
}

function ftExperiment(variant: FtVariant): JsonValue {
  const f = FT_FAULTS[variant];
  return {
    hypothesis: `kv-service keeps its error rate below 1% (${KV_RESILIENCE_ORACLE_ID} R1) under a controlled ${f.kind} fault and serves again after it (R2)`,
    environmentId: KV_ENV_ID,
    faultPlan: [{ kind: f.kind, target: KV_ENV_ID, params: f.params }],
    workload: { kind: 'http_load', ratePerSecond: KV_LOAD.ratePerSecond, durationMs: KV_LOAD.durationMs, concurrency: KV_LOAD.concurrency },
    stopConditions: [{ kind: 'error_rate_above', value: 0.5 }],
    evidenceRequirements: [{ evidenceType: 'metric', minCount: 1 }],
  };
}

const FT_OBJECTIVE = {
  objectiveId: 'obj-resilience',
  description: `Decide from metric and HTTP evidence whether kv-service tolerates a controlled fault (oracle ${KV_RESILIENCE_ORACLE_ID}: R1 error rate < 1% under the fault, R2 /health answers 200 after it).`,
  priority: 'P1',
  acceptanceCriteria: ['a controlled fault was injected through the governed tool', 'a load job ran under the fault', 'the service was checked after the fault expired'],
};

export function ftLead(variant: FtVariant): RoleBrain {
  const f = FT_FAULTS[variant];
  return (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) return toolCall('experiment.define', ftExperiment(variant));
      if (v.step === 1) {
        const experimentId = str(jsonOf(resultText(v, 0)), 'experimentId');
        const refs = experimentId ? { inputRefs: [{ kind: 'experiment', id: experimentId }] } : {};
        return leadReply('fault tolerance: inject the planned fault, measure under it, check recovery after it', 'plan.propose_revision', {
          rationale: `Plan v1: inject the experiment's ${f.kind} fault, run the 30 rps load under it, quantify the error rate from the job's metric evidence, and check the service after the fault expired.`,
          objectives: [FT_OBJECTIVE],
          workItems: [
            {
              localId: 'inject', title: `Inject the ${f.kind} fault`, role: 'environment', dependsOn: [], objectiveIds: [FT_OBJECTIVE.objectiveId], ...refs,
              objective: `Inject the experiment's fault into environment ${KV_ENV_ID} with env.inject_fault: kind ${f.kind}, params ${JSON.stringify(f.params)}, durationMs ${FT_FAULT_MS}. Report when the fault expires.`,
            },
            {
              localId: 'load', title: 'Run the 30 rps load under the fault', role: 'environment', dependsOn: ['inject'], objectiveIds: [FT_OBJECTIVE.objectiveId], ...refs,
              objective: `Run load.start against environment ${KV_ENV_ID}: ${KV_LOAD.method} ${KV_LOAD.path} at ${KV_LOAD.ratePerSecond} rps for ${KV_LOAD.durationMs} ms (concurrency ${KV_LOAD.concurrency}). Wait for the job, verify the achieved rate with metrics.scrape and report the load job's operation id.`,
              evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
            },
            {
              localId: 'analyse', title: 'Quantify the error rate under the fault', role: 'metrics_analyst', dependsOn: ['load'], objectiveIds: [FT_OBJECTIVE.objectiveId], ...refs,
              objective: `Quantify the error rate and latency of the load job reported by the load item against oracle ${KV_RESILIENCE_ORACLE_ID} R1 (error rate < 1% under the fault): load.observe the job and record critical claims citing its metric evidence.`,
              evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
            },
            {
              localId: 'recover', title: 'Check the service after the fault', role: 'executor', dependsOn: ['inject', 'analyse'], objectiveIds: [FT_OBJECTIVE.objectiveId],
              objective: `Once the injected fault has expired, check with http.request GET /health on environment ${KV_ENV_ID} that kv-service serves again (${KV_RESILIENCE_ORACLE_ID} R2).`,
            },
          ],
        });
      }
      return planned('Plan v1 proposed: fault, load, analysis, recovery check.', FT_OBJECTIVE.objectiveId);
    }
    return finalLead(v, FT_OBJECTIVE, 'metric', 'Final plan: the fault experiment ran with metric evidence and the recovery was checked');
  };
}

/** Injects the fault of the objective (env.inject_fault) and reports its expiry. */
function injectOperator(v: BrainView) {
  const m = /env\.inject_fault: kind (\w+), params (\{[^}]*\}), durationMs (\d+)/.exec(v.userText);
  if (!m) return toolCall('fail_work', { reason: 'agent_failed', message: 'the objective names no fault to inject' });
  if (v.step === 0) return toolCall('env.inject_fault', { environmentId: KV_ENV_ID, kind: m[1]!, params: JSON.parse(m[2]!) as JsonValue, durationMs: Number(m[3]) });
  const s = settled(v, 0, 'env.inject_fault');
  if (s.status !== 'verified') return toolCall('fail_work', { reason: 'agent_failed', message: `the fault injection did not verify (${s.status}): ${resultText(v, 0).slice(0, 300)}` });
  // the fault is observed on the service itself (a verified action cites evidence)
  if (v.step === 1) return toolCall('http.request', { method: 'GET', environmentId: KV_ENV_ID, path: '/kv/k2' });
  const all = `${resultText(v, 0)}\n${v.userText}`;
  const expiresAt = /"expiresAt":"([^"]+)"/.exec(all)?.[1];
  const observed = evIds(resultText(v, 1));
  const action: Record<string, JsonValue> = { action: 'env.inject_fault', target: KV_ENV_ID, status: 'verified', evidenceIds: observed };
  if (s.operationId) action['operationId'] = s.operationId;
  const summary = `fault ${m[1]} injected into ${KV_ENV_ID}${s.operationId ? ` (operation ${s.operationId})` : ''}, observed on GET /kv/k2 (${observed.join(', ')}); it expires at ${expiresAt ?? 'unknown'}.`;
  return toolCall('complete_work', { summary, evidenceRefs: observed, output: { summary, environmentReady: true, actions: [action] } });
}

/** Attempts of a read (metrics.scrape) that an injected error-rate fault may answer with an error. */
export const MAX_SCRAPE_ATTEMPTS = 5;

/**
 * The load under a fault: load.start → wait for the job → metrics.scrape (a read: retried while the injected fault answers
 * it with an error) → complete citing the scrape. Dispatches on the transcript.
 */
export const ftLoadOperator: RoleBrain = async (v) => {
  const starts = callsOf(v, 'load.start');
  if (starts.length === 0) return toolCall('load.start', { environmentId: KV_ENV_ID, ...KV_LOAD });
  const s = settled(v, v.toolResults.findIndex((r) => r.name.split('__').join('.') === 'load.start'), 'load.start');
  if (s.status !== 'verified') return toolCall('fail_work', { reason: 'agent_failed', message: `the load job did not complete (${s.status})` });
  const scrapes = callsOf(v, 'metrics.scrape');
  const last = scrapes.at(-1);
  if (!last || (last.isError && scrapes.length < MAX_SCRAPE_ATTEMPTS)) {
    if (last) await sleep(300);
    return toolCall('metrics.scrape', { environmentId: KV_ENV_ID });
  }
  const ev = evIds(last.content);
  if (last.isError || ev.length === 0) return toolCall('fail_work', { reason: 'agent_failed', message: `the service metrics could not be scraped (${scrapes.length} attempts): ${last.content.slice(0, 300)}` });
  const action: Record<string, JsonValue> = { action: 'load.start', target: KV_ENV_ID, status: 'verified', evidenceIds: ev };
  if (s.operationId) action['operationId'] = s.operationId;
  const summary = `load job ${s.operationId ?? '?'} completed (${KV_LOAD.ratePerSecond} rps × ${KV_LOAD.durationMs} ms of ${KV_LOAD.method} ${KV_LOAD.path}); the service counters on /metrics show the traffic (${ev.join(', ')}).`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, environmentReady: true, actions: [action] } });
};

export const ftEnvironment: RoleBrain = (v) => (/env\.inject_fault: kind/.test(v.userText) ? injectOperator(v) : /Run load\.start against environment/.test(v.userText) ? ftLoadOperator(v) : pocCEnvironment(v));

/** Load job results → critical claims of error rate and p99 → complete. */
export const ftMetricsAnalyst: RoleBrain = (v) => {
  const op = /load job (op_\w+) completed/.exec(v.userText)?.[1];
  if (!op) return toolCall('fail_work', { reason: 'agent_failed', message: 'the dependency results name no load job operation id' });
  if (v.step === 0) return toolCall('load.observe', { operationId: op });
  const observed = jsonOf(resultText(v, 0));
  const jobEv = str(observed, 'evidenceId') ?? evIds(resultText(v, 0))[0];
  const results = (observed['results'] ?? {}) as { latencyMs?: { p99?: number }; errorRate?: number | null; sent?: number };
  const errorRate = results.errorRate;
  const p99 = results.latencyMs?.p99;
  if (!jobEv || typeof errorRate !== 'number' || typeof p99 !== 'number') return toolCall('fail_work', { reason: 'agent_failed', message: `the load job results are incomplete: ${resultText(v, 0).slice(0, 300)}` });
  if (v.step === 1) {
    return toolCall('evidence.claim', {
      statement: `error rate of the load job ${op} under the injected fault is ${errorRate} (${KV_RESILIENCE_ORACLE_ID} R1: < 1%)`,
      value: errorRate, evidenceRefs: [jobEv], critical: true, evidenceQuery: { evidenceType: 'metric', field: 'errorRate' },
    });
  }
  const summary = `Load job ${op} under the fault: error rate ${errorRate}, p99 ${p99} ms over ${results.sent ?? '?'} requests.`;
  return toolCall('complete_work', {
    summary, evidenceRefs: [jobEv],
    output: {
      summary, dataSufficient: true, findings: [],
      observations: [
        { metric: 'errorRate', value: errorRate, window: `${KV_LOAD.durationMs} ms under the fault`, statement: `error rate ${errorRate}`, evidenceIds: [jobEv] },
        { metric: 'latencyMs', aggregation: 'p99', value: p99, window: `${KV_LOAD.durationMs} ms under the fault`, statement: `p99 ${p99} ms`, evidenceIds: [jobEv] },
      ],
    },
  });
};

/** Waits until the fault the dependency results name has expired, then checks /health → complete. */
export const ftExecutor: RoleBrain = async (v) => {
  if (v.step === 0) {
    const expiresAt = /it expires at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(v.userText)?.[1];
    const until = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(until)) return toolCall('fail_work', { reason: 'agent_failed', message: 'the dependency results name no fault expiry' });
    const wait = until + 300 - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 30_000));
    return toolCall('http.request', { method: 'GET', environmentId: KV_ENV_ID, path: '/health' });
  }
  const ev = evIds(resultText(v, 0));
  const status = Number(/^HTTP (\d{3})/.exec(resultText(v, 0))?.[1] ?? 0);
  const summary = `After the fault expired GET /health answered ${status || 'no status'} (${ev.join(', ')}).`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, executed: [{ selector: 'GET /health after the fault', passed: status === 200, outcome: status === 200 ? 'passed' : 'failed', evidenceIds: ev }], findings: [] } });
};

/** A load job's metric evidence (the run review judges the recorded numbers). */
export function hasLoadResults(structured: unknown): boolean {
  const s = structured as { errorRate?: unknown; latencyMs?: { p99?: unknown } } | undefined;
  return typeof s?.errorRate === 'number' && typeof s.latencyMs?.p99 === 'number';
}

export const ftReviewer: RoleBrain = reviewerOfRun({ evidenceType: 'metric', supports: hasLoadResults, what: "the load job's recorded error rate and latency under the injected fault" });

export function ftRoles(variant: FtVariant): Record<string, RoleBrain> {
  return { lead: ftLead(variant), environment: ftEnvironment, metrics_analyst: ftMetricsAnalyst, executor: ftExecutor, reviewer: ftReviewer };
}

// ================================================================================================ chaos: competing fault experiments

/** Attempts of a refused experiment.define (a competing experiment holds the environment) before giving up. */
export const MAX_ADMISSION_ATTEMPTS = 6;
/** Pause between refused admissions (a real agent backs off). */
export const ADMISSION_BACKOFF_MS = 4000;

const COMPETE_OBJECTIVE = {
  objectiveId: 'obj-compete',
  description: `Measure kv-service under two fault experiments (a latency fault and an error-rate fault) without either contaminating the other (oracle ${KV_RESILIENCE_ORACLE_ID} R1).`,
  priority: 'P1',
  acceptanceCriteria: ['each experiment ran its fault and its load', 'the experiments never overlapped on kv'],
};

export const competeLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      const item = (variant: FtVariant) => {
        const f = FT_FAULTS[variant];
        return {
          localId: `experiment-${variant}`, title: `Fault experiment: ${f.kind}`, role: 'environment', dependsOn: [], objectiveIds: [COMPETE_OBJECTIVE.objectiveId],
          objective: `Run your OWN fault experiment on environment ${KV_ENV_ID}: define it with experiment.define (fault ${f.kind} ${JSON.stringify(f.params)}, workload ${KV_LOAD.ratePerSecond} rps × ${KV_LOAD.durationMs} ms), then env.inject_fault: kind ${f.kind}, params ${JSON.stringify(f.params)}, durationMs ${FT_FAULT_MS}, then load.start ${KV_LOAD.method} ${KV_LOAD.path} under it. If the experiment is not admitted because another one holds ${KV_ENV_ID}, wait and define it again. Report the load job's operation id.`,
          evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
        };
      };
      const analyse = (variant: FtVariant) => ({
        localId: `analyse-${variant}`, title: `Error rate under the ${FT_FAULTS[variant].kind} fault`, role: 'metrics_analyst', dependsOn: [`experiment-${variant}`], objectiveIds: [COMPETE_OBJECTIVE.objectiveId],
        objective: `Quantify the error rate of the load job reported by the experiment-${variant} item against oracle ${KV_RESILIENCE_ORACLE_ID} R1: load.observe the job and record a critical claim citing its metric evidence.`,
        evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
      });
      return leadReply('two independent fault experiments in parallel: isolation must serialize them', 'plan.propose_revision', {
        rationale: 'Plan v1: a latency experiment and an error-rate experiment run in parallel on kv; each measures its own load; admission control must keep them from overlapping.',
        objectives: [COMPETE_OBJECTIVE],
        workItems: [item('latency'), item('errors'), analyse('latency'), analyse('errors')],
      });
    }
    return planned('Plan v1 proposed: two competing fault experiments.', COMPETE_OBJECTIVE.objectiveId);
  }
  return finalLead(v, COMPETE_OBJECTIVE, 'metric', 'Final plan: both fault experiments ran with metric evidence');
};

/** The tool calls of the transcript with their results, by tool id. */
function callsOf(v: BrainView, tool: string): Array<{ content: string; isError: boolean }> {
  return v.toolResults.filter((r) => r.name.split('__').join('.') === tool);
}

/**
 * One competing experiment: define (retried while refused) → inject its fault → load under it → complete. Dispatch on
 * the transcript (what was called and what came back), like a model would.
 */
export const competeEnvironment: RoleBrain = async (v) => {
  const m = /env\.inject_fault: kind (\w+), params (\{[^}]*\}), durationMs (\d+)/.exec(v.userText);
  if (!m) return toolCall('fail_work', { reason: 'agent_failed', message: 'the objective names no fault' });
  const kind = m[1]!;
  const params = JSON.parse(m[2]!) as JsonValue;
  const defines = callsOf(v, 'experiment.define');
  const last = defines.at(-1);
  if (!last || last.isError) {
    if (defines.length >= MAX_ADMISSION_ATTEMPTS) return toolCall('fail_work', { reason: 'agent_failed', message: `the experiment was refused ${defines.length} times: ${last?.content.slice(0, 300) ?? ''}` });
    if (last) await sleep(ADMISSION_BACKOFF_MS);
    return toolCall('experiment.define', {
      // a re-definition after a refusal says so (it is a new attempt, not a loop)
      hypothesis: `kv-service error rate under a ${kind} fault (${KV_RESILIENCE_ORACLE_ID} R1)${defines.length > 0 ? ` — attempt ${defines.length + 1}, after a competing experiment held ${KV_ENV_ID}` : ''}`,
      environmentId: KV_ENV_ID,
      faultPlan: [{ kind, target: KV_ENV_ID, params }],
      workload: { kind: 'http_load', ratePerSecond: KV_LOAD.ratePerSecond, durationMs: KV_LOAD.durationMs, concurrency: KV_LOAD.concurrency },
      stopConditions: [{ kind: 'error_rate_above', value: 0.5 }],
      evidenceRequirements: [{ evidenceType: 'metric', minCount: 1 }],
    });
  }
  const injected = callsOf(v, 'env.inject_fault');
  if (injected.length === 0) return toolCall('env.inject_fault', { environmentId: KV_ENV_ID, kind, params, durationMs: Number(m[3]) });
  const loads = callsOf(v, 'load.start');
  if (loads.length === 0) {
    if (injected.at(-1)!.isError) return toolCall('fail_work', { reason: 'agent_failed', message: `the fault was refused: ${injected.at(-1)!.content.slice(0, 300)}` });
    return toolCall('load.start', { environmentId: KV_ENV_ID, ...KV_LOAD });
  }
  const op = opIds(loads.at(-1)!.content)[0] ?? /- operation (op_\w+) \(load\.start\)/.exec(v.userText)?.[1];
  const loadDone = new RegExp(`- operation ${op ?? 'op_none'} \\(load\\.start\\) verified`).test(v.userText) || /^\[verified\]/.test(loads.at(-1)!.content);
  if (!loadDone) return toolCall('fail_work', { reason: 'agent_failed', message: `the load job did not complete: ${loads.at(-1)!.content.slice(0, 300)}` });
  const scrapes = callsOf(v, 'metrics.scrape');
  // a read the injected error-rate fault may answer with an error: retried
  if (scrapes.length === 0 || (scrapes.at(-1)!.isError && scrapes.length < MAX_SCRAPE_ATTEMPTS)) {
    if (scrapes.length > 0) await sleep(300);
    return toolCall('metrics.scrape', { environmentId: KV_ENV_ID });
  }
  const ev = evIds(scrapes.at(-1)!.content);
  if (ev.length === 0) return toolCall('fail_work', { reason: 'agent_failed', message: `the service metrics could not be scraped: ${scrapes.at(-1)!.content.slice(0, 300)}` });
  const experimentId = str(jsonOf(last.content), 'experimentId');
  const summary = `experiment ${experimentId ?? '?'} (${kind}) admitted after ${defines.length} attempt(s): fault injected; load job ${op ?? '?'} completed (${ev.join(', ')}).`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, environmentReady: true, actions: [{ action: 'load.start', target: KV_ENV_ID, status: 'verified', ...(op ? { operationId: op } : {}), evidenceIds: ev }] } });
};

/** Metrics of both experiments: each load job observed and claimed (any number of load jobs). */
export const competeMetricsAnalyst: RoleBrain = (v) => ftMetricsAnalyst(v);

export const COMPETE_ROLES: Record<string, RoleBrain> = { lead: competeLead, environment: competeEnvironment, metrics_analyst: competeMetricsAnalyst, reviewer: ftReviewer };

// ================================================================================================ chaos: unqueryable target

export const FLAG_ORACLE_ID = 'kv-flag';
export const FLAG_PATH = '/kv/maintenance';
export const FLAG_VALUE = 'on';

const FLAG_OBJECTIVE = {
  objectiveId: 'obj-flag',
  description: `Publish the maintenance flag of kv-service exactly once and decide whether it is served (oracle ${FLAG_ORACLE_ID}).`,
  priority: 'P1',
  acceptanceCriteria: ['the flag was written once', 'it reads back'],
};

export const flagLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return toolCall('experiment.define', {
        hypothesis: `the maintenance flag can be published once on kv-service and reads back (${FLAG_ORACLE_ID})`,
        environmentId: KV_ENV_ID, isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1 }],
      });
    }
    if (v.step === 1) {
      const experimentId = str(jsonOf(resultText(v, 0)), 'experimentId');
      return leadReply('one write, then read it back', 'plan.propose_revision', {
        rationale: 'Plan v1: publish the maintenance flag with one PUT and read it back.',
        objectives: [FLAG_OBJECTIVE],
        workItems: [{
          localId: 'publish', title: 'Publish the maintenance flag', role: 'executor', dependsOn: [], objectiveIds: [FLAG_OBJECTIVE.objectiveId],
          ...(experimentId ? { inputRefs: [{ kind: 'experiment', id: experimentId }] } : {}),
          objective: `On environment ${KV_ENV_ID}: http.request PUT ${FLAG_PATH} with body "${FLAG_VALUE}" (once), then GET ${FLAG_PATH} and report what it serves (oracle ${FLAG_ORACLE_ID}).`,
          evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1, critical: true }],
        }],
      });
    }
    return planned('Plan v1 proposed: publish the flag.', FLAG_OBJECTIVE.objectiveId);
  }
  return finalLead(v, FLAG_OBJECTIVE, 'api-response', 'Final plan: the flag was published and read back');
};

/** PUT once (its outcome may need a human: it waits) → GET → complete. */
export const flagExecutor: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('http.request', { method: 'PUT', environmentId: KV_ENV_ID, path: FLAG_PATH, body: FLAG_VALUE });
  if (v.step === 1) return toolCall('http.request', { method: 'GET', environmentId: KV_ENV_ID, path: FLAG_PATH });
  const put = `${resultText(v, 0)}\n${v.userText}`;
  const get = resultText(v, 1);
  const ev = [...evIds(put), ...evIds(get)];
  const summary = `PUT ${FLAG_PATH} settled (${/- operation (op_\w+) \(http\.request\) (\w+)/.exec(v.userText)?.[2] ?? /^\[(\w+)\]/.exec(resultText(v, 0))?.[1] ?? 'answered'}); GET answered ${/^HTTP (\d{3})/.exec(get)?.[1] ?? '?'}.`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, executed: [{ selector: `GET ${FLAG_PATH}`, passed: /^HTTP 200/.test(get), outcome: /^HTTP 200/.test(get) ? 'passed' : 'failed', evidenceIds: evIds(get) }], findings: [] } });
};

/** An api-response of GET /kv/maintenance serving the flag. */
export function servesFlag(structured: unknown): boolean {
  const s = structured as { request?: { method?: unknown; path?: unknown }; response?: { status?: unknown; body?: unknown } } | undefined;
  return s?.request?.method === 'GET' && s.request.path === FLAG_PATH && s.response?.status === 200 && typeof s.response.body === 'string' && s.response.body.includes(FLAG_VALUE);
}

export const FLAG_ROLES: Record<string, RoleBrain> = { lead: flagLead, executor: flagExecutor, reviewer: reviewerOfRun({ evidenceType: 'api-response', supports: servesFlag, what: `GET ${FLAG_PATH} serving the flag` }) };

// ================================================================================================ MultiAgent: delegation

const DELEGATION_OBJECTIVE = {
  objectiveId: 'obj-ledger',
  description: `Decide whether the candidate change of the ledger library keeps its contract (oracle ${LEDGER_ORACLE_ID}).`,
  priority: 'P1',
  acceptanceCriteria: ['the change was analysed by delegated analysts in parallel', 'the contract was tested on the candidate'],
};

/** The analysts the lead delegates to (one turn, three parallel delegate calls). */
export const DELEGATED_ROLES = Object.freeze(['code_change_analyst', 'architecture_analyst', 'historical_bug_analyst'] as const);

/**
 * Lead: delegates the three analyses in ONE turn (parallel children; it only receives their summaries) → reads the
 * risks → Plan v1 (two test designers + the executor) → final plan for the gate.
 */
export const delegationLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    const { head, base } = targetCommits(v);
    if (v.step === 0) {
      return toolCalls([
        { name: 'delegate', args: { role: 'code_change_analyst', title: 'Analyse the candidate diff', objective: `Analyse the change between base commit ${base ?? 'HEAD~1'} and the candidate ${head ?? 'HEAD'} (git.diff base..candidate) and post the behavioural risks of every changed function.` } },
        { name: 'delegate', args: { role: 'architecture_analyst', title: 'Map the ledger library', objective: 'Record the system model of the ledger library (components with their paths, public functions) and place the candidate change on it.' } },
        { name: 'delegate', args: { role: 'historical_bug_analyst', title: 'Mine the history of src/ledger.js', objective: 'Review the version history of src/ledger.js for defect-prone areas touched by the candidate and post the risks it predicts.' } },
      ], 'LEAD-PRIVATE-REASONING-7f3a: three independent analyses, delegated in parallel; I only need their summaries');
    }
    if (v.step === 1) {
      const done = [...v.userText.matchAll(/- delegation \S+ \((\w+)\) completed/g)].map((x) => x[1]!);
      if (DELEGATED_ROLES.some((r) => !done.includes(r))) return toolCall('fail_work', { reason: 'agent_failed', message: `not every delegated analysis completed: ${done.join(', ') || 'none'}` });
      // the delegated results are SUMMARIES (never the children's transcripts): the plan follows from what they report
      const paginationRisk = /paginate/i.test(v.userText);
      return leadReply('the delegated analyses point at paginate: design one test per assertion, then execute', 'plan.propose_revision', {
        rationale: `Plan v1: the delegated analyses reported ${paginationRisk ? 'an off-by-one risk in paginate (diff) and page-boundary regressions (history)' : 'no specific risk'}. Design one oracle-bound test per ledger-contract assertion in parallel, then execute the suite on the candidate.`,
        objectives: [DELEGATION_OBJECTIVE],
        workItems: [
          {
            localId: 'design-pagination', title: 'Design the pagination contract test', role: 'test_designer', dependsOn: [], objectiveIds: [DELEGATION_OBJECTIVE.objectiveId],
            objective: 'Design an oracle-bound node:test for ledger-contract A1 (paginate returns every item exactly once across pages): page through a list whose length is not a multiple of the page size. Register it and prove its sensitivity.',
          },
          {
            localId: 'design-transfer', title: 'Design the transfer conservation test', role: 'test_designer', dependsOn: [], objectiveIds: [DELEGATION_OBJECTIVE.objectiveId],
            objective: 'Design an oracle-bound node:test for ledger-contract A2 (applyTransfer conserves the total balance) over a chain of transfers. Register it and prove its sensitivity (a known-good run and a killed mutant).',
          },
          {
            localId: 'execute', title: 'Execute the suite on the candidate', role: 'executor', dependsOn: ['design-pagination', 'design-transfer'], objectiveIds: [DELEGATION_OBJECTIVE.objectiveId],
            objective: 'Run the complete node:test suite of the candidate (the designed tests are materialized in your worktree) and post an evidence-backed finding for every failure.',
            evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
          },
        ],
      });
    }
    return planned('Plan v1 proposed after the delegated analyses.', DELEGATION_OBJECTIVE.objectiveId);
  }
  return finalLead(v, DELEGATION_OBJECTIVE, 'test-result', 'Final plan: the candidate was executed with test-result evidence; the failure was analysed and reviewed');
};

/**
 * A DELEGATED analyst works within its parent's capability (I2): it cannot post risk records (the lead may not), so it
 * reports its risks in its result — the summary its parent receives. git.diff/git.log → complete with the risk.
 */
function delegatedAnalyst(tool: 'git.diff' | 'git.log', risk: { title: string; level: string; rationale: string }): RoleBrain {
  return (v) => {
    if (v.step === 0) {
      if (tool === 'git.log') return toolCall('git.log', { path: 'src/ledger.js', maxCount: 10 });
      const base = /base commit ([0-9a-f]{7,64})/.exec(v.userText)?.[1] ?? 'HEAD~1';
      const head = /candidate ([0-9a-f]{7,64})/.exec(v.userText)?.[1] ?? 'HEAD';
      return toolCall('git.diff', { base, head, paths: ['src/ledger.js'] });
    }
    const out = resultText(v, 0);
    const ev = evIds(out);
    const seen = tool === 'git.diff' ? /start \+ size - 1/.test(out) : /refactor pagination/.test(out);
    if (!seen) return toolCall('fail_work', { reason: 'agent_failed', message: `${tool} does not show the pagination change` });
    const summary = `${risk.title}: ${risk.rationale}`;
    return toolCall('complete_work', {
      summary, evidenceRefs: ev,
      output: { summary, risks: [{ title: risk.title, level: risk.level, rationale: risk.rationale, components: ['src/ledger.js'], evidenceRefs: ev }], testIdeas: ['page through [1..7] with page size 3 (ledger-contract A1)'] },
    });
  };
}

export const DELEGATION_ROLES: Record<string, RoleBrain> = {
  ...POC_A_ROLES,
  lead: delegationLead,
  code_change_analyst: delegatedAnalyst('git.diff', { title: 'paginate drops the last item of every page (slice end off-by-one)', level: 'high', rationale: 'the candidate computes end = start + size - 1 and slices with an exclusive end' }),
  historical_bug_analyst: delegatedAnalyst('git.log', { title: 'pagination was just refactored: page-boundary regressions are likely', level: 'medium', rationale: 'the candidate commit "refactor pagination" rewrote the page window arithmetic' }),
};

// ================================================================================================ MultiAgent: convergence

/** Lead: two independent executors probe the same contract in parallel (they must converge on ONE finding). */
export const convergenceLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return toolCall('experiment.define', {
        hypothesis: 'POST /transfers rejects non-positive amounts with 400 (bank-api B1) and transfers conserve the total balance (B2)',
        environmentId: BANK_ENV_ID, isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1 }],
      });
    }
    if (v.step === 1) {
      const experimentId = str(jsonOf(resultText(v, 0)), 'experimentId');
      const refs = experimentId ? { inputRefs: [{ kind: 'experiment', id: experimentId }] } : {};
      const probe = (localId: string) => ({
        localId, title: `Probe the transfer contract (${localId})`, role: 'executor', dependsOn: [], objectiveIds: ['obj-transfers'], ...refs,
        objective: `Against environment ${BANK_ENV_ID}: open two accounts, POST /transfers with amount 0 and with a negative amount (oracle bank-api B1 expects 400 for both), read the accounts back and GET /health (B2: balanceConserved). Post an evidence-backed finding for every violation.`,
        evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1, critical: true }],
      });
      return leadReply('two independent probes of the same contract: their findings must converge', 'plan.propose_revision', {
        rationale: 'Plan v1: two executors probe the transfer contract independently and in parallel; the blackboard must converge their reports of the same symptom into one finding.',
        objectives: [{ objectiveId: 'obj-transfers', description: 'Decide from HTTP evidence whether the bank API transfer contract (oracle bank-api B1, B2) holds on the candidate.', priority: 'P1', acceptanceCriteria: ['non-positive transfer amounts were exercised against POST /transfers with api-response evidence'] }],
        workItems: [probe('probe-a'), probe('probe-b')],
      });
    }
    return planned('Plan v1 proposed: two parallel probes.', 'obj-transfers');
  }
  return pocBLead(v);
};

export const CONVERGENCE_ROLES: Record<string, RoleBrain> = { ...POC_B_ROLES, lead: convergenceLead, executor: pocBExecutor };
