/**
 * `--scripted-brains` module for the CLI tests: deterministic brains for the scripted provider `sim`, selected by the
 * `HT_CLI_SCENARIO` variable of the CLI's environment (the factory export receives it):
 *
 *   (every scenario: the lead first records the SystemModel — gate C12)
 *   pass          lead Plan v1 = one executor item → the executor runs the repository's real node:test suite →
 *                 lead Plan v2 readyForGate citing the test-result evidence (verdict pass, or conditional when the
 *                 gate requires an independent review nobody gave)
 *   fail          as pass, but the suite fails and the executor posts a P1 product-defect finding with the failing
 *                 test-result evidence; RCA and the test designer answer minimally (verdict fail)
 *   inconclusive  the lead declares readiness without any work: the required test-result evidence is missing
 *
 * The header parser mirrors `[hypertest role=… work_item=… kind=… run=…]` (the control plane's agent header).
 * `calls` records every request (shared with the test through the module cache); `hooks.onReplan` (set by a test) is
 * called when the lead is invoked for anything but its initial plan — in the inconclusive scenario that is the replan
 * the gate's feedback loop asks for after an interim (non-final) decision.
 */

interface Message {
  role: string;
  content: unknown;
  toolName?: string;
  isError?: boolean;
}
interface Request {
  messages: Message[];
}
type Reply = { toolCalls: Array<{ name: string; arguments: unknown }> } | { text: string };

export interface View {
  role: string;
  kind: string;
  workItemId: string;
  runId: string;
  step: number;
  userText: string;
  toolResults: Array<{ name: string; content: string; isError: boolean }>;
}

export const calls: View[] = [];

/** Test hooks (module state shared with the test through the module cache). */
export const hooks: { onReplan?: ((v: View) => void) | undefined } = {};

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: { type?: string; text?: string }) => (p?.type === 'text' ? (p.text ?? '') : '')).join('');
  return '';
}

export function viewOf(request: Request): View {
  const system = request.messages[0]?.role === 'system' ? text(request.messages[0].content) : '';
  const m = /^\[hypertest role=(\S+) work_item=(\S+) kind=(\S+) run=(\S+)\]/.exec(system);
  if (!m) throw new Error(`request without a hypertest header: ${system.slice(0, 120)}`);
  return {
    role: m[1]!,
    workItemId: m[2]!,
    kind: m[3]!,
    runId: m[4]!,
    step: request.messages.filter((x) => x.role === 'assistant').length,
    userText: request.messages.filter((x) => x.role === 'user').map((x) => text(x.content)).join('\n'),
    toolResults: request.messages.filter((x) => x.role === 'tool').map((x) => ({ name: x.toolName ?? '', content: text(x.content), isError: x.isError === true })),
  };
}

function call(name: string, args: unknown): Reply {
  return { toolCalls: [{ name: name.replaceAll('.', '__'), arguments: args }] };
}

function evidenceIds(s: string): string[] {
  return [...new Set([...s.matchAll(/\bev_[0-9A-Za-z]+\b/g)].map((x) => x[0]))];
}

function recordId(s: string): string | undefined {
  return /\brec_[0-9A-Za-z]+\b/.exec(s)?.[0];
}

const OBJECTIVE = {
  objectiveId: 'obj-sum',
  description: 'Decide whether the sum module is releasable: its test suite passes on the candidate commit.',
  priority: 'P1',
  acceptanceCriteria: ['the suite ran on the candidate with recorded test-result evidence'],
};

type RoleBrain = (v: View) => Reply;

function lead(scenario: string): RoleBrain {
  return (v) => {
    if (v.kind === 'initial_plan') {
      // coverage-1 (gate C12): the run records the system it tests before it is judged
      if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'sum', name: 'sum module', kind: 'module', paths: ['src/sum.js'] }], sources: [{ kind: 'file', id: 'src/sum.js' }] });
      if (scenario === 'inconclusive') {
        if (v.step === 1) return call('plan.propose_revision', { rationale: 'Nothing to execute: hand over to the gate.', objectives: [OBJECTIVE], workItems: [], readyForGate: true });
        return call('complete_work', { summary: 'ready for gate', output: { summary: 'ready for gate', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-sum', status: 'open', evidenceRefs: [] }] } });
      }
      if (v.step === 1) {
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
    // replan (plan drained, gate feedback, new finding): look the execution evidence up and hand over to the gate
    if (v.step === 0) {
      hooks.onReplan?.(v);
      return call('evidence.query', { evidenceType: 'test-result' });
    }
    const ev = evidenceIds(v.toolResults[0]?.content ?? '');
    // (e2e[6]) a failed objective is 'unsatisfiable' (the plan schema: open | satisfied | unsatisfiable | dropped)
    const status = scenario === 'fail' ? 'unsatisfiable' : ev.length > 0 ? 'satisfied' : 'open';
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'The recorded execution evidence decides the objective; hand over to the gate.',
        objectives: [{ ...OBJECTIVE, status }],
        workItems: [],
        readyForGate: true,
      });
    }
    return call('complete_work', {
      summary: 'ready for the gate', evidenceRefs: ev.slice(0, 1),
      output: { summary: 'ready for gate', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-sum', status, evidenceRefs: ev.slice(0, 1) }] },
    });
  };
}

function executor(scenario: string): RoleBrain {
  return (v) => {
    if (v.step === 0) return call('test.run', { framework: 'node_test' });
    const ids = evidenceIds(v.toolResults[0]?.content ?? '');
    if (scenario === 'fail') {
      if (v.step === 1) {
        return call('blackboard.post_finding', {
          title: 'sum subtracts instead of adding', description: 'sum(2, 3) returns -1 instead of 5 on the candidate commit.', severity: 'P1', category: 'product_defect',
          component: 'sum', expected: '5', actual: '-1', reproduction: 'node --test test/sum.test.js', evidenceRefs: ids,
        });
      }
      const rec = recordId(v.toolResults[1]?.content ?? '');
      return call('complete_work', {
        summary: 'The sum suite fails on the candidate.', evidenceRefs: ids, ...(rec ? { recordRefs: [rec] } : {}),
        output: { summary: 'suite failed', executed: [{ selector: 'test/sum.test.js', passed: false, outcome: 'failed', evidenceIds: ids }], findings: rec ? [rec] : [] },
      });
    }
    return call('complete_work', {
      summary: 'The sum suite passes on the candidate.', evidenceRefs: ids,
      output: { summary: 'suite passed', executed: [{ selector: 'test/sum.test.js', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] },
    });
  };
}

const rca: RoleBrain = () =>
  call('complete_work', { summary: 'No root cause analysis in this scripted scenario.', output: { summary: 'not investigated', hypotheses: [], rootCause: { status: 'unknown', statement: 'not investigated (scripted CLI test)' }, reproduction: 'not_attempted' } });

const testDesigner: RoleBrain = () => call('complete_work', { summary: 'The existing test already covers the defect.', output: { summary: 'covered by the existing test', testArtifacts: [] } });

/** One brain for every agent of a scenario; unknown roles fail their work (never hang). */
export function scenarioBrain(scenario: string): (request: Request) => Reply {
  const roles: Record<string, RoleBrain> = { lead: lead(scenario), executor: executor(scenario), rca, test_designer: testDesigner };
  return (request) => {
    const v = viewOf(request);
    calls.push(v);
    const brain = roles[v.role];
    if (!brain) return call('fail_work', { reason: 'no_brain', message: `no scripted brain for role ${v.role}` });
    return brain(v);
  };
}

/** The `--scripted-brains` factory export: the scenario comes from the CLI's environment. */
export function brains(ctx: { env: Record<string, string | undefined> }): Record<string, (request: Request) => Reply> {
  return { sim: scenarioBrain(ctx.env['HT_CLI_SCENARIO'] ?? 'pass') };
}
