/**
 * Experiment arms of the PoC suites.
 *
 * - `scripted-multi-llm`: three scripted providers with role-steering routes — `reason-a` (lead, analysts, metrics),
 *   `fast-b` (executor, test designer, RCA, environment: tool-reliable), `judge-c` (reviewer). Distinct providers make
 *   reviewer independence satisfiable and give ≥3 roles distinct route policies.
 * - `scripted-single`: one scripted provider/route for every role. The same policies run, but the reviewer — whose
 *   policy demands a provider independent of the producers — cannot be routed: independent review is impossible, which
 *   the QualityGate turns into `requiresHumanReview` (the comparison shows the value of the multi-LLM arm).
 * - `live` (optional): real providers from the environment when `HYPERTEST_EVAL_LIVE=1` (see liveArmAvailable).
 *
 * Every scripted arm runs in-process (arm.brains) and in trial child processes (arm.child → `src/brains/index.ts`,
 * export `pocChildBrains`), with the same brains arguments: {taskId, arm, …fixture.brainArgs}.
 */
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@hypertest/core';
import type { HypertestConfig, RouteConfig } from '@hypertest/app';
import type { EvalArm, EvalTask, TrialFixture } from './contracts.ts';
import { pocBrains } from './brains/index.ts';
import type { ArmKind, PocBrainArgs } from './brains/kit.ts';

/** Absolute path of the child-process brains module. */
export const POC_BRAINS_MODULE: string = fileURLToPath(new URL('./brains/index.ts', import.meta.url));

const ALL_CAPABILITIES: NonNullable<RouteConfig['capabilities']> = ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'];

function route(routeId: string, provider: string, quality: Record<string, number>, toolReliability: number, typicalLatencyMs: number): RouteConfig {
  return {
    routeId, provider, model: `${routeId}-1`, capabilities: [...ALL_CAPABILITIES], quality, toolReliability, typicalLatencyMs,
    contextWindow: 200_000, maxOutputTokens: 4096, maxActionRisk: 'critical', maxDataClassification: 'restricted', structuredOutput: 'native', reasoning: 'visible',
    // an explicit capability profile (A[2]): scripted models are free — a declared price of 0, never an unknown one
    costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0, enabled: true,
  };
}

/** Routes of the multi-LLM arm: role-steering quality maps (the router's quality stage picks the route per role). */
export const MULTI_ROUTES: readonly RouteConfig[] = Object.freeze([
  route('reason-a-large', 'reason-a', { default: 0.9, executor: 0.7, test_designer: 0.7, rca: 0.7, environment: 0.7, reviewer: 0.8 }, 0.85, 1500),
  route('fast-b-tools', 'fast-b', { default: 0.8, executor: 0.95, test_designer: 0.95, rca: 0.95, environment: 0.95 }, 0.97, 500),
  route('judge-c-review', 'judge-c', { default: 0.78, reviewer: 0.99 }, 0.9, 1200),
]);

/** The single route of the single-provider arm. */
export const SINGLE_ROUTES: readonly RouteConfig[] = Object.freeze([route('solo-large', 'solo', { default: 0.9 }, 0.9, 1000)]);

function scriptedConfig(base: HypertestConfig, arm: ArmKind): HypertestConfig {
  const routes = arm === 'multi' ? MULTI_ROUTES : SINGLE_ROUTES;
  const providers = [...new Set(routes.map((r) => r.provider))].map((id) => ({ id, kind: 'scripted' as const }));
  return { ...base, models: { providers, routes: routes.map((r) => JSON.parse(JSON.stringify(r)) as RouteConfig) } };
}

/** The brains arguments of a trial: the task, the arm and whatever the fixture hands to the brains. */
export function brainArgsFor(task: Pick<EvalTask, 'taskId'>, fixture: Pick<TrialFixture, 'brainArgs'>, arm: ArmKind): PocBrainArgs {
  const extra = fixture.brainArgs && typeof fixture.brainArgs === 'object' && !Array.isArray(fixture.brainArgs) ? (fixture.brainArgs as Record<string, JsonValue>) : {};
  return { ...(extra as Partial<PocBrainArgs>), taskId: task.taskId, arm };
}

function scriptedArm(armId: string, arm: ArmKind, description: string): EvalArm {
  return {
    armId,
    description,
    config: (base) => scriptedConfig(base, arm),
    brains: (task, fixture) => pocBrains(brainArgsFor(task, fixture, arm)),
    child: { brainsModule: POC_BRAINS_MODULE, brainsExport: 'pocChildBrains', args: (task, fixture) => brainArgsFor(task, fixture, arm) as unknown as JsonValue },
  };
}

export const scriptedMultiLlmArm: EvalArm = scriptedArm(
  'scripted-multi-llm',
  'multi',
  'three scripted providers (reason-a: lead/analysts/metrics, fast-b: executor/test designer/RCA/environment, judge-c: reviewer)',
);

export const scriptedSingleArm: EvalArm = scriptedArm('scripted-single', 'single', 'one scripted provider for every role (independent review impossible)');

/** The scripted arms compared by the suites (multi first). */
export const POC_ARMS: readonly EvalArm[] = Object.freeze([scriptedMultiLlmArm, scriptedSingleArm]);

/** The arms the CLI offers (`hypertest eval run <suite> --arms …`): the scripted arms, plus `live` when available. */
export function builtinArms(env: Record<string, string | undefined> = process.env): EvalArm[] {
  return liveArmAvailable(env).ok ? [...POC_ARMS, liveArm(env)] : [...POC_ARMS];
}

// ------------------------------------------------------------------------------------------------ live arm

/**
 * Whether the live arm can run: `HYPERTEST_EVAL_LIVE=1` and a provider configured through
 * `HYPERTEST_EVAL_LIVE_KIND` (`anthropic` | `openai-compatible`), `HYPERTEST_EVAL_LIVE_MODEL`, `HYPERTEST_EVAL_LIVE_API_KEY`
 * (and `HYPERTEST_EVAL_LIVE_BASE_URL` for openai-compatible). Returns the reason when it cannot.
 */
export function liveArmAvailable(env: Record<string, string | undefined> = process.env): { ok: true } | { ok: false; reason: string } {
  if (env['HYPERTEST_EVAL_LIVE'] !== '1') return { ok: false, reason: 'HYPERTEST_EVAL_LIVE is not 1 (live model calls are opt-in)' };
  const kind = env['HYPERTEST_EVAL_LIVE_KIND'];
  if (kind !== 'anthropic' && kind !== 'openai-compatible') return { ok: false, reason: 'HYPERTEST_EVAL_LIVE_KIND must be anthropic or openai-compatible' };
  if (!env['HYPERTEST_EVAL_LIVE_MODEL']) return { ok: false, reason: 'HYPERTEST_EVAL_LIVE_MODEL is not set' };
  if (!env['HYPERTEST_EVAL_LIVE_API_KEY']) return { ok: false, reason: 'HYPERTEST_EVAL_LIVE_API_KEY is not set' };
  if (kind === 'openai-compatible' && !env['HYPERTEST_EVAL_LIVE_BASE_URL']) return { ok: false, reason: 'HYPERTEST_EVAL_LIVE_BASE_URL is required for openai-compatible' };
  return { ok: true };
}

/** The live arm (real provider; the key is read at composition through apiKeyEnv, never stored in the config). */
export function liveArm(env: Record<string, string | undefined> = process.env): EvalArm {
  const kind = env['HYPERTEST_EVAL_LIVE_KIND'] === 'anthropic' ? 'anthropic' : 'openai-compatible';
  const model = env['HYPERTEST_EVAL_LIVE_MODEL'] ?? 'unset';
  const baseUrl = env['HYPERTEST_EVAL_LIVE_BASE_URL'];
  return {
    armId: 'live',
    description: `live ${kind} provider (${model})`,
    config: (base) => ({
      ...base,
      models: {
        providers: [{ id: 'live', kind, apiKeyEnv: 'HYPERTEST_EVAL_LIVE_API_KEY', ...(baseUrl ? { baseUrl } : {}), timeoutMs: 120_000 }],
        routes: [{ ...route('live-route', 'live', { default: 0.9 }, 0.9, 5000), model }],
      },
    }),
  };
}
