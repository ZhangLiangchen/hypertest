import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/blackbox/common.ts';
import { DockerEnvAdapter, EnvControlAdapter, envRestartTool, type ToolSpec } from '../src/index.ts';
import { newGateway, nextInvocationId, openBlackboxEnv, sideEffectRequest, type BlackboxEnv } from './blackbox-helpers.ts';

/**
 * env.docker against a REAL docker daemon (the unit tests use a fake CLI). Skips with an explicit reason
 * when no daemon is reachable or the test image cannot be started.
 */
const IMAGE = process.env['HYPERTEST_TEST_DOCKER_IMAGE'] ?? 'busybox:latest';
const NAME = `ht-bb-${process.pid}`;
let skipReason: string | undefined;
let env: BlackboxEnv | undefined;

before(async () => {
  const info = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
  if (info.exitCode !== 0) {
    skipReason = `docker daemon not available (${info.spawnError ?? info.stderr.trim().split('\n')[0] ?? `exit ${info.exitCode}`})`;
    return;
  }
  const run = await runCommand('docker', ['run', '-d', '--name', NAME, IMAGE, 'sleep', '300'], { timeoutMs: 120_000 });
  if (run.exitCode !== 0) {
    skipReason = `cannot start test container from ${IMAGE}: ${run.stderr.trim().split('\n')[0]}`;
    return;
  }
  env = await openBlackboxEnv({ environments: [{ environmentId: 'env_real_docker', environmentClass: 'local', generation: 1, control: { kind: 'docker', target: NAME } }] });
});

after(async () => {
  if (!skipReason) await runCommand('docker', ['rm', '-f', NAME], { timeoutMs: 60_000 });
  await env?.dispose();
});

test('real docker: env.restart through env.control is verified and bumps the generation', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const docker = new DockerEnvAdapter({ environments: env!.environments, clockSkewMs: 2000 });
  const { gateway } = newGateway(env!, [new EnvControlAdapter({ environments: env!.environments, backends: { docker } })]);
  const out = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_real_docker', reason: 'integration' }, env!.environments, nextInvocationId(), { verifyWithinMs: 20_000 }));
  assert.equal(out.status, 'verified', JSON.stringify(out));
  assert.equal(env!.environments.get('env_real_docker')!.generation, 2);
});
