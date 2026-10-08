/**
 * `--scripted-brains` module for the black-box CLI tests (`hypertest run --url <sutUrl>`): deterministic brains for the
 * scripted provider `sim`. The executor probes the SUT by URL — exactly as a model given only the run's `--url` would —
 * selected by `HT_BB_SCENARIO`:
 *
 *   url-probe   lead Plan v1 = one executor item (critical api-response evidence) → the executor sends
 *               `GET <HT_BB_SUT>/price?unit=1&qty=10` by URL, posts a P1 product-defect finding when the total is not 9
 *               (citing the api-response evidence) → lead Plan v2 readyForGate citing that evidence.
 *   load-probe  as url-probe, but the executor also samples the SUT's metrics by URL (metrics.scrape {url}).
 *
 * `calls` records every request; `toolOutcomes` records every tool result the executor saw (shared with the test
 * through the module cache).
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
  step: number;
  userText: string;
  toolResults: Array<{ name: string; content: string; isError: boolean }>;
}

export const toolOutcomes: Array<{ role: string; name: string; content: string; isError: boolean }> = [];

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: { type?: string; text?: string }) => (p?.type === 'text' ? (p.text ?? '') : '')).join('');
  return '';
}

function viewOf(request: Request): View {
  const system = request.messages[0]?.role === 'system' ? text(request.messages[0].content) : '';
  const m = /^\[hypertest role=(\S+) work_item=(\S+) kind=(\S+) run=(\S+)\]/.exec(system);
  if (!m) throw new Error(`request without a hypertest header: ${system.slice(0, 120)}`);
  return {
    role: m[1]!,
    kind: m[3]!,
    step: request.messages.filter((x) => x.role === 'assistant').length,
    userText: request.messages.filter((x) => x.role === 'user').map((x) => text(x.content)).join('\n'),
    toolResults: request.messages.filter((x) => x.role === 'tool').map((x) => ({ name: x.toolName ?? '', content: text(x.content), isError: x.isError === true })),
  };
}

const call = (name: string, args: unknown): Reply => ({ toolCalls: [{ name: name.replaceAll('.', '__'), arguments: args }] });
const evidenceIds = (s: string): string[] => [...new Set([...s.matchAll(/\bev_[0-9A-Za-z]+\b/g)].map((x) => x[0]))];
const recordId = (s: string): string | undefined => /\brec_[0-9A-Za-z]+\b/.exec(s)?.[0];

const OBJECTIVE = { objectiveId: 'obj-price', description: 'Probe the price API discount boundary.', priority: 'P1', acceptanceCriteria: ['api-response evidence for qty 10'] };

function lead(v: View): Reply {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'price-api', name: 'price API', kind: 'service', paths: [] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'Probe the discount boundary of the running price API.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'probe', title: 'Probe /price at qty 10', objective: 'GET /price?unit=1&qty=10 on the system under test and compare with the oracle.',
            role: 'executor', dependsOn: [], objectiveIds: ['obj-price'], evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1, critical: true }],
          },
        ],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-price', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'api-response' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'The probe ran with recorded evidence; hand over to the gate.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', {
    summary: 'ready for the gate', evidenceRefs: ev.slice(0, 1),
    output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-price', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] },
  });
}

function executor(sut: string, scenario: string): (v: View) => Reply {
  return (v) => {
    const last = v.toolResults.at(-1);
    if (last) toolOutcomes.push({ role: v.role, ...last });
    if (v.step === 0) return call('http.request', { method: 'GET', url: `${sut}/price?unit=1&qty=10`, expectJson: true });
    const probe = v.toolResults[0]?.content ?? '';
    const ids = evidenceIds(probe);
    let next = 1;
    if (scenario === 'load-probe') {
      if (v.step === next) return call('metrics.scrape', { url: `${sut}/metrics` });
      next++;
    }
    const defect = !probe.includes('"total":9');
    if (defect && v.step === next) {
      return call('blackboard.post_finding', {
        title: 'no discount at qty 10', description: 'GET /price?unit=1&qty=10 does not return the discounted total 9', severity: 'P1', category: 'product_defect', component: 'price-api',
        expected: 'total 9', actual: 'total 10', reproduction: `curl '${sut}/price?unit=1&qty=10'`, evidenceRefs: ids,
      });
    }
    const rec = defect ? recordId(v.toolResults[next]?.content ?? '') : undefined;
    return call('complete_work', {
      summary: defect ? 'defect found at the discount boundary' : 'boundary as expected', evidenceRefs: ids, ...(rec ? { recordRefs: [rec] } : {}),
      output: { summary: defect ? 'defect' : 'ok', executed: [{ selector: 'GET /price?unit=1&qty=10', passed: !defect, outcome: defect ? 'failed' : 'passed', evidenceIds: ids }], findings: rec ? [rec] : [] },
    });
  };
}

const rca = (): Reply => call('complete_work', { summary: 'no RCA needed for the probe', output: { summary: 'n/a', hypotheses: [], rootCause: { status: 'unknown', statement: 'not analysed' }, reproduction: 'not_attempted' } });
const testDesigner = (): Reply => call('complete_work', { summary: 'no test design for the probe', output: { summary: 'n/a', testArtifacts: [] } });

/** The `--scripted-brains` factory export: the SUT URL and the scenario come from the CLI's environment. */
export function brains(ctx: { env: Record<string, string | undefined> }): Record<string, (request: Request) => Reply> {
  const sut = ctx.env['HT_BB_SUT'] ?? 'http://127.0.0.1:1';
  const scenario = ctx.env['HT_BB_SCENARIO'] ?? 'url-probe';
  const roles: Record<string, (v: View) => Reply> = { lead, executor: executor(sut, scenario), rca, test_designer: testDesigner };
  return {
    sim: (request) => {
      const v = viewOf(request);
      const brain = roles[v.role];
      return brain ? brain(v) : call('fail_work', { reason: 'no_brain', message: `no scripted brain for role ${v.role}` });
    },
  };
}
