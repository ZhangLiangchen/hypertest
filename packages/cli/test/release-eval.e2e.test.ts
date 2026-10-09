/**
 * (F[13], e2e[5], row 317) Every runtime release runs the CORE eval — on ITS OWN manifest: `eval run … --arms deployment`
 * evaluates the whole configuration file (models, roles, policies, gate, …) of the deployment, so its trials run under
 * the deployment's runtime manifest (`runtime show`) and the result is accepted as that release's evidence by
 * `runtime record-suite current --kind compatibility|release_gate --from-eval`; the result of another arm (another
 * manifest) is refused. Real scripted trials over the real stack (PGlite, or PostgreSQL with HYPERTEST_TEST_DB=postgres).
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MULTI_ROUTES } from '@hypertest/eval';
import type { SuiteResult } from '@hypertest/eval';
import type { RuntimeManifest } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { cli, parseJson, writeProject, type TestProject } from './helpers.ts';

describe('the deployment arm: a release evaluates its own manifest', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let project: TestProject;
  before(async () => {
    dir = await tempDir('ht-cli-release-eval-');
    // a deployment whose models are the scripted multi-LLM providers (the platform's scripted task brains drive them)
    project = await writeProject(dir.path, {
      models: { providers: [{ id: 'reason-a', kind: 'scripted' }, { id: 'fast-b', kind: 'scripted' }, { id: 'judge-c', kind: 'scripted' }], routes: MULTI_ROUTES },
      oracles: [],
      gate: {},
      // the deployment's own policy bundle: another runtime than the platform's scripted arm
      policy: { rules: [{ id: 'site.allow-reads', description: 'site rule', match: { effects: ['read'] }, decision: 'allow' }] },
      // (review) the deployment's own targets: never part of an evaluation (the arm drops them), and not of the manifest
      environments: [{ environmentId: 'prod-api', environmentClass: 'production', baseUrl: 'https://api.prod.example.invalid', generation: 1 }],
      tools: { httpAllowlist: ['https://api.prod.example.invalid'], urlEnvironmentClass: 'production' },
    });
  });
  after(async () => {
    await project?.dispose();
    await dir?.cleanup();
  });

  test('eval run --arms deployment: the trials run under the deployment manifest; record-suite accepts that result and refuses another arm\'s', async () => {
    const run = (argv: string[]) => cli(argv, { cwd: dir.path, env: project.env });
    let r = await run(['runtime', 'show', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const deployment = parseJson<RuntimeManifest>(r).manifestId;

    r = await run(['eval', 'run', 'context-freshness', '--arms', 'deployment', '--out', 'deployment.json', '--timeout-ms', '180000']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const result = JSON.parse(await readFile(join(dir.path, 'deployment.json'), 'utf8')) as SuiteResult;
    assert.deepEqual(result.trials.map((t) => [t.armId, t.result, t.runtimeManifestId]), [['deployment', 'pass', deployment]], 'the trial ran under the deployment\'s own manifest');
    assert.match(result.suiteFingerprint ?? '', /^[0-9a-f]{64}$/);

    // another arm (the platform's scripted arm: another configuration ⇒ another manifest) certifies nothing here
    r = await run(['eval', 'run', 'context-freshness', '--arms', 'scripted-multi-llm', '--out', 'other.json', '--timeout-ms', '180000']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const other = JSON.parse(await readFile(join(dir.path, 'other.json'), 'utf8')) as SuiteResult;
    assert.notEqual(other.trials[0]!.runtimeManifestId, deployment);

    r = await run(['runtime', 'register', '--by', 'alice']);
    assert.equal(r.code, 0, r.stderr);
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', 'other.json', '--by', 'ci:release']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`the eval result does not certify ${deployment}: its trials ran under ${other.trials[0]!.runtimeManifestId}`));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'compatibility', '--from-eval', 'deployment.json', '--by', 'ci:release', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const recorded = parseJson<{ passed: boolean; suiteId: string; binding: { kind: string; manifestIds: string[] } }>(r);
    assert.deepEqual([recorded.passed, recorded.suiteId, recorded.binding], [true, 'context-freshness', { kind: 'eval_trials', manifestIds: [deployment] }]);
    // a release gate needs the CORE suite: a context-freshness result does not open canary → active
    await writeFile(join(dir.path, 'baseline.json'), JSON.stringify({ ...other, trials: other.trials.map((t) => ({ ...t })) }));
    r = await run(['runtime', 'record-suite', 'current', '--kind', 'release_gate', '--from-eval', 'deployment.json', '--baseline', 'baseline.json', '--by', 'ci:release']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the release gate runs the core eval: candidate suite "context-freshness" does not count/);
  });
});
