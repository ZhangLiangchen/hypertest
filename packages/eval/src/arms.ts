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
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { HypertestConfig, RouteConfig } from '@hypertest/app';
import type { EvalArm, EvalTask, HarnessFeatures, TrialFixture } from './contracts.ts';
import { pocBrains } from './brains/index.ts';
import type { ArmKind, PocBrainArgs } from './brains/kit.ts';
import { scriptedWireFetch, wireHost, type WireCall, type WireClass, type WireEndpoint } from './wire.ts';

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

export function scriptedConfig(base: HypertestConfig, arm: ArmKind): HypertestConfig {
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

// ------------------------------------------------------------------------------------------------ causal arms (F[8])

/**
 * (F[8], coverage[14]) The controlled causal arms H0…H6 (architecture-improvements §对比实验): the SAME model configuration
 * (the scripted multi-LLM routes and brains), only the harness varies — each arm switches subsystems on cumulatively
 * through `harness.features` (honoured for eval trial instances only; recorded on every trial as `harnessFeatures`):
 *
 * | arm                    | subagents | dynamicScheduler | blackboard | contextFreshness | oracleGovernance |
 * |------------------------|:---------:|:----------------:|:----------:|:----------------:|:----------------:|
 * | `h0-single-agent`      |           |                  |            |                  |                  |
 * | `h1-subagents`         |     ✓     |                  |            |                  |                  |
 * | `h2-dynamic-scheduler` |     ✓     |        ✓         |            |                  |                  |
 * | `h3-blackboard`        |     ✓     |        ✓         |     ✓      |                  |                  |
 * | `h4-context-freshness` |     ✓     |        ✓         |     ✓      |        ✓         |                  |
 * | `h5-oracle-governance` |     ✓     |        ✓         |     ✓      |        ✓         |        ✓         |
 * | `h6-full`              |     ✓     |        ✓         |     ✓      |        ✓         |        ✓         |
 *
 * (h5 and h6 differ only in name: H6 is the full product, H5 the last ablation step — kept apart so a later feature
 * lands between them without renaming.) The scripted role policies are written for the full harness: under an ablated
 * harness they show what BREAKS without the subsystem (e.g. no RCA/regression without the blackboard); a causal
 * measurement of model behaviour needs live models (the live arms).
 */
export const CAUSAL_ARM_FEATURES: Readonly<Record<string, Required<HarnessFeatures>>> = Object.freeze({
  'h0-single-agent': { subagents: false, dynamicScheduler: false, blackboard: false, contextFreshness: false, oracleGovernance: false },
  'h1-subagents': { subagents: true, dynamicScheduler: false, blackboard: false, contextFreshness: false, oracleGovernance: false },
  'h2-dynamic-scheduler': { subagents: true, dynamicScheduler: true, blackboard: false, contextFreshness: false, oracleGovernance: false },
  'h3-blackboard': { subagents: true, dynamicScheduler: true, blackboard: true, contextFreshness: false, oracleGovernance: false },
  'h4-context-freshness': { subagents: true, dynamicScheduler: true, blackboard: true, contextFreshness: true, oracleGovernance: false },
  'h5-oracle-governance': { subagents: true, dynamicScheduler: true, blackboard: true, contextFreshness: true, oracleGovernance: true },
  'h6-full': { subagents: true, dynamicScheduler: true, blackboard: true, contextFreshness: true, oracleGovernance: true },
});

/** One causal arm (see CAUSAL_ARM_FEATURES). */
export function causalArm(armId: string): EvalArm {
  const features = Object.hasOwn(CAUSAL_ARM_FEATURES, armId) ? CAUSAL_ARM_FEATURES[armId] : undefined;
  if (!features) throw new HypertestError('invalid_argument', `unknown causal arm ${JSON.stringify(armId)} (${Object.keys(CAUSAL_ARM_FEATURES).join(', ')})`);
  const off = Object.entries(features).filter(([, on]) => !on).map(([k]) => k);
  return {
    armId,
    family: 'causal',
    description: `causal arm at the fixed scripted multi-LLM model: harness ${off.length === 0 ? 'complete' : `without ${off.join(', ')}`}`,
    config: (base) => ({ ...scriptedConfig(base, 'multi'), harness: { features: { ...features } } }),
    brains: (task, fixture) => pocBrains(brainArgsFor(task, fixture, 'multi')),
    child: { brainsModule: POC_BRAINS_MODULE, brainsExport: 'pocChildBrains', args: (task, fixture) => brainArgsFor(task, fixture, 'multi') as unknown as JsonValue },
  };
}

export const CAUSAL_ARMS: readonly EvalArm[] = Object.freeze(Object.keys(CAUSAL_ARM_FEATURES).map(causalArm));

// ------------------------------------------------------------------------------------------------ product arms (F[8])

/** Agent engines a product arm can run Hypertest's roles on (packages/runtime native, runtime-pi, runtime-dsh). */
export const PRODUCT_ENGINES = Object.freeze(['pi', 'dsh'] as const);

/**
 * (F[8]) A product/frontier arm through an agent engine that exists in this repository: the same scripted model and
 * harness, the agents run on the Pi or the DSH engine instead of the native one (the engine is part of the runtime
 * manifest, so the trials carry another manifest). External agents (Claude Code, Codex, OpenHands) are arms of their own
 * (externalAgentArm: invoked as a command).
 */
export function productEngineArm(engine: (typeof PRODUCT_ENGINES)[number]): EvalArm {
  if (!(PRODUCT_ENGINES as readonly string[]).includes(engine)) throw new HypertestError('invalid_argument', `unknown product engine ${JSON.stringify(engine)} (${PRODUCT_ENGINES.join(', ')})`);
  return {
    armId: `engine-${engine}`,
    family: 'product',
    description: `the scripted multi-LLM model on the ${engine} agent engine`,
    config: (base) => ({ ...scriptedConfig(base, 'multi'), engines: { default: engine } }),
    brains: (task, fixture) => pocBrains(brainArgsFor(task, fixture, 'multi')),
    child: { brainsModule: POC_BRAINS_MODULE, brainsExport: 'pocChildBrains', args: (task, fixture) => brainArgsFor(task, fixture, 'multi') as unknown as JsonValue },
  };
}

export const PRODUCT_ARMS: readonly EvalArm[] = Object.freeze(PRODUCT_ENGINES.map(productEngineArm));

// ------------------------------------------------------------------------------------------------ three provider classes (item 6)

/** The provider class of each provider of the multi-LLM routes in the three-provider-class arm. */
export const THREE_CLASS_PROVIDERS: Readonly<Record<string, WireClass>> = Object.freeze({ 'reason-a': 'anthropic', 'fast-b': 'openai-compatible', 'judge-c': 'pi-ai' });
/** The (fake) API key variable of the anthropic class in the wire arm (the transport never checks it). */
export const WIRE_KEY_ENV = 'HT_EVAL_WIRE_FAKE_KEY';

/**
 * (item 6, row 299 build) The SAME goal through three provider CLASSES: the multi-LLM routes, with reason-a served by the
 * Anthropic adapter, fast-b by the OpenAI-compatible adapter and judge-c by the pi-ai adapter (openai-completions over a
 * base URL). A task's scripted provider outage (e.g. PoC C: reason-a fails the metrics analyst's first call) makes the
 * router fall back across classes mid-run (a new ModelEpoch on another class). The adapters talk real HTTP wire formats
 * to the scripted wire transport (no request leaves the process); every exchange is logged (probe `wireCalls`) and
 * graded against L0 (`providerClassesAudited`). In-process trials. The live acceptance swaps the transport for the
 * real providers (validation phase).
 */
export function threeProviderClassArm(): EvalArm {
  const endpoints: WireEndpoint[] = Object.entries(THREE_CLASS_PROVIDERS).map(([provider, wireClass]) => ({ provider, wireClass }));
  return {
    armId: 'three-provider-classes',
    family: 'model',
    description: 'multi-LLM routes over three provider classes (anthropic, openai-compatible, pi-ai) through the scripted wire transport',
    config: (base) => ({
      ...base,
      models: {
        providers: [
          { id: 'reason-a', kind: 'anthropic', baseUrl: `http://${wireHost('reason-a')}`, apiKeyEnv: WIRE_KEY_ENV, timeoutMs: 60_000 },
          { id: 'fast-b', kind: 'openai-compatible', baseUrl: `http://${wireHost('fast-b')}/v1`, timeoutMs: 60_000 },
          { id: 'judge-c', kind: 'pi-ai', piProvider: 'wire', baseUrl: `http://${wireHost('judge-c')}/v1`, timeoutMs: 60_000 },
        ],
        routes: MULTI_ROUTES.map((r) => JSON.parse(JSON.stringify(r)) as RouteConfig),
      },
    }),
    overrides: (task, fixture) => {
      const log: WireCall[] = [];
      const brains = pocBrains(brainArgsFor(task, fixture, 'multi'));
      return {
        fetch: scriptedWireFetch(brains, endpoints, log),
        env: { ...process.env, [WIRE_KEY_ENV]: 'wire-fake-key' },
        probes: { [WIRE_CALLS_PROBE]: async () => JSON.parse(JSON.stringify(log)) as JsonValue },
      };
    },
  };
}

/** Probe name of the wire transport's log. */
export const WIRE_CALLS_PROBE = 'wireCalls';

/**
 * The arms the CLI offers (`hypertest eval run <suite> --arms …`): the scripted arms, the causal arms H0…H6, the product
 * engine arms, the three-provider-class arm, plus `live` when available.
 */
export function builtinArms(env: Record<string, string | undefined> = process.env): EvalArm[] {
  const arms = [...POC_ARMS, ...CAUSAL_ARMS, ...PRODUCT_ARMS, threeProviderClassArm()];
  return liveArmAvailable(env).ok ? [...arms, liveArm(env)] : arms;
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
