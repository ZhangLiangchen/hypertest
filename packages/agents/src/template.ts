import type { JsonSchema } from '@hypertest/core';
import type { WorkBudget } from '@hypertest/domain';
import type { RenderedSubscriptionWork, RoleDefinition, RolePromptVars, RoleSubscription } from './contracts.ts';

/** Placeholders a role system prompt may use. */
export const PROMPT_TEMPLATE_VARS = Object.freeze(['role', 'objective', 'protocol', 'runGoal'] as const);

/** Placeholders a subscription work template may use (filled by the reactor from the event/record). */
export const SUBSCRIPTION_TEMPLATE_VARS = Object.freeze(['title', 'severity', 'recordId', 'lineageId', 'summary', 'component'] as const);

/** `{{ name }}`: names are letters, digits, `_`, `.`, `-`; surrounding whitespace is trimmed. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Single-pass `{{name}}` substitution. Unknown names render as ''. Values are inserted literally: they are
 * never re-expanded (a value containing `{{x}}` stays as is), `$` patterns are not interpreted, and only
 * own properties of `vars` are consulted (no prototype lookups, no code execution). Text that is not a
 * well-formed placeholder (e.g. `{{a b}}`) is left untouched.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match: string, name: string) => {
    if (!Object.hasOwn(vars, name)) return '';
    const value: unknown = vars[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Brace groups that look like placeholders but are not well formed (e.g. `{{run goal}}`, `{{}}`): they
 * would survive rendering verbatim, so a typo would silently drop the value. Package-internal.
 */
export function malformedPlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{\{[^{}]*\}\}/g)) {
    if (!/^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}$/.test(m[0]) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Distinct placeholder names used in a template, in first-occurrence order. */
export function templateVariables(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export const NO_PROTOCOL_NOTICE =
  'No protocol context was injected for this work item. Apply the universal discipline in this prompt as the governing protocol and do not assume any project-specific rules.';
export const NO_OBJECTIVE_NOTICE =
  'No objective was provided for this work item. Do not improvise a task: call `fail_work` with reason "missing objective".';
export const NO_RUN_GOAL_NOTICE = 'No run goal was provided.';

function nonBlank(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/**
 * Renders a role's system prompt. `{{role}}` is the role id; blank objective / run goal / protocol are
 * replaced by explicit notices so the model never sees an empty governing section.
 */
export function renderRolePrompt(role: Pick<RoleDefinition, 'role' | 'systemPrompt'>, vars: RolePromptVars): string {
  return renderTemplate(role.systemPrompt, {
    role: role.role,
    objective: nonBlank(vars.objective, NO_OBJECTIVE_NOTICE),
    runGoal: nonBlank(vars.runGoal, NO_RUN_GOAL_NOTICE),
    protocol: nonBlank(vars.protocol, NO_PROTOCOL_NOTICE),
  });
}

const TITLE_MAX = 200;
const OBJECTIVE_MAX = 4000;
const VAR_LIMITS: Record<string, number> = { title: 300, summary: 2000 };
const DEFAULT_VAR_LIMIT = 200;
/** Event values are never shrunk below this when making room for the template's own text. */
const MIN_VAR_LENGTH = 24;
const MISSING_VALUE = '(not provided)';
const ELLIPSIS = '…';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Truncates to at most `max` UTF-16 code units (hence also at most `max` code points), never splitting a
 * surrogate pair, appending an ellipsis when truncated.
 */
function truncateUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  let end = max - ELLIPSIS.length;
  if (end > 0 && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(0, Math.max(0, end)) + ELLIPSIS;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Breaks every run of two or more braces (`{{` → `{ {`, `{{{` → `{ { {`), so no `{{name}}` placeholder can
 * exist in the text, whatever is concatenated around it.
 */
function neutralizeBraces(s: string): string {
  return s.replace(/\{(?=\{)/g, '{ ').replace(/\}(?=\})/g, '} ');
}

/** Event payload text is data: neutralize template braces and bound its length. */
function sanitizeValue(name: string, value: unknown): string {
  if (value === undefined || value === null) return MISSING_VALUE;
  let s = neutralizeBraces(String(value));
  if (name !== 'summary') s = collapseWhitespace(s);
  else s = s.trim();
  if (s.length === 0) return MISSING_VALUE;
  return truncateUnits(s, VAR_LIMITS[name] ?? DEFAULT_VAR_LIMIT);
}

function placeholderCounts(template: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of template.matchAll(PLACEHOLDER)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return counts;
}

/**
 * Renders `template` with `values` and post-processes it into at most `max` UTF-16 units. When the result
 * is too long, the event values are shrunk first (largest contribution first, never below
 * MIN_VAR_LENGTH), so the template's own text — typically the instructions after the data — survives; only
 * a template that cannot fit even then is cut. The output never contains a live placeholder.
 */
function renderBounded(template: string, values: Record<string, string>, max: number, post: (s: string) => string): string {
  const vars = { ...values };
  const counts = [...placeholderCounts(template)].filter(([name]) => Object.hasOwn(vars, name));
  const render = (): string => post(neutralizeBraces(renderTemplate(template, vars)));
  let out = render();
  for (let round = 0; out.length > max && round < 4 * counts.length + 4; round++) {
    let best: [string, number] | undefined;
    let bestContribution = 0;
    for (const [name, occurrences] of counts) {
      const len = vars[name]!.length;
      if (len > MIN_VAR_LENGTH && len * occurrences > bestContribution) {
        best = [name, occurrences];
        bestContribution = len * occurrences;
      }
    }
    if (best === undefined) break;
    const [name, occurrences] = best;
    const overflow = out.length - max;
    vars[name] = truncateUnits(vars[name]!, Math.max(MIN_VAR_LENGTH, vars[name]!.length - Math.ceil(overflow / occurrences)));
    out = render();
  }
  return truncateUnits(out, max);
}

/**
 * Renders the work a subscription creates for a matched event. Variable values are sanitized (template
 * braces neutralized, whitespace collapsed except in `summary`, bounded length); missing known variables
 * render as "(not provided)". The title is single-line and ≤ 200 UTF-16 code units, the objective ≤ 4000;
 * values are shrunk before the template text is cut, and neither contains a live `{{placeholder}}`.
 */
export function renderSubscriptionWork(sub: Pick<RoleSubscription, 'work'>, vars: Record<string, string>): RenderedSubscriptionWork {
  const safe: Record<string, string> = {};
  for (const name of SUBSCRIPTION_TEMPLATE_VARS) safe[name] = sanitizeValue(name, Object.hasOwn(vars, name) ? vars[name] : undefined);
  for (const [name, value] of Object.entries(vars)) {
    if (!Object.hasOwn(safe, name)) safe[name] = sanitizeValue(name, value);
  }
  const out: RenderedSubscriptionWork = {
    title: renderBounded(sub.work.title, safe, TITLE_MAX, collapseWhitespace),
    objective: renderBounded(sub.work.objective, safe, OBJECTIVE_MAX, (s) => s.trim()),
    priority: sub.work.priority,
  };
  if (sub.work.budget !== undefined) out.budget = { ...sub.work.budget } as Partial<WorkBudget>;
  if (sub.work.expectedOutput !== undefined) out.expectedOutput = sub.work.expectedOutput as JsonSchema;
  return out;
}
