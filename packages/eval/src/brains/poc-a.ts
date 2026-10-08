/**
 * PoC A brains — multi-LLM white-box autonomous regression on the ledger repository.
 *
 *   lead Plan v1: three PARALLEL analysts (code change, architecture, history)
 *   → plan drained → lead Plan v2 from the posted risks: two PARALLEL test designers (A: pagination contract A1,
 *     B: transfer conservation A2) + an executor that depends on both (their artifacts are materialized into its
 *     worktree)
 *   → the executor runs the whole suite (the new pagination test fails on the candidate) and posts a P1 finding
 *     citing the test-result evidence
 *   → reactors (no lead): RCA reproduces with shell.exec, posts a supported hypothesis and confirms the finding with the
 *     root cause (slice end off-by-one); a regression test designer reaction; finding.confirmed wakes the independent
 *     reviewer, who judges the recorded test-result (never the executor's narrative)
 *   → plan drained → lead Plan v3 readyForGate ⇒ the QualityGate says fail (unresolved P1, oracle A1 violated).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '@hypertest/core';
import { FIXTURES_DIR } from '../fixtures.ts';
import {
  evIds, inputRecord, jsonOf, leadReply, recIds, replanOrdinal, resultText, str, targetCommits, toolCall, type BrainView, type RoleBrain,
} from './kit.ts';

export const LEDGER_ORACLE_ID = 'ledger-contract';

const OBJECTIVE = {
  objectiveId: 'obj-release',
  description: 'Decide from execution evidence whether the ledger candidate (commit "refactor pagination") satisfies the ledger-contract oracle and is releasable.',
  priority: 'P1',
  acceptanceCriteria: [
    'ledger-contract A1 (pagination) and A2 (transfer conservation) were exercised on the candidate with recorded test-result evidence',
    'every failure is an evidence-backed finding with a root-cause analysis',
  ],
};

export const PAGINATION_TEST_PATH = 'tests/paginate-pages.test.js';
export const TRANSFER_TEST_PATH = 'tests/transfer-conservation.test.js';

/** The designed contract tests (plain JS files under `fixtures/ledger/designed/`; the designers write them verbatim). */
export const PAGINATION_TEST: string = readFileSync(join(FIXTURES_DIR, 'ledger', 'designed', 'paginate-pages.test.js'), 'utf8');
export const TRANSFER_TEST: string = readFileSync(join(FIXTURES_DIR, 'ledger', 'designed', 'transfer-conservation.test.js'), 'utf8');

/** The library module of the ledger repository (as a specifier relative to the repository root). */
const LEDGER_MODULE = ['.', 'src', 'ledger.js'].join('/');

/** Script that reproduces the pagination defect directly (RCA's discriminating check). */
export const PAGINATION_REPRO = `const { paginate } = await import(${JSON.stringify(LEDGER_MODULE)}); const items = [1, 2, 3, 4, 5, 6, 7]; console.log(JSON.stringify({ page1: paginate(items, 1, 3), page2: paginate(items, 2, 3), page3: paginate(items, 3, 3) }));`;

function leadComplete(summary: string, ready: boolean, status: 'open' | 'satisfied', evidenceRefs: string[]) {
  return toolCall('complete_work', {
    summary,
    evidenceRefs,
    output: { summary, planProposed: true, readyForGate: ready, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status, evidenceRefs }] },
  });
}

/** The lead: Plan v1 (analysis) → v2 (design + execution, from the risks) → v3 readyForGate (from the evidence). */
export const pocALead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    const { head, base } = targetCommits(v);
    if (v.step === 0) {
      return leadReply('the change touches pagination; analyse it from three angles in parallel before designing tests', 'plan.propose_revision', {
        rationale: 'Plan v1: independent analyses of the change (diff, architecture, history) run in parallel before any test design.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'change', title: 'Analyse the candidate diff', role: 'code_change_analyst', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Analyse the change between base commit ${base ?? 'HEAD~1'} and the candidate ${head ?? 'HEAD'} (git.diff base..candidate) and post the behavioural risks of every changed function.`,
          },
          {
            localId: 'architecture', title: 'Map the ledger library', role: 'architecture_analyst', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: 'Record the system model of the ledger library (components with their paths, public functions) and place the candidate change on it.',
          },
          {
            localId: 'history', title: 'Mine the history of src/ledger.js', role: 'historical_bug_analyst', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: 'Review the version history of src/ledger.js for defect-prone areas touched by the candidate and post the risks it predicts.',
          },
        ],
      });
    }
    return leadComplete('Plan v1 proposed: three parallel analyses.', false, 'open', []);
  }
  const ordinal = replanOrdinal(v);
  if (ordinal === 1) {
    if (v.step === 0) return toolCall('blackboard.read', { recordType: 'risk' });
    if (v.step === 1) {
      const risks = recIds(resultText(v, 0));
      return leadReply('risks point at paginate; the transfer invariant is unchanged but P0 in the oracle: design one test per assertion', 'plan.propose_revision', {
        rationale: `Plan v2: the analysts posted risks ${risks.join(', ') || '(none)'} on the pagination refactor. Design one oracle-bound test per ledger-contract assertion in parallel, then execute the whole suite on the candidate.`,
        objectives: [{ ...OBJECTIVE, riskRefs: risks }],
        workItems: [
          {
            localId: 'design-pagination', title: 'Design the pagination contract test', role: 'test_designer', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            inputRefs: risks.map((id) => ({ kind: 'record', id })),
            objective: 'Design an oracle-bound node:test for ledger-contract A1 (paginate returns every item exactly once across pages): page through a list whose length is not a multiple of the page size. Register it and prove its sensitivity.',
          },
          {
            localId: 'design-transfer', title: 'Design the transfer conservation test', role: 'test_designer', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: 'Design an oracle-bound node:test for ledger-contract A2 (applyTransfer conserves the total balance) over a chain of transfers. Register it and prove its sensitivity (a known-good run and a killed mutant).',
          },
          {
            localId: 'execute', title: 'Execute the suite on the candidate', role: 'executor', dependsOn: ['design-pagination', 'design-transfer'], objectiveIds: [OBJECTIVE.objectiveId],
            objective: 'Run the complete node:test suite of the candidate (the designed tests are materialized in your worktree) and post an evidence-backed finding for every failure.',
            evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
          },
        ],
      });
    }
    return leadComplete('Plan v2 proposed: two parallel test designers and the executor.', false, 'open', []);
  }
  // Replan #2 (or a gate-feedback replan): the evidence answers the objective; hand over to the gate.
  if (v.step === 0) return toolCall('evidence.query', { evidenceType: 'test-result' });
  const ev = evIds(resultText(v, 0)).slice(0, 3);
  if (v.step === 1) {
    return leadReply('the suite ran with evidence and the defect was analysed and reviewed: the gate decides', 'plan.propose_revision', {
      rationale: `Plan v3: the candidate was executed with test-result evidence (${ev.join(', ')}); the failure is an evidence-backed finding with a confirmed root cause and an independent review. Hand over to the QualityGate.`,
      objectives: [{ ...OBJECTIVE, status: 'satisfied' }],
      workItems: [],
      readyForGate: true,
    });
  }
  return leadComplete('Plan v3: ready for the gate.', true, 'satisfied', ev);
};

// ------------------------------------------------------------------------------------------------ analysts

const PAGINATION_RISK = {
  title: 'paginate drops the last item of every page (slice end off-by-one)',
  description:
    'The candidate commit "refactor pagination" changed src/ledger.js paginate: it now computes end = start + size - 1 and returns items.slice(start, end). Array.prototype.slice excludes its end index, so every page returns size - 1 items and the last item of each page is never returned (off-by-one). The existing suite only checks page 1 of a list shorter than the page size, which hides it.',
  likelihood: 'high',
  impact: 'high',
  componentRefs: ['src/ledger.js#paginate'],
  source: 'change_analysis',
};

/** Code change analyst: git.diff base..candidate → a precise risk on paginate → complete. */
export const pocACodeChangeAnalyst: RoleBrain = (v) => {
  if (v.step === 0) {
    const base = /base commit ([0-9a-f]{7,64})/.exec(v.userText)?.[1] ?? 'HEAD~1';
    const head = /candidate ([0-9a-f]{7,64})/.exec(v.userText)?.[1] ?? 'HEAD';
    return toolCall('git.diff', { base, head, paths: ['src/ledger.js'] });
  }
  if (v.step === 1) {
    const diff = resultText(v, 0);
    const ev = evIds(diff);
    if (!/start \+ size - 1/.test(diff)) return toolCall('fail_work', { reason: 'agent_failed', message: 'the diff does not show the pagination change the objective names' });
    return toolCall('blackboard.post_risk', { ...PAGINATION_RISK, evidenceRefs: ev });
  }
  const r = jsonOf(resultText(v, 1));
  const summary = 'The pagination refactor introduces an exclusive-end off-by-one in paginate; transfers and interest are unchanged.';
  return toolCall('complete_work', {
    summary,
    recordRefs: [str(r, 'recordId')!],
    output: {
      summary,
      risks: [{ title: PAGINATION_RISK.title, level: str(r, 'level') ?? 'high', rationale: PAGINATION_RISK.description, components: ['src/ledger.js'], recordId: str(r, 'recordId')! }],
      testIdeas: ['page through [1..7] with page size 3: pages must be [1,2,3], [4,5,6], [7] (ledger-contract A1)'],
    },
  });
};

/** Architecture analyst: fs.list → system_model.record → complete (no architectural risk). */
export const pocAArchitectureAnalyst: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('fs.list', { path: '.', depth: 2 });
  if (v.step === 1) {
    return toolCall('system_model.record', {
      components: [
        { componentId: 'ledger', name: 'ledger library', kind: 'library', paths: ['src/ledger.js'], description: 'paginate, applyTransfer, computeInterest', riskTags: ['money', 'pagination'] },
        { componentId: 'ledger-tests', name: 'ledger test suite', kind: 'module', paths: ['tests/ledger.test.js'] },
      ],
      interfaces: [
        { kind: 'library_api', name: 'paginate(items, page, size)', componentId: 'ledger' },
        { kind: 'library_api', name: 'applyTransfer(accounts, from, to, amount)', componentId: 'ledger' },
      ],
      changedComponents: ['ledger'],
      riskTags: ['pagination'],
    });
  }
  const summary = 'One library component (src/ledger.js) with three pure functions; the candidate changes paginate only. No cross-component risk.';
  return toolCall('complete_work', { summary, output: { summary, risks: [], testIdeas: ['paginate is a pure function: test it directly with multi-page inputs'] } });
};

const HISTORY_RISK = {
  title: 'pagination was just refactored: boundary regressions are likely',
  description: 'git log of src/ledger.js shows the candidate commit "refactor pagination" rewriting the page window arithmetic; page-boundary (off-by-one) defects are the classic regression of such refactors, and no multi-page test exists.',
  likelihood: 'medium',
  impact: 'high',
  componentRefs: ['src/ledger.js#paginate'],
  source: 'history',
};

/** Historical bug analyst: git.log → a history risk → complete. */
export const pocAHistoricalAnalyst: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('git.log', { path: 'src/ledger.js', maxCount: 10 });
  if (v.step === 1) {
    if (!/refactor pagination/.test(resultText(v, 0))) return toolCall('fail_work', { reason: 'agent_failed', message: 'the history does not show the pagination refactor' });
    return toolCall('blackboard.post_risk', HISTORY_RISK);
  }
  const r = jsonOf(resultText(v, 1));
  const summary = 'The candidate refactors pagination arithmetic; history predicts page-boundary regressions.';
  return analystCompleteWith(summary, r, HISTORY_RISK.title);
};

function analystCompleteWith(summary: string, r: Record<string, unknown>, title: string) {
  const recordId = str(r, 'recordId')!;
  return toolCall('complete_work', {
    summary,
    recordRefs: [recordId],
    output: { summary, risks: [{ title, level: str(r, 'level') ?? 'medium', rationale: summary, components: ['src/ledger.js'], recordId }], testIdeas: ['re-test page boundaries after the refactor'] },
  });
}

// ------------------------------------------------------------------------------------------------ test designers

/** Planned designer A (pagination, A1): write → commit → register → run (fails on the candidate: known-bad) → validate → complete. */
function paginationDesigner(v: BrainView) {
  switch (v.step) {
    case 0:
      return toolCall('fs.write', { path: PAGINATION_TEST_PATH, content: PAGINATION_TEST });
    case 1:
      return toolCall('git.commit', { message: 'test: ledger-contract A1 — paginate returns every item exactly once across pages', paths: [PAGINATION_TEST_PATH] });
    case 2:
      return toolCall('test_artifact.register', {
        path: PAGINATION_TEST_PATH, sourceType: 'generated', runner: { framework: 'node_test', selector: PAGINATION_TEST_PATH },
        oracleRefs: [{ oracleId: LEDGER_ORACLE_ID, revision: 1, assertionIds: ['A1'] }],
      });
    case 3: {
      const artifactId = str(jsonOf(resultText(v, 2)), 'artifactId')!;
      return toolCall('test.run', { framework: 'node_test', selector: PAGINATION_TEST_PATH, testArtifactIds: [artifactId] });
    }
    case 4:
      // D-1: the known-good run of a regression test is its run on the BASE revision (product code restored)
      return toolCall('test.run', { framework: 'node_test', selector: PAGINATION_TEST_PATH, revision: 'base' });
    case 5: {
      const artifactId = str(jsonOf(resultText(v, 2)), 'artifactId')!;
      const run = resultText(v, 3);
      const ev = evIds(run).at(-1)!;
      const good = evIds(resultText(v, 4)).at(-1)!;
      // the test fails on the defective candidate (known-bad) and passes on the base revision (known-good)
      return toolCall('test_artifact.validate', /NOT PASSED/.test(run) ? { artifactId, knownBadEvidenceId: ev, knownGoodEvidenceId: good } : { artifactId, knownGoodEvidenceId: ev });
    }
    default: {
      const artifactId = str(jsonOf(resultText(v, 2)), 'artifactId')!;
      const ev = evIds(resultText(v, 3)).at(-1)!;
      const good = evIds(resultText(v, 4)).at(-1)!;
      const state = str(jsonOf(resultText(v, 5)), 'approvalState') ?? 'draft';
      const summary = `Registered ${PAGINATION_TEST_PATH} (artifact ${artifactId}) for ledger-contract A1; it FAILS on the candidate (known-bad evidence ${ev}) and passes on the base revision (known-good evidence ${good}): ${state}, oracle consistency review requested.`;
      return toolCall('complete_work', { summary, evidenceRefs: [ev, good], output: { summary, testArtifacts: [{ artifactId, path: PAGINATION_TEST_PATH, covers: [OBJECTIVE.objectiveId], evidenceRefs: [ev, good] }] } });
    }
  }
}

/** Planned designer B (transfer, A2): write → commit → register → run → run on the base revision (known-good) → mutation run → validate → complete. */
function transferDesigner(v: BrainView) {
  switch (v.step) {
    case 0:
      return toolCall('fs.write', { path: TRANSFER_TEST_PATH, content: TRANSFER_TEST });
    case 1:
      return toolCall('git.commit', { message: 'test: ledger-contract A2 — transfer conserves the total balance', paths: [TRANSFER_TEST_PATH] });
    case 2:
      return toolCall('test_artifact.register', {
        path: TRANSFER_TEST_PATH, sourceType: 'generated', runner: { framework: 'node_test', selector: TRANSFER_TEST_PATH },
        oracleRefs: [{ oracleId: LEDGER_ORACLE_ID, revision: 1, assertionIds: ['A2'] }],
      });
    case 3: {
      const artifactId = str(jsonOf(resultText(v, 2)), 'artifactId')!;
      return toolCall('test.run', { framework: 'node_test', selector: TRANSFER_TEST_PATH, testArtifactIds: [artifactId] });
    }
    case 4:
      // D-1 (review): the known-good run is the run on the BASE revision (only it lets the artifact decide A2, a P1 assertion)
      return toolCall('test.run', { framework: 'node_test', selector: TRANSFER_TEST_PATH, revision: 'base' });
    case 5:
      return toolCall('mutation.run', { file: 'src/ledger.js', testSelector: TRANSFER_TEST_PATH, maxMutants: 12, operators: ['arithmetic'], framework: 'node_test' });
    case 6: {
      const artifactId = str(jsonOf(resultText(v, 2)), 'artifactId')!;
      return toolCall('test_artifact.validate', { artifactId, knownGoodEvidenceId: evIds(resultText(v, 4)).at(-1)!, mutationEvidenceId: evIds(resultText(v, 5)).at(-1)! });
    }
    default: {
      const artifactId = str(jsonOf(resultText(v, 2)), 'artifactId')!;
      const run = evIds(resultText(v, 3)).at(-1)!;
      const mutation = evIds(resultText(v, 5)).at(-1)!;
      const validated = str(jsonOf(resultText(v, 6)), 'approvalState') === 'validated';
      const summary = `Registered ${TRANSFER_TEST_PATH} (artifact ${artifactId}) for ledger-contract A2: passes on the candidate (${run}) and kills mutants (${mutation}); ${validated ? 'validated' : 'still a draft'}.`;
      const artifact: Record<string, JsonValue> = { artifactId, path: TRANSFER_TEST_PATH, covers: [OBJECTIVE.objectiveId], evidenceRefs: [run, mutation] };
      if (validated) artifact['validated'] = true;
      return toolCall('complete_work', { summary, evidenceRefs: [run, mutation], output: { summary, testArtifacts: [artifact] } });
    }
  }
}

/** Test designers: the two planned designs, or the finding reaction (the planned pagination test already reproduces it). */
export const pocATestDesigner: RoleBrain = (v) => {
  if (v.kind === 'reaction') {
    const summary = `The finding is already reproduced by the planned regression test ${PAGINATION_TEST_PATH} (ledger-contract A1); no additional artifact is needed.`;
    return toolCall('complete_work', { summary, output: { summary, testArtifacts: [] } });
  }
  if (/ledger-contract A1/.test(v.userText)) return paginationDesigner(v);
  if (/ledger-contract A2/.test(v.userText)) return transferDesigner(v);
  return toolCall('fail_work', { reason: 'agent_failed', message: 'the objective names no ledger-contract assertion to design for' });
};

// ------------------------------------------------------------------------------------------------ executor, RCA, reviewer

export const PAGINATION_FINDING = {
  title: 'paginate drops the last item of every page',
  description: 'The contract test "paginate returns every item exactly once across pages" fails on the candidate: paging [1..7] with page size 3 does not return [[1,2,3],[4,5,6],[7]] — items are missing from every page.',
  severity: 'P1',
  category: 'product_defect',
  component: 'src/ledger.js paginate',
  expected: '[[1,2,3],[4,5,6],[7]]',
  actual: 'every page is one item short (see the test-result evidence)',
  reproduction: `node --test ${PAGINATION_TEST_PATH}`,
  oracleRef: { oracleId: LEDGER_ORACLE_ID, revision: 1, assertionId: 'A1' },
};

/** Executor: runs the whole suite (designed tests materialized) → posts the evidence-backed finding → complete. */
export const pocAExecutor: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('test.run', { framework: 'node_test' });
  const run = resultText(v, 0);
  const ev = evIds(run).at(-1)!;
  const failed = /NOT PASSED/.test(run);
  if (failed && v.step === 1) {
    // the failing case belongs to the designed contract test: name its artifact (from the dependency results)
    const artifactId = /paginate-pages\.test\.js \(artifact (ta_\w+)\)/.exec(v.userText)?.[1];
    return toolCall('blackboard.post_finding', { ...PAGINATION_FINDING, ...(artifactId ? { testArtifactId: artifactId } : {}), evidenceRefs: [ev] });
  }
  const findings = failed ? recIds(resultText(v, 1)).slice(0, 1) : [];
  const summary = failed ? `The candidate suite fails: ${/- FAILED ([^\n:]+)/.exec(run)?.[1] ?? 'a test'} (evidence ${ev}).` : `The candidate suite passes (evidence ${ev}).`;
  return toolCall('complete_work', {
    summary, evidenceRefs: [ev], recordRefs: findings,
    output: { summary, executed: [{ selector: 'node --test (whole suite)', passed: !failed, outcome: failed ? 'failed' : 'passed', evidenceIds: [ev] }], findings },
  });
};

/** RCA: diff → reproduce (shell.exec) → supported hypothesis → confirm the finding with the root cause → complete. */
export const pocARca: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  switch (v.step) {
    case 0:
      return toolCall('git.diff', { base: 'HEAD~1', head: 'HEAD', paths: ['src/ledger.js'] });
    case 1:
      return toolCall('shell.exec', { command: ['node', '--input-type=module', '-e', PAGINATION_REPRO] });
    case 2: {
      const diffEv = evIds(resultText(v, 0));
      const reproEv = evIds(resultText(v, 1));
      return toolCall('blackboard.post_hypothesis', {
        findingRecordId: finding.recordId,
        statement: 'The refactor of src/ledger.js paginate computes end = start + size - 1 and calls items.slice(start, end); slice already excludes its end index, so every page loses its last item (off-by-one in the slice end).',
        status: 'supported',
        confidence: 0.95,
        suggestedChecks: ['paginate([1..7], p, 3) for p = 1..3 returns 2, 2 and 1 items instead of 3, 3 and 1'],
        evidenceRefs: [...diffEv, ...reproEv],
      });
    }
    case 3: {
      const out = resultText(v, 1);
      const reproEv = evIds(out);
      if (!/"page1":\[1,2\]/.test(out)) return toolCall('fail_work', { reason: 'agent_failed', message: `the reproduction did not show the defect: ${out.slice(0, 300)}` });
      const p = finding.payload;
      return toolCall('blackboard.post_finding', {
        updatesRecordId: finding.recordId,
        title: String(p['title']),
        description: `${String(p['description'])} Root cause (reproduced: page 1 of [1..7] with size 3 is [1,2]): the refactored paginate calls items.slice(start, start + size - 1), an off-by-one on slice's exclusive end, so every page drops its last item.`,
        severity: String(p['severity']),
        category: String(p['category']),
        component: String(p['component'] ?? 'src/ledger.js paginate'),
        expected: String(p['expected'] ?? ''),
        actual: 'page 1 → [1,2], page 2 → [4,5], page 3 → [7]',
        reproduction: String(p['reproduction'] ?? ''),
        oracleRef: p['oracleRef'] as JsonValue,
        ...(typeof p['testArtifactId'] === 'string' ? { testArtifactId: p['testArtifactId'] } : {}),
        status: 'confirmed',
        evidenceRefs: [...finding.evidenceRefs, ...reproEv],
      });
    }
    default: {
      const hypothesis = str(jsonOf(resultText(v, 2)), 'recordId')!;
      const reproEv = evIds(resultText(v, 1));
      const summary = 'Root cause confirmed by reproduction: paginate slices with an exclusive end of start + size - 1 (off-by-one), dropping the last item of every page.';
      return toolCall('complete_work', {
        summary, evidenceRefs: reproEv, recordRefs: [hypothesis, finding.recordId],
        output: { summary, hypotheses: [hypothesis], rootCause: { status: 'confirmed', statement: summary, evidenceRefs: reproEv }, reproduction: 'always', findingRecordId: finding.recordId },
      });
    }
  }
};

/**
 * Independent reviewer of a finding: reads the subject record, fetches EVERY cited evidence itself (evidence.get) and
 * approves only when a recorded evidence of the expected type shows the claimed behaviour — never on the reporter's
 * narrative (`supports` judges the recorded structured payload).
 */
export function reviewerOfFinding(expectation: { evidenceType: string; supports: (structured: unknown) => boolean; what: string }): RoleBrain {
  return (v) => {
    const subject = inputRecord(v, 'finding');
    if (!subject) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the review inputs' });
    if (v.step === 0) return toolCall('blackboard.read', { recordId: subject.recordId });
    const head = jsonOf(resultText(v, 0));
    const records = Array.isArray(head['records']) ? (head['records'] as Array<{ evidenceRefs?: string[] }>) : [];
    const refs = records[0]?.evidenceRefs ?? subject.evidenceRefs;
    const fetched = v.step - 1;
    if (fetched < refs.length) return toolCall('evidence.get', { evidenceId: refs[fetched]! });
    const inspected = refs.slice(0, fetched);
    const supporting = inspected.filter((_id, i) => {
      const e = jsonOf(resultText(v, 1 + i));
      return e['evidenceType'] === expectation.evidenceType && expectation.supports(e['structured']);
    });
    const verdict = supporting.length > 0 ? 'approve' : 'needs_more_evidence';
    if (v.step === 1 + refs.length) {
      return toolCall('blackboard.post_review', {
        subjectRef: { kind: 'record', id: subject.recordId },
        verdict,
        rationale: supporting.length > 0
          ? `The recorded ${expectation.evidenceType} ${supporting.join(', ')} shows ${expectation.what}; the finding is supported by execution evidence, not by narrative.`
          : `None of ${inspected.join(', ')} shows ${expectation.what}.`,
        checkedEvidenceRefs: inspected,
      });
    }
    const review = str(jsonOf(resultText(v, 1 + refs.length)), 'recordId')!;
    const summary = `Independent review of ${subject.recordId}: ${verdict} (checked ${inspected.join(', ')}).`;
    return toolCall('complete_work', { summary, evidenceRefs: inspected, recordRefs: [review], output: { summary, verdict, reviews: [review], checkedEvidenceIds: inspected } });
  };
}

/**
 * Independent reviewer of the RUN (the run-level review the QualityGate requires, requested by the control plane before
 * the gate — H7): queries the run's recorded evidence of the expected type, fetches it itself (evidence.get) and approves
 * only when a recorded payload shows what the run's verdict rests on; otherwise it asks for more evidence.
 */
export function reviewerOfRun(expectation: { evidenceType: string; supports: (structured: unknown) => boolean; what: string }): RoleBrain {
  return (v) => {
    if (v.step === 0) return toolCall('evidence.query', { evidenceType: expectation.evidenceType });
    const listing = jsonOf(resultText(v, 0));
    const ids = (Array.isArray(listing['evidence']) ? (listing['evidence'] as Array<{ evidenceId: string }>) : []).map((e) => e.evidenceId).slice(0, 5);
    const fetched = v.step - 1;
    if (fetched < ids.length) return toolCall('evidence.get', { evidenceId: ids[fetched]! });
    const inspected = ids.slice(0, fetched);
    const supporting = inspected.filter((_id, i) => expectation.supports(jsonOf(resultText(v, 1 + i))['structured']));
    const verdict = supporting.length > 0 ? 'approve' : 'needs_more_evidence';
    if (v.step === 1 + ids.length) {
      return toolCall('blackboard.post_review', {
        subjectRef: { kind: 'run', id: v.runId },
        verdict,
        rationale: supporting.length > 0
          ? `The recorded ${expectation.evidenceType} ${supporting.join(', ')} shows ${expectation.what}: the run's findings and verdict rest on execution evidence.`
          : `No inspected ${expectation.evidenceType} (${inspected.join(', ') || 'none'}) shows ${expectation.what}.`,
        checkedEvidenceRefs: inspected,
      });
    }
    const review = str(jsonOf(resultText(v, 1 + ids.length)), 'recordId')!;
    const summary = `Independent review of run ${v.runId}: ${verdict} (checked ${inspected.join(', ') || 'no evidence'}).`;
    return toolCall('complete_work', { summary, evidenceRefs: inspected, recordRefs: [review], output: { summary, verdict, reviews: [review], checkedEvidenceIds: inspected } });
  };
}

/** A run-level review request (H7): its task names the run as the review subject. */
export function isRunReview(v: BrainView): boolean {
  return v.role === 'reviewer' && /subjectRef \{"kind":"run","id":"/.test(v.userText) && inputRecord(v, 'finding') === undefined;
}

/** (D-1) An oracle consistency review request of a validated test artifact. */
export function isArtifactReview(v: BrainView): boolean {
  return v.role === 'reviewer' && /subjectRef \{"kind":"test_artifact","id":"ta_/.test(v.userText);
}

/**
 * (D-1) The oracle consistency review of a validated test artifact: fetches the validation evidence the request cites
 * (evidence.get) and approves only when a fetched run executed exactly the artifact's file (its execution binding);
 * otherwise it asks for more evidence. Never the designer's narrative.
 */
export const artifactReviewer: RoleBrain = (v) => {
  const m = /oracle consistency of test artifact (ta_\w+) \(([^,)]+)/.exec(v.userText);
  if (!m) return toolCall('fail_work', { reason: 'agent_failed', message: 'the review request names no test artifact' });
  const [, artifactId, path] = m as unknown as [string, string, string];
  const cited = (/citing the validation evidence you inspected \(([^)]*)\)/.exec(v.userText)?.[1] ?? '').split(',').map((x) => x.trim()).filter((x) => x.startsWith('ev_')).slice(0, 3);
  const fetched = v.step;
  if (fetched < cited.length) return toolCall('evidence.get', { evidenceId: cited[fetched]! });
  const inspected = cited.slice(0, fetched);
  const binding = inspected.filter((_id, i) => {
    const files = (jsonOf(resultText(v, i))['structured'] as { executedTests?: { files?: Array<{ path?: string }> } } | undefined)?.executedTests?.files ?? [];
    return files.some((f) => f.path === path);
  });
  const verdict = binding.length > 0 ? 'approve' : 'needs_more_evidence';
  if (v.step === cited.length) {
    return toolCall('blackboard.post_review', {
      subjectRef: { kind: 'test_artifact', id: artifactId },
      verdict,
      rationale: binding.length > 0 ? `The validation runs ${binding.join(', ')} executed ${path} itself; its assertions encode the oracle assertions it names.` : `None of ${inspected.join(', ') || 'the cited evidence'} executed ${path}.`,
      checkedEvidenceRefs: inspected,
    });
  }
  const review = str(jsonOf(resultText(v, cited.length)), 'recordId')!;
  const summary = `Oracle consistency review of ${artifactId} (${path}): ${verdict}.`;
  return toolCall('complete_work', { summary, evidenceRefs: inspected, recordRefs: [review], output: { summary, verdict, reviews: [review], checkedEvidenceIds: inspected } });
};

/** The reviewer of a PoC: artifact reviews to `artifactReviewer`, run-level review requests to `run`, finding reviews to `finding`. */
export function pocReviewer(finding: RoleBrain, run: RoleBrain): RoleBrain {
  return (v) => (isArtifactReview(v) ? artifactReviewer(v) : isRunReview(v) ? run(v) : finding(v));
}

/** A test-result whose recorded cases show `name` with status failed. */
export function caseFailed(name: string): (structured: unknown) => boolean {
  return (s) => {
    const cases = s && typeof s === 'object' && Array.isArray((s as { cases?: unknown }).cases) ? (s as { cases: Array<{ name?: unknown; status?: unknown }> }).cases : [];
    return cases.some((c) => c.name === name && c.status === 'failed');
  };
}

export const pocAReviewer: RoleBrain = pocReviewer(
  reviewerOfFinding({
    evidenceType: 'test-result',
    supports: caseFailed('paginate returns every item exactly once across pages'),
    what: 'the pagination contract case failing on the candidate',
  }),
  reviewerOfRun({
    evidenceType: 'test-result',
    supports: caseFailed('paginate returns every item exactly once across pages'),
    what: 'the pagination contract case failing on the candidate',
  }),
);

export const POC_A_ROLES: Record<string, RoleBrain> = {
  lead: pocALead,
  code_change_analyst: pocACodeChangeAnalyst,
  architecture_analyst: pocAArchitectureAnalyst,
  historical_bug_analyst: pocAHistoricalAnalyst,
  test_designer: pocATestDesigner,
  executor: pocAExecutor,
  rca: pocARca,
  reviewer: pocAReviewer,
};
