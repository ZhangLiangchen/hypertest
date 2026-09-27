/**
 * The PoC scripted brains: `pocBrains(args)` returns provider id → brain for the arm, with the role policies of the
 * task (selected by `args.taskId`). `pocChildBrains` is the child-process brains export (ChildArmSpec.brainsExport):
 * the resumed child rebuilds exactly the same brains from the same JSON arguments.
 */
import { HypertestError } from '@hypertest/core';
import type { ScriptedBrain } from '@hypertest/model';
import type { ChildBrainContext } from '../contracts.ts';
import { armBrains, assertBrainArgs, type BrainView, type PocBrainArgs, type RoleBrain } from './kit.ts';
import { POC_A_ROLES } from './poc-a.ts';
import { POC_B_ROLES } from './poc-b.ts';
import { pocCOutage, pocCRoles, pocCTag } from './poc-c.ts';
import { ROBUSTNESS_ROLES } from './robustness.ts';
import { MODEL_SWITCH_ROLES, SECURITY_ROLES, freshnessRoles, freshnessTag, generationRoles, modelSwitchOutage, securityTag } from './core.ts';

/** The role policies and provider outages of a task (by task id prefix). */
function policiesFor(args: PocBrainArgs): { roles: Record<string, RoleBrain>; outages?: Record<string, (v: BrainView) => boolean>; tag?: (v: BrainView) => string | undefined } {
  // (additive) the core suites
  if (args.taskId.startsWith('context-freshness')) return { roles: freshnessRoles(args), tag: freshnessTag };
  if (args.taskId.startsWith('model-switch')) {
    // the outage hits the executor's PRIMARY provider (fast-b on the multi arm, the only provider on the single arm)
    const primary = args.arm === 'multi' ? 'fast-b' : 'solo';
    return args.variant === 'outage' ? { roles: MODEL_SWITCH_ROLES, outages: { [primary]: modelSwitchOutage } } : { roles: MODEL_SWITCH_ROLES };
  }
  if (args.taskId.startsWith('security-injection')) return { roles: SECURITY_ROLES, tag: securityTag };
  if (args.taskId.startsWith('test-generation')) return { roles: generationRoles(args.variant) };
  if (args.taskId.startsWith('poc-a')) return { roles: POC_A_ROLES };
  if (args.taskId.startsWith('poc-b')) return { roles: POC_B_ROLES };
  if (args.taskId.startsWith('poc-c')) {
    const variant = args.variant ?? (args.taskId.endsWith('insufficient') ? 'insufficient' : undefined);
    // the scripted outage exists only where a fallback route exists (the multi arm's reason-a)
    return { roles: pocCRoles(variant), outages: { 'reason-a': pocCOutage }, tag: pocCTag };
  }
  if (args.taskId.startsWith('recovery-chaos')) return { roles: pocCRoles(undefined), tag: pocCTag };
  if (args.taskId.startsWith('oracle-robustness')) return { roles: ROBUSTNESS_ROLES };
  throw new HypertestError('invalid_argument', `no PoC brains for task ${args.taskId}`);
}

/** Provider id → brain for a PoC task under an arm. */
export function pocBrains(args: PocBrainArgs): Record<string, ScriptedBrain> {
  assertBrainArgs(args);
  const p = policiesFor(args);
  return armBrains(args, p.roles, p.outages ?? {}, p.tag);
}

/** Child-process brains export: `ctx.args` are the PocBrainArgs computed by the arm in the parent. */
export function pocChildBrains(ctx: ChildBrainContext): Record<string, ScriptedBrain> {
  return pocBrains(ctx.args as unknown as PocBrainArgs);
}

export * from './kit.ts';
export * from './poc-a.ts';
export * from './poc-b.ts';
export * from './poc-c.ts';
export * from './robustness.ts';
export * from './core.ts';
