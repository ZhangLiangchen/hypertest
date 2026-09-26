/**
 * The CLI over the real stack (PGlite, or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres): `hypertest run` with a
 * scripted provider (`--scripted-brains`) against a git repository with a real node:test suite, then status, report,
 * events and evidence verify on the finished run; the verdict-aware exit codes (pass 0, fail 3, conditional 4,
 * inconclusive 5); interruption (130) and `hypertest resume`; human decisions (approvals, oracle proposals, cancel);
 * and failure paths that must not create runs.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createHypertest, loadConfig } from '@hypertest/app';
import type { DomainEvent, QualityDecision, TestRun } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { hooks } from './fixtures/brains.ts';
import { BRAINS, GOAL, cli, parseJson, sumRepo, writeProject, type TestProject } from './helpers.ts';

type RunJson = { runId: string; status: string; verdict: string | null; decisionId: string | null; requiresHumanReview: boolean | null; evidenceRootHash: string | null; runtimeManifestId: string; exitCode: number };

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe('hypertest run → status / report / events / evidence verify on the finished run', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;
  let result: Awaited<ReturnType<typeof cli>>;
  let run: RunJson;

  before(async () => {
    dir = await tempDir('ht-cli-e2e-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env, HT_CLI_SCENARIO: 'pass' };
    result = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--label', 'project=calc', '--scripted-brains', BRAINS, '--json', '--timeout-ms', '120000'], { cwd: dir.path, env });
    run = parseJson<RunJson>(result);
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('run: the QualityGate verdict pass ⇒ exit 0; --json carries the decision and the manifest', () => {
    assert.equal(result.code, 0, result.stderr);
    assert.match(run.runId, /^run_[0-9A-Z]{26}$/);
    assert.equal(run.status, 'completed');
    assert.equal(run.verdict, 'pass');
    assert.equal(run.exitCode, 0);
    assert.equal(run.requiresHumanReview, false);
    assert.match(run.decisionId!, /^qd_/);
    assert.match(run.evidenceRootHash!, /^[0-9a-f]{64}$/);
    assert.match(run.runtimeManifestId, /^rm_[0-9a-f]{64}$/);
    // --json keeps stderr free of progress lines (logs are warn+ JSON lines only)
    assert.equal(result.stderr.split('\n').filter((l) => l !== '' && !l.startsWith('{')).length, 0, result.stderr);
  });

  test('status <runId>: the run pinned to the resolved commit, its labels and verdict (--json and human)', async () => {
    const j = await cli(['status', run.runId, '--json'], { cwd: dir.path, env });
    assert.equal(j.code, 0, j.stderr);
    const s = parseJson<{ run: TestRun; decision: QualityDecision; needsReassessment: boolean }>(j);
    assert.equal(s.run.status, 'completed');
    assert.equal(s.run.goal, GOAL);
    assert.deepEqual(s.run.target, { repoPath: repo.path, commit: repo.head });
    assert.deepEqual(s.run.labels, { project: 'calc' });
    assert.equal(s.run.runtimeManifestId, run.runtimeManifestId);
    assert.equal(s.decision.decisionId, run.decisionId);
    assert.equal(s.decision.verdict, 'pass');
    assert.equal(s.needsReassessment, false);
    const h = await cli(['status', run.runId], { cwd: dir.path, env });
    assert.equal(h.code, 0);
    const lines = h.stdout.split('\n');
    assert.equal(lines[0], `run        ${run.runId}`);
    assert.equal(lines[1], 'status     completed');
    assert.ok(lines.includes(`target     repo ${repo.path}, commit ${repo.head}`), h.stdout);
    assert.ok(lines.includes('verdict    PASS'), h.stdout);
    assert.ok(lines.includes('labels     project=calc'), h.stdout);
  });

  test('status: the run list (newest first) with verdicts; filters', async () => {
    const h = await cli(['status'], { cwd: dir.path, env });
    assert.equal(h.code, 0);
    const [header, row] = h.stdout.split('\n');
    assert.match(header!, /^RUN\s+STATUS\s+VERDICT\s+CREATED\s+GOAL$/);
    assert.match(row!, new RegExp(`^${run.runId}\\s+completed\\s+PASS\\s+\\S+\\s+${GOAL.replace('?', '\\?')}$`));
    const j = await cli(['status', '--json', '--status', 'completed'], { cwd: dir.path, env });
    assert.deepEqual(parseJson<Array<{ runId: string; verdict: string }>>(j).map((r) => [r.runId, r.verdict]), [[run.runId, 'pass']]);
    const none = await cli(['status', '--status', 'running,paused'], { cwd: dir.path, env });
    assert.deepEqual([none.code, none.stdout], [0, 'no runs\n']);
  });

  test('report: markdown by default, the report JSON with --json, or a file with --out', async () => {
    const md = await cli(['report', run.runId], { cwd: dir.path, env });
    assert.equal(md.code, 0);
    assert.match(md.stdout, new RegExp(`^# Hypertest report — run ${run.runId}\\n`));
    assert.match(md.stdout, new RegExp(`- \\*\\*Verdict:\\*\\* PASS \\(decision ${run.decisionId}, revision 1, signed by ed25519:[0-9a-f]+\\)`));
    const j = await cli(['report', run.runId, '--json'], { cwd: dir.path, env });
    const report = parseJson<{ runId: string; verdict: string; evidence: { count: number; rootHash: string; sealed: boolean }; workItems: Array<{ role: string; state: string }> }>(j);
    assert.equal(report.runId, run.runId);
    assert.equal(report.verdict, 'pass');
    assert.equal(report.evidence.rootHash, run.evidenceRootHash);
    assert.equal(report.evidence.sealed, true);
    assert.deepEqual(report.workItems.map((w) => `${w.role}:${w.state}`).sort(), ['executor:completed', 'lead:completed', 'lead:completed']);
    const out = await cli(['report', run.runId, '--out', 'report.md'], { cwd: dir.path, env });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, `wrote ${join(dir.path, 'report.md')} (verdict PASS)\n`);
    assert.equal(await readFile(join(dir.path, 'report.md'), 'utf8'), md.stdout);
  });

  test('events: the L0 stream in seq order (human, NDJSON, --types, --after); --follow ends on a finished run', async () => {
    const j = await cli(['events', run.runId, '--json'], { cwd: dir.path, env });
    assert.equal(j.code, 0);
    const events = j.stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as DomainEvent<unknown>);
    assert.equal(events[0]!.eventType, 'run.created');
    assert.equal(events.at(-1)!.eventType, 'run.completed');
    const seqs = events.map((e) => e.seq!);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1));
    for (const t of ['plan.accepted', 'model.routed', 'tool.called', 'evidence.attached', 'test.passed', 'evidence.sealed', 'gate.evaluated', 'gate.passed']) assert.ok(events.some((e) => e.eventType === t), t);
    const human = await cli(['events', run.runId], { cwd: dir.path, env });
    const lines = human.stdout.trimEnd().split('\n');
    assert.equal(lines.length, events.length);
    assert.match(lines[0]!, /^ {4}1 {2}\S+ {2}run\.created {15}system:app$/);
    const typed = await cli(['events', run.runId, '--json', '--types', 'gate.evaluated,run.completed'], { cwd: dir.path, env });
    assert.deepEqual(typed.stdout.trimEnd().split('\n').map((l) => (JSON.parse(l) as DomainEvent<unknown>).eventType), ['gate.evaluated', 'run.completed']);
    const tail = await cli(['events', run.runId, '--json', '--after', String(seqs.length - 2)], { cwd: dir.path, env });
    assert.deepEqual(tail.stdout.trimEnd().split('\n').map((l) => (JSON.parse(l) as DomainEvent<unknown>).seq), [seqs.length - 1, seqs.length]);
    const follow = await cli(['events', run.runId, '--follow'], { cwd: dir.path, env, signal: new AbortController().signal });
    assert.equal(follow.code, 0);
    assert.equal(follow.stdout, human.stdout);
  });

  test('evidence verify: chain, artifacts, seal and the signed verdict verify (exit 0)', async () => {
    const h = await cli(['evidence', 'verify', run.runId], { cwd: dir.path, env });
    assert.equal(h.code, 0, h.stdout + h.stderr);
    assert.match(h.stdout, new RegExp(`^evidence of run ${run.runId} verified: 2 records, root ${run.evidenceRootHash}, sealed by ed25519:[0-9a-f]+\\n$`));
    const j = await cli(['evidence', 'verify', run.runId, '--json'], { cwd: dir.path, env });
    assert.deepEqual(parseJson(j), { runId: run.runId, ok: true, problems: [], records: 2, rootHash: run.evidenceRootHash, sealed: true });
  });

  test('unknown run ids are failures (exit 1, not_found) for every read command', async () => {
    for (const argv of [['status', 'run_nope'], ['report', 'run_nope'], ['events', 'run_nope'], ['evidence', 'verify', 'run_nope'], ['cancel', 'run_nope', '--reason', 'x']]) {
      const r = await cli(argv, { cwd: dir.path, env });
      assert.equal(r.code, 1, argv.join(' '));
      assert.equal(r.stderr, `hypertest ${argv[0]}: run run_nope not found [not_found]\n`, argv.join(' '));
    }
  });

  test('cancel of a completed run is a conflict: the outcome is kept (exit 1)', async () => {
    const r = await cli(['cancel', run.runId, '--reason', 'too late'], { cwd: dir.path, env });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `hypertest cancel: run ${run.runId} is already completed [conflict]\n`);
    const s = parseJson<{ run: TestRun }>(await cli(['status', run.runId, '--json'], { cwd: dir.path, env }));
    assert.equal(s.run.status, 'completed');
  });

  test('approvals / approve: a human decides (approve, --deny); the requester cannot; decisions are final', async () => {
    // two approval requests of an agent of the run, filed through the application services
    const config = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    const ht = await createHypertest(config, { env: { ...process.env, ...env }, scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger() });
    const ctx = { runId: run.runId, correlationId: run.runId, actorId: 'agent:ag_requester' };
    let first: string;
    let second: string;
    try {
      first = (await ht.services.approvals.request({ runId: run.runId, kind: 'action', subject: { tool: 'env.restart', target: 'staging' }, requestedBy: { kind: 'agent', id: 'ag_requester', role: 'environment' }, rationale: 'restart staging' }, ctx)).approvalId;
      second = (await ht.services.approvals.request({ runId: run.runId, kind: 'action', subject: { tool: 'env.deploy', target: 'staging' }, requestedBy: { kind: 'agent', id: 'ag_requester', role: 'environment' }, rationale: 'deploy staging' }, ctx)).approvalId;
    } finally {
      await ht.close();
    }
    const listed = await cli(['approvals'], { cwd: dir.path, env });
    assert.equal(listed.code, 0);
    const rows = listed.stdout.trimEnd().split('\n');
    assert.match(rows[0]!, /^APPROVAL\s+RUN\s+KIND\s+STATUS\s+REQUESTED BY\s+CREATED\s+SUBJECT$/);
    assert.equal(rows.length, 3);
    const firstRow = rows.find((r) => r.startsWith(first))!;
    assert.match(firstRow, new RegExp(`^${first}\\s+${run.runId}\\s+action\\s+pending\\s+agent:ag_requester\\s+\\S+\\s+\\{.*"tool":"env\\.restart".*\\}$`));

    // the requester can never decide its own request, even when calling itself a human
    const self = await cli(['approve', first, '--by', 'ag_requester', '--reason', 'mine'], { cwd: dir.path, env });
    assert.equal(self.code, 1);
    assert.equal(self.stderr, `hypertest approve: requester ag_requester cannot decide their own approval ${first} [permission_denied]\n`);

    const ok = await cli(['approve', first, '--by', 'alice', '--reason', 'maintenance window agreed'], { cwd: dir.path, env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, `approval ${first} approved by human:alice (run ${run.runId})\n`);
    const deny = await cli(['approve', second, '--deny', '--by', 'bob', '--reason', 'not now', '--json'], { cwd: dir.path, env });
    assert.equal(deny.code, 0);
    assert.deepEqual(parseJson(deny), { approvalId: second, status: 'denied', runId: run.runId, decidedBy: 'human:bob' });

    const again = await cli(['approve', first, '--deny', '--by', 'carol', '--reason', 'changed my mind'], { cwd: dir.path, env });
    assert.equal(again.code, 1);
    assert.equal(again.stderr, `hypertest approve: approval ${first} is already approved [precondition_failed]\n`);
    const unknown = await cli(['approve', 'appr_nope', '--by', 'alice', '--reason', 'x'], { cwd: dir.path, env });
    assert.deepEqual([unknown.code, unknown.stderr], [1, 'hypertest approve: approval appr_nope not found [not_found]\n']);

    const pending = await cli(['approvals'], { cwd: dir.path, env });
    assert.equal(pending.stdout, 'no pending approvals\n');
    const all = parseJson<Array<{ approvalId: string; status: string; decidedBy: { kind: string; id: string }; rationale: string }>>(await cli(['approvals', '--all', '--json', '--run', run.runId], { cwd: dir.path, env }));
    assert.deepEqual(all.map((a) => [a.approvalId, a.status, `${a.decidedBy.kind}:${a.decidedBy.id}`, a.rationale]).sort(), [
      [first, 'approved', 'human:alice', 'maintenance window agreed'],
      [second, 'denied', 'human:bob', 'not now'],
    ].sort());
    const denied = parseJson<unknown[]>(await cli(['approvals', '--status', 'denied', '--json'], { cwd: dir.path, env }));
    assert.equal(denied.length, 1);
  });

  test('oracle proposals / decide: none pending; an unknown proposal is not_found (exit 1)', async () => {
    const list = await cli(['oracle', 'proposals'], { cwd: dir.path, env });
    assert.deepEqual([list.code, list.stdout], [0, 'no oracle change proposals\n']);
    const r = await cli(['oracle', 'decide', 'ocp_nope', '--reject', '--by', 'alice', '--reason', 'weakens the oracle'], { cwd: dir.path, env });
    assert.deepEqual([r.code, r.stderr], [1, 'hypertest oracle: oracle change proposal ocp_nope not found [not_found]\n']);
  });

  test('evidence verify reports a tampered artifact (exit 1) — I6 through the CLI', async () => {
    const artifactsDir = join(dir.path, '.hypertest', 'artifacts');
    const stored = await files(artifactsDir);
    assert.ok(stored.length >= 2, 'no stored artifacts');
    for (const f of stored) {
      await chmod(f, 0o600);
      await writeFile(f, 'tampered bytes');
    }
    const r = await cli(['evidence', 'verify', run.runId], { cwd: dir.path, env });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`^evidence of run ${run.runId} FAILED verification \\(\\d+ problems?\\):\\n {2}- `));
    const j = parseJson<{ ok: boolean; problems: string[] }>(await cli(['evidence', 'verify', run.runId, '--json'], { cwd: dir.path, env }));
    assert.equal(j.ok, false);
    assert.ok(j.problems.some((p) => /artifact/i.test(p)), j.problems.join('\n'));
  });
});

describe('verdict-aware exit codes of hypertest run', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let good: Awaited<ReturnType<typeof sumRepo>>;
  let bad: Awaited<ReturnType<typeof sumRepo>>;
  const projects: TestProject[] = [];

  before(async () => {
    dir = await tempDir('ht-cli-verdicts-');
    good = await sumRepo(true);
    bad = await sumRepo(false);
  });
  after(async () => {
    for (const p of projects) await p.dispose();
    await good?.cleanup();
    await bad?.cleanup();
    await dir?.cleanup();
  });

  async function runScenario(name: string, scenario: string, repoPath: string, extra: Record<string, unknown> = {}, args: string[] = []) {
    const cwd = join(dir.path, name);
    await mkdir(cwd);
    const project = await writeProject(cwd, extra);
    projects.push(project);
    const r = await cli(['run', GOAL, '--repo', repoPath, '--commit', 'HEAD', '--scripted-brains', BRAINS, '--timeout-ms', '120000', ...args], { cwd, env: { ...project.env, HT_CLI_SCENARIO: scenario } });
    return { r, cwd, env: { ...project.env } };
  }

  test('fail ⇒ 3: a failing suite and an unresolved P1 product defect (--follow streams the events to stderr)', async () => {
    const { r } = await runScenario('fail', 'fail', bad.path, {}, ['--follow']);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const lines = r.stderr.trimEnd().split('\n');
    assert.match(lines[0]!, /^run run_\S+ started \(runtime manifest rm_[0-9a-f]{64}\)$/);
    // stderr also carries the JSON log lines (warn+); every other line is one event line
    const eventLines = lines.slice(1).filter((l) => !l.startsWith('{'));
    for (const l of eventLines) assert.match(l, /^ *\d+ {2}\d{4}-\d{2}-\d{2}T\S+ {2}\S+/);
    const types = eventLines.map((l) => l.trim().split(/\s+/)[2]);
    const seqs = eventLines.map((l) => Number(l.trim().split(/\s+/)[0]));
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), 'every event once, in seq order');
    assert.equal(types[0], 'run.created');
    assert.equal(types.at(-1), 'run.completed');
    for (const t of ['test.failed', 'finding.created', 'gate.evaluated', 'gate.failed']) assert.ok(types.includes(t), t);
    assert.match(r.stdout, /^run run_\S+ completed\nverdict FAIL {2}decision qd_\S+\n {2}violated {2}C2 unresolved_findings: 1 product and 0 test\/infrastructure findings unresolved\n {2}unresolved findings: rec_\S+\n {2}evidence root [0-9a-f]{64} \(\d+ records\)\nreport: hypertest report run_\S+\n$/);
  });

  test('conditional ⇒ 4: the suite passes but the gate requires an independent review nobody gave', async () => {
    const { r } = await runScenario('conditional', 'pass', good.path, { gate: { requireIndependentReview: true } });
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.match(r.stdout, /\nverdict CONDITIONAL \(requires human review\) {2}decision qd_\S+\n {2}violated {2}C6 independent_review: no independent approving review\n/);
  });

  test('inconclusive ⇒ 5: readiness declared without the required test-result evidence (never pass)', async () => {
    const { r, cwd, env } = await runScenario('inconclusive', 'inconclusive', good.path);
    assert.equal(r.code, 5, r.stdout + r.stderr);
    assert.match(r.stdout, /\nverdict INCONCLUSIVE {2}decision qd_\S+\n/);
    assert.match(r.stdout, /\n {2}unknown {3}C4 required_evidence: 1 requirements, 1 unmet\n/);
    const runId = /^run (run_\S+) completed/.exec(r.stdout)![1]!;
    const s = parseJson<{ decision: QualityDecision }>(await cli(['status', runId, '--json'], { cwd, env }));
    assert.equal(s.decision.verdict, 'inconclusive');
  });
});

describe('interruption and hypertest resume', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;

  before(async () => {
    dir = await tempDir('ht-cli-resume-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env, HT_CLI_SCENARIO: 'pass' };
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('an interrupted run exits 130 and stays resumable; resume drives it to its verdict; nothing is left to resume', async () => {
    const stop = new AbortController();
    const interrupted = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS], {
      cwd: dir.path,
      env,
      signal: stop.signal,
      onStderr: (text) => {
        if (/run run_\S+ started/.test(text)) stop.abort();
      },
    });
    assert.equal(interrupted.code, 130, interrupted.stderr);
    const runId = /run (run_\S+) started/.exec(interrupted.stderr)![1]!;
    assert.match(interrupted.stderr, new RegExp(`interrupted: run ${runId} is resumable with \`hypertest resume\`\\n$`));
    assert.equal(interrupted.stdout, '');
    const before = parseJson<{ run: TestRun; decision: QualityDecision | null }>(await cli(['status', runId, '--json'], { cwd: dir.path, env }));
    assert.notEqual(before.run.status, 'completed');
    assert.equal(before.decision, null);

    // a resume that drives agents needs the brains
    const noBrains = await cli(['resume'], { cwd: dir.path, env });
    assert.equal(noBrains.code, 2);
    assert.equal(noBrains.stderr, 'hypertest resume: model provider sim is scripted: pass --scripted-brains <module> exporting brains.sim\nrun `hypertest resume --help` for usage\n');

    const resumed = await cli(['resume', '--scripted-brains', BRAINS, '--json', '--timeout-ms', '120000'], { cwd: dir.path, env });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(parseJson(resumed), { resumed: [runId], outcomes: [{ runId, status: 'completed', verdict: 'pass' }] });
    const verify = await cli(['evidence', 'verify', runId], { cwd: dir.path, env });
    assert.equal(verify.code, 0, verify.stdout);

    const nothing = await cli(['resume', '--scripted-brains', BRAINS], { cwd: dir.path, env });
    assert.deepEqual([nothing.code, nothing.stdout], [0, 'no incomplete runs pinned to this runtime\n']);
  });
});

describe('status during the gate feedback loop: an interim decision is never the verdict', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;

  before(async () => {
    dir = await tempDir('ht-cli-interim-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env, HT_CLI_SCENARIO: 'inconclusive' };
  });
  after(async () => {
    hooks.onReplan = undefined;
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('stopped between the interim gate and the replan it asked for: no verdict (interim shown apart); resume reaches the final one', async () => {
    // the inconclusive scenario: the first gate lacks the required evidence and sends the lead back (interim decision);
    // the run is interrupted exactly when the lead starts that replan
    const stop = new AbortController();
    hooks.onReplan = () => stop.abort();
    let interrupted: Awaited<ReturnType<typeof cli>>;
    try {
      interrupted = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS, '--json'], { cwd: dir.path, env, signal: stop.signal });
    } finally {
      hooks.onReplan = undefined;
    }
    assert.equal(interrupted.code, 130, interrupted.stdout + interrupted.stderr);
    // --json: stdout still carries one document naming the run
    const out = parseJson<{ runId: string; status: null; verdict: null; interrupted: boolean; runtimeManifestId: string; exitCode: number }>(interrupted);
    assert.match(out.runId, /^run_/);
    assert.deepEqual([out.status, out.verdict, out.interrupted, out.exitCode], [null, null, true, 130]);
    assert.match(out.runtimeManifestId, /^rm_[0-9a-f]{64}$/);
    const runId = out.runId;

    const gates = (await cli(['events', runId, '--json', '--types', 'gate.evaluated'], { cwd: dir.path, env })).stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as DomainEvent<{ final: boolean; verdict: string }>);
    assert.deepEqual(gates.map((e) => [e.payload.verdict, e.payload.final]), [['inconclusive', false]], 'exactly one interim gate evaluation');
    const interimId = gates[0]!.aggregateId;

    const j = parseJson<{ run: TestRun; decision: QualityDecision | null; interimDecision: QualityDecision | null; needsReassessment: boolean }>(await cli(['status', runId, '--json'], { cwd: dir.path, env }));
    assert.equal(j.run.status, 'running');
    assert.equal(j.run.decisionId, undefined);
    assert.equal(j.decision, null, 'an interim decision is not the run\'s verdict');
    assert.equal(j.interimDecision?.decisionId, interimId);
    assert.equal(j.interimDecision?.verdict, 'inconclusive');
    const h = await cli(['status', runId], { cwd: dir.path, env });
    const lines = h.stdout.split('\n');
    assert.ok(lines.includes('verdict    -'), h.stdout);
    assert.ok(lines.includes(`interim    INCONCLUSIVE (decision ${interimId}, revision 1; not final: the gate asked for more evidence)`), h.stdout);
    const listed = parseJson<Array<{ runId: string; verdict: string | null }>>(await cli(['status', '--json'], { cwd: dir.path, env }));
    assert.deepEqual(listed.map((r) => [r.runId, r.verdict]), [[runId, null]]);

    const resumed = await cli(['resume', '--scripted-brains', BRAINS, '--json', '--timeout-ms', '120000'], { cwd: dir.path, env });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(parseJson(resumed), { resumed: [runId], outcomes: [{ runId, status: 'completed', verdict: 'inconclusive' }] });
    const done = parseJson<{ run: TestRun; decision: QualityDecision; interimDecision: QualityDecision | null }>(await cli(['status', runId, '--json'], { cwd: dir.path, env }));
    assert.equal(done.run.status, 'completed');
    assert.equal(done.decision.decisionId, done.run.decisionId);
    assert.notEqual(done.decision.decisionId, interimId);
    assert.equal(done.decision.supersedes, interimId);
    assert.equal(done.interimDecision, null);
  });
});

describe('cancel a live run', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string>;

  before(async () => {
    dir = await tempDir('ht-cli-cancel-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env, HT_CLI_SCENARIO: 'pass' };
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('an interrupted run is cancelled with its open work swept: no verdict, nothing left to resume; a repeated cancel is idempotent', async () => {
    const stop = new AbortController();
    const interrupted = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS], {
      cwd: dir.path, env, signal: stop.signal, onStderr: (text) => (/run run_\S+ started/.test(text) ? stop.abort() : undefined),
    });
    assert.equal(interrupted.code, 130, interrupted.stderr);
    const runId = /run (run_\S+) started/.exec(interrupted.stderr)![1]!;

    // a resume interrupted during startup resumes nothing: the run is untouched
    const eventsBefore = (await cli(['events', runId, '--json'], { cwd: dir.path, env })).stdout;
    const aborted = new AbortController();
    aborted.abort();
    const early = await cli(['resume', '--scripted-brains', BRAINS, '--json'], { cwd: dir.path, env, signal: aborted.signal });
    assert.equal(early.code, 130);
    assert.deepEqual(parseJson(early), { resumed: [], outcomes: [], interrupted: true });
    assert.equal((await cli(['events', runId, '--json'], { cwd: dir.path, env })).stdout, eventsBefore);

    const r = await cli(['cancel', runId, '--reason', 'release withdrawn'], { cwd: dir.path, env });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, `run ${runId} cancelled\n`, '']);
    const s = parseJson<{ run: TestRun; decision: QualityDecision | null; interimDecision: QualityDecision | null }>(await cli(['status', runId, '--json'], { cwd: dir.path, env }));
    assert.deepEqual([s.run.status, s.decision, s.interimDecision], ['cancelled', null, null]);
    const report = parseJson<{ workItems: Array<{ role: string; state: string }> }>(await cli(['report', runId, '--json'], { cwd: dir.path, env }));
    assert.ok(report.workItems.length > 0);
    for (const w of report.workItems) assert.ok(['cancelled', 'completed', 'failed'].includes(w.state), `${w.role} left ${w.state}`);

    const nothing = await cli(['resume', '--scripted-brains', BRAINS], { cwd: dir.path, env });
    assert.deepEqual([nothing.code, nothing.stdout], [0, 'no incomplete runs pinned to this runtime\n']);
    const again = await cli(['cancel', runId, '--reason', 'again', '--json'], { cwd: dir.path, env });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(parseJson(again), { runId, status: 'cancelled' });
  });
});

describe('run failure paths', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;

  before(async () => {
    dir = await tempDir('ht-cli-runfail-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('a scripted provider without --scripted-brains is a usage error before the store is opened', async () => {
    const r = await cli(['run', GOAL, '--repo', repo.path], { cwd: dir.path, env: project.env });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'hypertest run: model provider sim is scripted: pass --scripted-brains <module> exporting brains.sim\nrun `hypertest run --help` for usage\n');
    assert.equal(existsSync(join(dir.path, '.hypertest')), false);
  });

  test('interrupted before the run is started (e.g. Ctrl-C during startup): exit 130 and no run is created', async () => {
    const stop = new AbortController();
    stop.abort();
    const r = await cli(['run', GOAL, '--repo', repo.path, '--scripted-brains', BRAINS, '--json'], { cwd: dir.path, env: project.env, signal: stop.signal });
    assert.equal(r.code, 130, r.stderr);
    assert.equal(r.stderr, 'interrupted before the run was started: no run was created\n');
    const out = parseJson<{ runId: null; interrupted: boolean; exitCode: number }>(r);
    assert.deepEqual([out.runId, out.interrupted, out.exitCode], [null, true, 130]);
    assert.deepEqual(parseJson<unknown[]>(await cli(['status', '--json'], { cwd: dir.path, env: project.env })), []);
  });

  test('--detach with the local durable runtime is refused (exit 1) and creates no run', async () => {
    const r = await cli(['run', GOAL, '--repo', repo.path, '--detach', '--scripted-brains', BRAINS], { cwd: dir.path, env: project.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^hypertest run: --detach needs durable\.kind temporal: with the local durable runtime the run is driven by this process and would stop when `hypertest run` exits/);
    const runs = await cli(['status', '--json'], { cwd: dir.path, env: project.env });
    assert.deepEqual(parseJson<unknown[]>(runs), []);
  });

  test('a --commit that is not a commit of the repository is refused (exit 1) and creates no run', async () => {
    const r = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'no-such-ref', '--scripted-brains', BRAINS], { cwd: dir.path, env: project.env });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `hypertest run: --commit "no-such-ref" is not a commit of ${repo.path} [invalid_argument]\n`);
    assert.deepEqual(parseJson<unknown[]>(await cli(['status', '--json'], { cwd: dir.path, env: project.env })), []);
  });

  test('an invalid run id is refused by the application (exit 1) and creates no run', async () => {
    const r = await cli(['run', GOAL, '--repo', repo.path, '--run-id', '../escape', '--scripted-brains', BRAINS], { cwd: dir.path, env: project.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^hypertest run: runId must match .+ \[invalid_argument\]\n$/);
    assert.deepEqual(parseJson<unknown[]>(await cli(['status', '--json'], { cwd: dir.path, env: project.env })), []);
  });
});
