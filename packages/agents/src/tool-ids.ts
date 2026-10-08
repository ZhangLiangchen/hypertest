/**
 * Tool ids an agent role may reference in its allowlist. Built-in tools are implemented by
 * @hypertest/tools, domain tools by @hypertest/control. Role allowlists are validated against this list
 * so that a typo (which would silently grant or deny nothing) is rejected when the catalog is built.
 */

export const BUILTIN_TOOL_IDS = Object.freeze([
  'fs.read',
  'fs.list',
  'fs.search',
  'fs.write',
  'fs.apply_patch',
  'git.status',
  'git.diff',
  'git.log',
  'git.show',
  'git.blame',
  'git.commit',
  'shell.exec',
  'test.run',
  'coverage.collect',
  'mutation.run',
  'code.symbols',
  'code.references',
  'http.request',
  'metrics.query',
  'metrics.scrape',
  'load.start',
  'load.observe',
  'load.stop',
  'env.restart',
  'env.inject_fault',
  'env.deploy',
  'browser.navigate',
  'browser.click',
  'browser.fill',
  'browser.screenshot',
  'browser.text',
] as const);

export const DOMAIN_TOOL_IDS = Object.freeze([
  'blackboard.read',
  'blackboard.post_finding',
  'blackboard.post_hypothesis',
  'blackboard.report_coverage_gap',
  'blackboard.post_risk',
  'blackboard.post_review',
  'blackboard.post_note',
  'plan.propose_revision',
  'plan.read',
  'work.propose',
  'system_model.record',
  'oracle.get',
  'oracle.list',
  'oracle.propose_change',
  'experiment.define',
  'experiment.stop',
  'test_artifact.register',
  'test_artifact.validate',
  'evidence.get',
  'evidence.query',
  'evidence.claim',
  'delegate',
  'delegate.status',
  'delegate.collect',
  'delegate.message',
  'delegate.release',
  'request_approval',
  'complete_work',
  'fail_work',
] as const);

export type BuiltinToolId = (typeof BUILTIN_TOOL_IDS)[number];
export type DomainToolId = (typeof DOMAIN_TOOL_IDS)[number];
export type KnownToolId = BuiltinToolId | DomainToolId;

export const KNOWN_TOOL_IDS: readonly KnownToolId[] = Object.freeze([...BUILTIN_TOOL_IDS, ...DOMAIN_TOOL_IDS]);

/** The two tools that end a work item: structured completion or explicit failure. Every role has both. */
export const TERMINAL_TOOLS = Object.freeze(['complete_work', 'fail_work'] as const);

/**
 * Built-in tools that modify the workspace (tools contract: write_workspace effect, isolated worktree
 * only). A role that holds any of them must use the `isolated_worktree` workspace.
 */
export const WORKSPACE_WRITE_TOOL_IDS = Object.freeze(['fs.write', 'fs.apply_patch', 'git.commit'] as const satisfies readonly BuiltinToolId[]);

/** Namespaces whose tools are discovered at runtime (MCP bridge); patterns inside them are accepted. */
export const DYNAMIC_TOOL_NAMESPACES = Object.freeze(['mcp.'] as const);

/**
 * Tool pattern semantics — identical to @hypertest/policy `matchesToolPattern` (which this package may
 * not import): `*` matches every tool; a pattern ending in `*` is a prefix glob (`git.*` matches
 * `git.diff`); anything else is an exact id.
 */
export function matchesToolPattern(pattern: string, toolId: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return toolId.startsWith(pattern.slice(0, -1));
  return pattern === toolId;
}

/**
 * True when `pattern` is an acceptable entry of a role allow/deny list: not the bare `*`, globs are
 * namespaced (`ns.*`, `ns.prefix*`), and the pattern names at least one known (or extra) tool, or lies
 * inside a dynamic namespace.
 */
export function isKnownToolPattern(pattern: string, extraToolIds: readonly string[] = []): boolean {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern === '*') return false;
  const star = pattern.indexOf('*');
  if (star !== -1) {
    if (star !== pattern.length - 1) return false;
    if (!pattern.slice(0, -1).includes('.')) return false;
  }
  if (DYNAMIC_TOOL_NAMESPACES.some((ns) => pattern.startsWith(ns) && pattern.length > ns.length)) return true;
  return KNOWN_TOOL_IDS.some((id) => matchesToolPattern(pattern, id)) || extraToolIds.some((id) => matchesToolPattern(pattern, id));
}

/** True when some allow pattern matches `toolId` and no deny pattern does. */
export function toolPermitted(policy: { allow: readonly string[]; deny?: readonly string[] | undefined }, toolId: string): boolean {
  return policy.allow.some((p) => matchesToolPattern(p, toolId)) && !(policy.deny ?? []).some((p) => matchesToolPattern(p, toolId));
}
