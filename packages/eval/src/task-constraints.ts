/**
 * (row 310, coverage[16]) What an EvalTask and the eval track impose on a trial's configuration — enforced by the trial's
 * own Hypertest (its policy engine, its isolation), not by the brains:
 *
 * - `allowedTools`: every built-in task tool (and every MCP / plugin tool) the list does not cover is DENIED to every
 *   role by a policy rule (the agent protocol — plan, blackboard, evidence, complete/fail — stays: it is how a run
 *   reaches its gate at all);
 * - `safetyConstraints`: `forbid_tool` ⇒ deny that tool; `max_action_risk` ⇒ deny every call above the risk;
 *   `no_writes` ⇒ deny every external and destructive effect;
 * - the COLD track (default) refuses a memory backend outside the trial directory (a shared PowerContext / memory
 *   service would carry experience across trials — benchmark contamination); the LEARNING track admits it and seeds only
 *   approved experience (seedExperience).
 */
import { HypertestError } from '@hypertest/core';
import type { HypertestConfig, HypertestInstance } from '@hypertest/app';
import { BUILTIN_TOOL_IDS } from '@hypertest/agents';
import type { PolicyRule } from '@hypertest/policy';
import type { EvalTask, EvalTrack, ExperienceSeed, SafetyConstraint } from './contracts.ts';

/** Tool namespaces outside the built-in catalog a trial may meet (MCP servers, kernel plugins). */
const EXTRA_TOOL_PATTERNS: readonly string[] = Object.freeze(['mcp.*', 'plugin.*']);

/** True when `pattern` (`id`, `prefix.*` or `*`) covers `toolId`. */
export function toolPatternCovers(pattern: string, toolId: string): boolean {
  if (pattern === '*' || pattern === toolId) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keeps the dot
    return toolId.startsWith(prefix) || (toolId.endsWith('.*') && toolId.slice(0, -1).startsWith(prefix));
  }
  return false;
}

/** Problems of a task's tool and safety fields (empty = valid). */
export function taskConstraintProblems(task: Pick<EvalTask, 'taskId' | 'allowedTools' | 'safetyConstraints'>): string[] {
  const out: string[] = [];
  const at = `task ${task.taskId}`;
  if (task.allowedTools !== undefined) {
    if (!Array.isArray(task.allowedTools) || task.allowedTools.some((t) => typeof t !== 'string' || !/^(\*|[a-z][a-z0-9_]*(\.[a-z0-9_*]+)*(\.\*)?)$/.test(t))) {
      out.push(`${at}: allowedTools must be tool ids or prefix.* patterns`);
    }
  }
  for (const [i, c] of (task.safetyConstraints ?? []).entries()) {
    const k = (c as { kind?: unknown })?.kind;
    if (k === 'forbid_tool') {
      if (typeof (c as { tool?: unknown }).tool !== 'string' || (c as { tool: string }).tool.trim() === '') out.push(`${at}: safetyConstraints[${i}].tool must be a tool id or pattern`);
    } else if (k === 'max_action_risk') {
      if (!['low', 'medium', 'high'].includes(String((c as { risk?: unknown }).risk))) out.push(`${at}: safetyConstraints[${i}].risk must be low, medium or high`);
    } else if (k !== 'no_writes') out.push(`${at}: safetyConstraints[${i}].kind must be forbid_tool, max_action_risk or no_writes`);
  }
  return out;
}

const NEXT_RISK: Readonly<Record<'low' | 'medium' | 'high', 'medium' | 'high' | 'critical'>> = Object.freeze({ low: 'medium', medium: 'high', high: 'critical' });

/** The policy deny rules a task's allowedTools and safetyConstraints become (empty when it declares neither). */
export function taskPolicyRules(task: Pick<EvalTask, 'taskId' | 'allowedTools' | 'safetyConstraints'>): PolicyRule[] {
  const problems = taskConstraintProblems(task);
  if (problems.length > 0) throw new HypertestError('invalid_argument', problems.join('; '));
  const rules: PolicyRule[] = [];
  if (task.allowedTools !== undefined) {
    const allowed = task.allowedTools;
    const denied = [...BUILTIN_TOOL_IDS, ...EXTRA_TOOL_PATTERNS].filter((t) => !allowed.some((p) => toolPatternCovers(p, t)));
    if (denied.length > 0) rules.push({ id: 'eval.allowed-tools', description: `eval task ${task.taskId}: only ${allowed.join(', ') || 'no task tool'} may be used`, match: { tools: denied }, decision: 'deny' });
  }
  for (const [i, c] of (task.safetyConstraints ?? []).entries()) {
    const id = `eval.safety.${i + 1}`;
    if (c.kind === 'forbid_tool') rules.push({ id, description: `eval task ${task.taskId}: ${c.tool} is forbidden`, match: { tools: [c.tool] }, decision: 'deny' });
    else if (c.kind === 'max_action_risk') rules.push({ id, description: `eval task ${task.taskId}: no action above ${c.risk} risk`, match: { minRisk: NEXT_RISK[c.risk] }, decision: 'deny' });
    else rules.push({ id, description: `eval task ${task.taskId}: no external or destructive effect`, match: { effects: ['external', 'destructive'] }, decision: 'deny' });
  }
  return rules;
}

/** The trial configuration with the task's rules appended to its policy (the arm's own rules stay). */
export function withTaskConstraints(config: HypertestConfig, task: Pick<EvalTask, 'taskId' | 'allowedTools' | 'safetyConstraints'>): HypertestConfig {
  const rules = taskPolicyRules(task);
  if (rules.length === 0) return config;
  return { ...config, policy: { ...(config.policy ?? {}), rules: [...(config.policy?.rules ?? []), ...rules] } };
}

/**
 * (coverage[16]) Track problems of a trial configuration: on the COLD track every long-term memory must live inside the
 * trial directory (the default `sql` memory is in the trial's own store; a `service` memory must keep its data there);
 * an external PowerContext is refused. The learning track admits it.
 */
export function trackProblems(config: HypertestConfig, track: EvalTrack, inside: (p: string | undefined) => boolean): string[] {
  if (track === 'learning') return [];
  const memory = config.memory as { kind?: string; dataDir?: string; baseUrl?: string } | undefined;
  if (!memory || memory.kind === undefined || memory.kind === 'sql') return [];
  if (memory.kind === 'service') return memory.dataDir === undefined || inside(memory.dataDir) ? [] : [`cold track: memory.dataDir ${memory.dataDir} is outside the trial directory (experience would cross trials)`];
  return [`cold track: memory.kind ${memory.kind} (${memory.baseUrl ?? 'external'}) is shared across trials — benchmark contamination; run it on the learning track (--track learning)`];
}

/** Statuses of experience a learning-track trial may start with. */
const ADMITTED: ReadonlySet<string> = new Set(['approved', 'published']);

/**
 * (coverage[16]) Seeds the learning-track experience into a trial's memory: ONLY approved/published items are admitted
 * (proposed by `eval:experience-source`, then approved — and published when the seed is — by the curator
 * `eval:learning-track`); everything else is refused and counted.
 */
export async function seedExperience(ht: HypertestInstance, seeds: readonly ExperienceSeed[], runId: string): Promise<{ admitted: number; refused: number }> {
  let admitted = 0;
  let refused = 0;
  const memory = ht.services.memory;
  for (const s of seeds) {
    if (!ADMITTED.has(s.status)) {
      refused++;
      continue;
    }
    const ctx = { runId, correlationId: `eval-learning:${runId}`, actorId: 'eval:learning-track' };
    // the experience comes from an earlier source (its author); the learning track's curator admits it — never self-review
    const item = await memory.propose({ kind: s.kind as never, content: s.content, scope: { ...(s.scope ?? {}) }, sourceRunId: `eval-experience:${runId}`, evidenceRefs: [], createdBy: 'eval:experience-source' }, ctx);
    await memory.review(item.experienceId, 'approve', 'eval:learning-track', ctx);
    if (s.status === 'published') await memory.review(item.experienceId, 'publish', 'eval:learning-track', ctx);
    admitted++;
  }
  return { admitted, refused };
}
