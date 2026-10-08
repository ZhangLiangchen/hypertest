/**
 * (F[8]) The frontier/product baseline arms: an EXTERNAL agent (Claude Code, Codex, OpenHands, … — anything invoked as a
 * command) runs the task's goal against the same fixture, and the same outcome ground truth judges it. The agent is not
 * Hypertest: it has no Evidence Ledger, no QualityGate, no operation ledger. So only the OUTCOME is graded:
 *
 *   externalVerdict         the verdict the agent reports (`{report}` JSON: {verdict, findings}) matches the task's
 *   externalDefectDetected  every hidden fault is matched (detection hints) by a reported finding with a reproduction
 *
 * and the outcome metrics an environment can tell (critical false release, recall, false fails, security incidents and
 * duplicate side effects from the fixture's probes). Evidence completeness is 0 by construction (nothing is verified) —
 * the release gate never treats a product baseline as releasable evidence. These arms answer the design's question
 * "is a mature general agent + the same tools good enough?", never a causal one.
 *
 * Live product runs need the product's CLI and its credentials (envPassthrough names them); they are deferred to the
 * live validation phase. Tests use a fake agent command.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HypertestError, type JsonValue, type Logger } from '@hypertest/core';
import { RELEASE_VERDICTS, expectedVerdicts, matchesHints } from './analysis.ts';
import { DEFAULT_PROBE_TIMEOUT_MS, runProbes } from './collect.ts';
import type { EvalArm, EvalTask, EvalTrial, ExternalAgentSpec, GraderResult, TrialContext, TrialFixture } from './contracts.ts';
import type { ResolvedGrader } from './graders.ts';
import { SECURITY_INCIDENTS_PROBE_NAME } from './metrics.ts';
import { decideTrialResult } from './harness.ts';

/** Revision of the external outcome graders. */
export const EXTERNAL_GRADER_REVISION = 'ext-1';
/** The report an external agent writes (`{report}`). */
export interface ExternalAgentReport {
  verdict: string;
  findings?: Array<{ title: string; description?: string; component?: string; severity?: string; reproduction?: string }>;
  summary?: string;
}

const VERDICTS = new Set(['pass', 'fail', 'conditional', 'inconclusive', 'needs_review']);

/** Substitutes {goal}, {workspace}, {sutUrl}, {report} in an argument. */
export function externalArgs(spec: Pick<ExternalAgentSpec, 'args'>, values: { goal: string; workspace: string; sutUrl?: string; report: string }): string[] {
  return spec.args.map((a) => a.replaceAll('{goal}', values.goal).replaceAll('{workspace}', values.workspace).replaceAll('{sutUrl}', values.sutUrl ?? '').replaceAll('{report}', values.report));
}

/** Problems of an external agent report (empty = valid). */
export function externalReportProblems(r: unknown): string[] {
  const x = r as Partial<ExternalAgentReport> | null;
  if (!x || typeof x !== 'object') return ['the report is not a JSON object'];
  const out: string[] = [];
  if (typeof x.verdict !== 'string' || !VERDICTS.has(x.verdict)) out.push(`verdict must be one of ${[...VERDICTS].join(', ')}`);
  if (x.findings !== undefined && (!Array.isArray(x.findings) || x.findings.some((f) => !f || typeof f.title !== 'string'))) out.push('findings must be a list of {title, description?, reproduction?}');
  return out;
}

async function runCommand(spec: ExternalAgentSpec, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; timedOut: boolean; cancelled: boolean; stderr: string }> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  if (process.env['HOME']) env['HOME'] = process.env['HOME'];
  for (const name of spec.envPassthrough ?? []) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    const child = spawn(spec.command, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr?.on('data', (d: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: null, timedOut, cancelled, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, cancelled, stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

function grader(graderId: string, pass: boolean, detail: string, score = pass ? 1 : 0): GraderResult {
  return { graderId, pass, score, detail, outcome: pass ? 'pass' : 'fail', revision: EXTERNAL_GRADER_REVISION };
}

/** Runs one trial of an external agent arm (see the module comment). Trial problems are results, never throws. */
export async function runExternalTrial(input: {
  task: EvalTask;
  arm: EvalArm;
  fixture: TrialFixture;
  ctx: TrialContext;
  graders: readonly ResolvedGrader[];
  revisions: Record<string, string>;
  timeoutMs: number;
  logger: Logger;
  signal?: AbortSignal;
  probeTimeoutMs?: number;
}): Promise<Partial<EvalTrial>> {
  const spec = input.arm.external!;
  const report = join(input.ctx.workDir, 'external-agent-report.json');
  const workspace = input.fixture.target.repoPath ?? input.ctx.workDir;
  const args = externalArgs(spec, { goal: input.task.goal, workspace, report, ...(input.fixture.target.sutUrl ? { sutUrl: input.fixture.target.sutUrl } : {}) });
  const ran = await runCommand(spec, args, workspace, spec.timeoutMs ?? input.timeoutMs, input.signal);
  const graderRevisions = { externalVerdict: EXTERNAL_GRADER_REVISION, externalDefectDetected: EXTERNAL_GRADER_REVISION };
  if (ran.cancelled) return { result: 'infra_error', error: 'the trial was cancelled (signal): the external agent was killed', cancelled: true, graderRevisions };
  const probes = await runProbes(input.fixture, input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  let parsed: ExternalAgentReport | undefined;
  let problem: string | undefined;
  try {
    const raw = JSON.parse(await readFile(report, 'utf8')) as unknown;
    const problems = externalReportProblems(raw);
    if (problems.length > 0) problem = `the external agent's report is invalid: ${problems.join('; ')}`;
    else parsed = raw as ExternalAgentReport;
  } catch (e) {
    problem = ran.timedOut ? `the external agent did not finish within ${spec.timeoutMs ?? input.timeoutMs} ms` : `the external agent wrote no report (${(e as Error).message}); exit ${String(ran.code)}${ran.stderr ? `: ${ran.stderr.slice(0, 300)}` : ''}`;
  }
  const outcomeMetrics: Record<string, number> = {};
  const security = probes[SECURITY_INCIDENTS_PROBE_NAME];
  if (security && typeof security === 'object' && !Array.isArray(security)) {
    outcomeMetrics['securityViolations'] = Object.values(security as Record<string, JsonValue>).reduce<number>((n, v) => n + (typeof v === 'number' && v > 0 ? v : 0), 0);
  }
  const effects = probes['sideEffects'];
  if (effects && typeof effects === 'object' && !Array.isArray(effects)) {
    outcomeMetrics['duplicateSideEffects'] = Object.entries(effects as Record<string, JsonValue>).filter(([k]) => !k.includes(':')).reduce((n, [, v]) => n + (typeof v === 'number' && v > 1 ? v - 1 : 0), 0);
  }
  if (!parsed) {
    // a timed-out agent fails (it did not finish); a missing/invalid report is ungradable
    return { result: ran.timedOut ? 'fail' : 'infra_error', error: problem ?? 'no report', outcomeMetrics, trajectoryMetrics: { exitCode: ran.code ?? -1 }, graderRevisions };
  }
  const expected = expectedVerdicts(input.task);
  const verdict = parsed.verdict;
  const match = expected.includes(verdict as never);
  const released = RELEASE_VERDICTS.has(verdict as never);
  outcomeMetrics['verdictMatch'] = match ? 1 : 0;
  outcomeMetrics['criticalFalseRelease'] = released && !expected.some((v) => RELEASE_VERDICTS.has(v)) ? 1 : 0;
  outcomeMetrics['falseFail'] = verdict === 'fail' && !expected.includes('fail') ? 1 : 0;
  // nothing the agent reports is verified evidence: completeness 0 for a decision, never 1
  outcomeMetrics['evidenceCompleteness'] = 0;
  outcomeMetrics['evidenceVerified'] = 0;
  const findings = (parsed.findings ?? []).map((f) => ({ title: f.title, description: f.description ?? '', component: f.component, reproduction: f.reproduction }));
  const faults = input.task.hiddenFaults ?? [];
  const detected = faults.filter((fault) => findings.some((f) => typeof f.reproduction === 'string' && f.reproduction.trim() !== '' && matchesHints({ title: f.title, description: f.description, component: f.component } as never, fault.detectionHints)));
  if (faults.length > 0) outcomeMetrics['defectRecall'] = detected.length / faults.length;
  outcomeMetrics['falsePositiveFindings'] = findings.filter((f) => !faults.some((fault) => matchesHints({ title: f.title, description: f.description, component: f.component } as never, fault.detectionHints))).length;
  const graders: GraderResult[] = [
    grader('externalVerdict', match, `the agent reported ${verdict}; expected ${expected.join(' or ')}`),
    grader('externalDefectDetected', detected.length === faults.length, faults.length === 0 ? 'no hidden fault' : `${detected.length}/${faults.length} hidden fault(s) reported with a reproduction`, faults.length === 0 ? 1 : detected.length / faults.length),
  ];
  const decided = decideTrialResult({ graders, timedOut: ran.timedOut, unexercised: [] });
  return {
    result: decided.result, ...(decided.error ? { error: decided.error } : {}), verdict: verdict as EvalTrial['verdict'] & string, graders, outcomeMetrics,
    trajectoryMetrics: { exitCode: ran.code ?? -1, reportedFindings: findings.length }, graderRevisions,
  };
}

/** An external agent arm (F[8]): `command`/`args` run the agent; nothing of Hypertest drives it. */
export function externalAgentArm(armId: string, description: string, spec: ExternalAgentSpec): EvalArm {
  if (typeof spec?.command !== 'string' || spec.command.trim() === '' || !Array.isArray(spec.args)) throw new HypertestError('invalid_argument', `external agent arm ${armId}: command and args are required`);
  if (!spec.args.some((a) => a.includes('{report}'))) throw new HypertestError('invalid_argument', `external agent arm ${armId}: an argument must name {report} (where the agent writes its verdict)`);
  return { armId, description, family: 'product', external: { ...spec, args: [...spec.args] }, config: (base) => base };
}
