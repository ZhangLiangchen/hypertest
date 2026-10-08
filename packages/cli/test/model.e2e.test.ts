/**
 * The model-governance commands over the real stack (PGlite, or PostgreSQL with HYPERTEST_TEST_DB=postgres):
 *  - A[3] `model switch <runId> <role|agentId> <routeId> --by <name>` records a manual switch request on L0;
 *  - A[1] `model prices set|list|clear` maintains the observed-prices file the price guard compares against;
 *  - coverage[7] `eval apply-scores` turns eval results into the auditable route-scores file.
 * Failure paths: unknown runs/routes/targets, malformed prices and inputs are refused with an exact reason and exit code.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createHypertest, loadConfig } from '@hypertest/app';
import type { TestRun } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { GOAL, SIM_ROUTE, cli, parseJson, writeProject, type TestProject } from './helpers.ts';

describe('hypertest model switch / model prices / eval apply-scores', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let project: TestProject;
  let env: Record<string, string>;
  let live: TestRun;

  before(async () => {
    dir = await tempDir('ht-cli-model-');
    project = await writeProject(dir.path);
    env = project.env;
    // a live run (its lead's turn never returns; the instance is closed mid-run, the run stays resumable)
    const config = await loadConfig(project.configPath, { env: { ...process.env, ...env } });
    const ht = await createHypertest(config, { env: { ...process.env, ...env }, scriptedBrains: { sim: () => new Promise(() => undefined) as never }, logger: new MemoryLogger() });
    try {
      live = await ht.start({ goal: GOAL, target: {} });
      // wait until the lead's agent exists (its model call never returns; close() interrupts it, the run stays live)
      for (let i = 0; i < 200 && (await ht.agents(live.runId)).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      await ht.close();
    }
  });
  after(async () => {
    await cli(['cancel', live.runId, '--reason', 'test done'], { cwd: dir.path, env }).catch(() => undefined);
    await project?.dispose();
    await dir?.cleanup();
  });

  test('A[3] model switch records a manual switch request for a role (L0 model.switch_requested); failure paths are exact', async () => {
    const r = await cli(['model', 'switch', live.runId, 'executor', 'sim-large', '--by', 'alice', '--reason', 'the provider is degraded', '--json'], { cwd: dir.path, env });
    assert.equal(r.code, 0, r.stderr);
    const sw = parseJson<{ switch: { switchId: string; runId: string; target: { kind: string; role?: string }; routeId: string; reason?: string; requestedBy: string } }>(r).switch;
    assert.deepEqual([sw.runId, sw.target, sw.routeId, sw.requestedBy], [live.runId, { kind: 'role', role: 'executor' }, 'sim-large', 'human:alice']);
    const events = await cli(['events', live.runId, '--types', 'model.switch_requested', '--json'], { cwd: dir.path, env });
    const lines = events.stdout.trim().split('\n').map((l) => JSON.parse(l) as { eventType: string; payload: { switchId: string; routeId: string } });
    assert.deepEqual(lines.map((e) => [e.eventType, e.payload.switchId, e.payload.routeId]), [['model.switch_requested', sw.switchId, 'sim-large']]);

    const unknownRoute = await cli(['model', 'switch', live.runId, 'executor', 'ghost', '--by', 'alice'], { cwd: dir.path, env });
    assert.equal(unknownRoute.code, 1);
    assert.match(unknownRoute.stderr, /route ghost is not in the model catalog .*\[invalid_argument\]\n$/);
    const unknownTarget = await cli(['model', 'switch', live.runId, 'nobody', 'sim-large', '--by', 'alice'], { cwd: dir.path, env });
    assert.equal(unknownTarget.code, 1);
    assert.match(unknownTarget.stderr, /nobody is neither an agent of run .* nor a role .*\[invalid_argument\]\n$/);
    const unknownRun = await cli(['model', 'switch', 'run_nope', 'executor', 'sim-large', '--by', 'alice'], { cwd: dir.path, env });
    assert.deepEqual([unknownRun.code, unknownRun.stderr], [1, 'hypertest model: run run_nope not found [not_found]\n']);
    const noBy = await cli(['model', 'switch', live.runId, 'executor', 'sim-large'], { cwd: dir.path, env });
    assert.equal(noBy.code, 2);
    assert.match(noBy.stderr, /--by/);
  });

  test('A[4] status <runId> shows the run\'s agents as their engine inspects them (state, turns, route epoch, model pause)', async () => {
    const j = parseJson<{ agents: Array<{ agentId: string; role: string; engineKind: string; engine: { status?: string; turnCount?: number; error?: string }; epoch: { routeId: string } | null; modelPause: unknown }> }>(
      await cli(['status', live.runId, '--json'], { cwd: dir.path, env }),
    );
    const lead = j.agents.find((a) => a.role === 'lead');
    assert.ok(lead, JSON.stringify(j.agents));
    assert.equal(lead!.engineKind, 'native');
    assert.equal(lead!.engine.error, undefined, 'engine.inspect answered');
    assert.equal(typeof lead!.engine.turnCount, 'number');
    assert.equal(lead!.modelPause ?? null, null, 'no model pause');
    const human = await cli(['status', live.runId], { cwd: dir.path, env });
    assert.match(human.stdout, /\nagents:\n {2}AGENT\s+ROLE\s+STATUS\s+ENGINE \(inspect\)\s+ROUTE \(epoch\)\s+MODEL PAUSE\n/);
    assert.match(human.stdout, new RegExp(`${lead!.agentId}\\s+lead\\s+\\w+\\s+native: `));
  });

  test('A[1] model prices set / list / clear maintain the observed-prices file; malformed input is refused', async () => {
    const file = join(dir.path, '.hypertest', 'state', 'model-prices.json');
    const set = parseJson<{ file: string; routeId: string; price: { inputPerMillionUsd: number; outputPerMillionUsd: number; source: string } }>(
      await cli(['model', 'prices', 'set', 'sim-large', '--input', '2.5', '--output', '10', '--source', 'invoice-2026-09', '--json'], { cwd: dir.path, env }),
    );
    assert.equal(set.file, file);
    assert.deepEqual([set.routeId, set.price.inputPerMillionUsd, set.price.outputPerMillionUsd, set.price.source], ['sim-large', 2.5, 10, 'invoice-2026-09']);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { version: number; prices: Record<string, { inputPerMillionUsd: number }> };
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.prices['sim-large']!.inputPerMillionUsd, 2.5);
    const list = await cli(['model', 'prices', 'list'], { cwd: dir.path, env });
    assert.equal(list.code, 0);
    assert.match(list.stdout, /sim-large\s+\$2\.5\/\$10\s+\$0\/\$0\s+invoice-2026-09/);
    const cleared = await cli(['model', 'prices', 'clear', 'sim-large', '--json'], { cwd: dir.path, env });
    assert.deepEqual(parseJson<{ prices: object }>(cleared).prices, {});

    const bad = await cli(['model', 'prices', 'set', 'sim-large', '--input', 'cheap', '--output', '1'], { cwd: dir.path, env });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--input must be a number ≥ 0 \(USD per million tokens\), got "cheap"/);
    const ghost = await cli(['model', 'prices', 'set', 'ghost', '--input', '1', '--output', '1'], { cwd: dir.path, env });
    assert.deepEqual([ghost.code, ghost.stderr], [1, 'hypertest model: route ghost is not configured (sim-large) [invalid_argument]\n']);
  });

  test('coverage[7] eval apply-scores writes the route-scores file with its provenance; malformed input is refused', async () => {
    const trials = [
      ...Array.from({ length: 4 }, () => ({ result: 'pass', modelRoutes: [{ role: 'executor', routeId: 'sim-large', calls: 3 }, { role: 'lead', routeId: 'sim-large', calls: 2 }] })),
      { result: 'fail', modelRoutes: [{ role: 'executor', routeId: 'sim-large', calls: 3 }] },
      { result: 'infra_error', modelRoutes: [{ role: 'executor', routeId: 'sim-large', calls: 1 }] },
    ];
    const input = join(dir.path, 'suite-result.json');
    await writeFile(input, JSON.stringify({ suiteId: 'core', revision: 'r1', trials }));
    const r = await cli(['eval', 'apply-scores', 'suite-result.json', '--out', 'out/scores.json', '--json'], { cwd: dir.path, env });
    assert.equal(r.code, 0, r.stderr);
    const j = parseJson<{ out: string; scores: Record<string, Record<string, number>>; source: { suiteId: string; trials: number } }>(r);
    // executor: 4 passes of 5 graded trials (infra errors are not graded) → (4+1)/(5+2); lead: 4 of 4 → 5/6
    assert.deepEqual(j.scores, { 'sim-large': { executor: 0.714, lead: 0.833 } });
    assert.deepEqual([j.source.suiteId, j.source.trials], ['core', 5]);
    const written = JSON.parse(await readFile(join(dir.path, 'out', 'scores.json'), 'utf8')) as { version: number; scores: object };
    assert.deepEqual([written.version, written.scores], [1, j.scores]);
    // the configuration accepts it (models.scoresFile) and the RuntimeManifest records it
    await mkdir(join(dir.path, 'scored'));
    const scored = await writeProject(join(dir.path, 'scored'), { models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [SIM_ROUTE], scoresFile: join(dir.path, 'out', 'scores.json') } });
    const config = await loadConfig(scored.configPath, { env: { ...process.env, ...scored.env } });
    const ht = await createHypertest(config, { env: { ...process.env, ...scored.env }, scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger() });
    try {
      assert.deepEqual(ht.manifest.modelScores?.routes, ['sim-large']);
      assert.equal(ht.services.catalog.get('sim-large')!.quality['executor'], 0.714);
    } finally {
      await ht.close();
      await scored.dispose();
    }

    const missing = await cli(['eval', 'apply-scores', 'nope.json', '--out', 'x.json'], { cwd: dir.path, env });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /nope\.json is not a readable SuiteResult JSON/);
    assert.equal(existsSync(join(dir.path, 'x.json')), false);
    await writeFile(join(dir.path, 'bad.json'), JSON.stringify({ trials: 'many' }));
    const malformed = await cli(['eval', 'apply-scores', 'bad.json', '--out', 'x.json'], { cwd: dir.path, env });
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /`trials` must be an array/);
    const noOut = await cli(['eval', 'apply-scores', 'suite-result.json'], { cwd: dir.path, env });
    assert.equal(noOut.code, 2);
  });
});
