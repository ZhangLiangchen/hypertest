/**
 * (F[8]) Harness feature flags for the controlled causal arms of the eval platform (architecture-improvements §对比实验:
 * H0 single agent, H1 + specialized subagents, H2 + dynamic scheduler, H3 + blackboard/events, H4 + context freshness,
 * H5 + oracle governance, H6 full Hypertest) — at a FIXED model, only the harness varies:
 *
 * | feature            | off means                                                                                      |
 * |--------------------|------------------------------------------------------------------------------------------------|
 * | `subagents`        | the role catalog holds the LEAD only, granted every non-delegation tool (one agent does it all) |
 * | `dynamicScheduler` | one agent turn at a time (`durable.maxConcurrentTurns: 1`): a static sequential pipeline         |
 * | `blackboard`       | no role subscription: nothing reacts to findings, hypotheses, reviews (no event-driven work)    |
 * | `contextFreshness` | the FreshnessGuard passes every action: no stale-snapshot refusal                               |
 * | `oracleGovernance` | runs pin no oracle and the gate does not require one                                           |
 *
 * Switching a subsystem off weakens what Hypertest guarantees, so it is honoured ONLY for an eval trial instance
 * (`HypertestOverrides.evalTrial: true`, set by the eval harness): a deployment configuration that disables a feature is
 * refused at composition. The flags change the role catalog revision (subagents, blackboard), so ablated runtimes carry
 * other manifests; every trial records its features.
 */
import { HypertestError, sha256Hex, canonicalJson, type JsonValue } from '@hypertest/core';
import type { RoleCatalogLike, RoleDefinition, RoleSubscription } from '@hypertest/agents';
import { BUILTIN_TOOL_IDS, DOMAIN_TOOL_IDS } from '@hypertest/agents';
import type { FreshnessGuard } from '@hypertest/context';
import type { HarnessFeatureConfig, HypertestConfig, HypertestOverrides } from './contracts.ts';

/** Every feature on (H6, a deployment). */
export const FULL_HARNESS: Readonly<Required<HarnessFeatureConfig>> = Object.freeze({ subagents: true, dynamicScheduler: true, blackboard: true, contextFreshness: true, oracleGovernance: true });
export const HARNESS_FEATURE_KEYS = Object.freeze(Object.keys(FULL_HARNESS) as Array<keyof HarnessFeatureConfig>);

/** The effective features of a configuration (unset ⇒ on). */
export function harnessFeatures(config: Pick<HypertestConfig, 'harness'>): Required<HarnessFeatureConfig> {
  return { ...FULL_HARNESS, ...(config.harness?.features ?? {}) };
}

/** The features a configuration switches off (empty for a deployment). */
export function disabledFeatures(config: Pick<HypertestConfig, 'harness'>): string[] {
  const f = harnessFeatures(config);
  return HARNESS_FEATURE_KEYS.filter((k) => f[k] === false);
}

/**
 * The configuration an ablated eval trial composes: refused outside an eval trial instance; `dynamicScheduler: false`
 * serializes turns, `oracleGovernance: false` drops configured oracles and the gate's oracle requirement.
 */
export function applyHarnessFeatures(config: HypertestConfig, overrides: Pick<HypertestOverrides, 'evalTrial'>): HypertestConfig {
  const off = disabledFeatures(config);
  if (off.length === 0) return config;
  if (overrides.evalTrial !== true) {
    throw new HypertestError('invalid_argument', `harness.features switches off ${off.join(', ')}: an ablated harness is an eval arm only (it removes guarantees a deployment must keep)`, { details: { features: off } });
  }
  const f = harnessFeatures(config);
  let out = config;
  if (!f.dynamicScheduler) {
    if (out.durable.kind !== 'local') throw new HypertestError('invalid_argument', 'harness.features.dynamicScheduler: false needs the local durable runtime (one turn at a time)');
    out = { ...out, durable: { ...out.durable, maxConcurrentTurns: 1 } };
  }
  if (!f.oracleGovernance) {
    const { oracles: _dropped, ...rest } = out;
    out = { ...rest, gate: { ...(out.gate ?? {}), requireOracle: false } } as HypertestConfig;
  }
  return out;
}

/** Tools the single agent of H0 may use: every task and protocol tool except delegation. */
const SINGLE_AGENT_TOOLS: readonly string[] = Object.freeze([...BUILTIN_TOOL_IDS, ...DOMAIN_TOOL_IDS.filter((t) => !t.startsWith('delegate'))]);

/**
 * The role catalog of an ablated harness: `subagents: false` ⇒ the lead only, with every non-delegation tool, a test
 * executor's permissions and its own worktree; `blackboard: false` ⇒ no role subscribes to anything. The revision covers
 * the features (an ablated catalog is another catalog).
 */
export function harnessRoleCatalog(inner: RoleCatalogLike, config: Pick<HypertestConfig, 'harness'>): RoleCatalogLike {
  const f = harnessFeatures(config);
  if (f.subagents && f.blackboard) return inner;
  const adjust = (r: RoleDefinition): RoleDefinition => {
    let out = r;
    if (!f.subagents && r.role === 'lead') {
      out = {
        ...out,
        toolPolicy: { ...out.toolPolicy, allow: [...SINGLE_AGENT_TOOLS] },
        permissionProfile: 'test_executor',
        workspace: 'isolated_worktree',
        canDelegateTo: [],
        maxDepth: 0,
      };
    }
    if (!f.blackboard) out = { ...out, subscriptions: [] };
    return out;
  };
  const visible = (role: string): boolean => f.subagents || role === 'lead';
  const revision = `${inner.revision()}+harness:${sha256Hex(canonicalJson(f as unknown as JsonValue)).slice(0, 16)}`;
  return {
    get: (role) => {
      const r = visible(role) ? inner.get(role) : undefined;
      return r ? adjust(r) : undefined;
    },
    require: (role) => {
      if (!visible(role)) throw new HypertestError('not_found', `role ${role} is not part of this harness (harness.features.subagents: false — the lead works alone)`);
      return adjust(inner.require(role));
    },
    list: () => inner.list().filter((r) => visible(r.role)).map(adjust),
    subscriptions: () => (f.blackboard ? inner.subscriptions().filter((s) => visible(s.role)) : ([] as Array<RoleSubscription & { role: RoleDefinition['role'] }>)),
    revision: () => revision,
  };
}

/** The FreshnessGuard of an ablated harness: `contextFreshness: false` ⇒ every action passes (nothing is checked). */
export function harnessFreshness(inner: FreshnessGuard, config: Pick<HypertestConfig, 'harness'>): FreshnessGuard {
  if (harnessFeatures(config).contextFreshness) return inner;
  return {
    resolvers: inner.resolvers,
    validate: async () => ({ fresh: true, checked: 0 }),
  };
}
