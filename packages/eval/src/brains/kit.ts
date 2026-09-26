/**
 * Building blocks of the PoC scripted brains. A brain is a deterministic policy per role: it reads the machine header
 * of the first system message (`[hypertest role=… work_item=… kind=… run=…]`) and the conversation so far (tool results,
 * user messages) and returns the next action — never hidden state: the same request always gets the same reply, so a
 * durable replay or a resumed child process behaves exactly like the first attempt.
 *
 * Every call is optionally recorded in an observation log (what the "model" received: sizes, message counts, whether
 * the lead's private trace leaked into another agent's context), which the PoC probes and graders read.
 */
import { appendFileSync } from 'node:fs';
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { ModelCallRequest, ScriptedBrain, ScriptedReply } from '@hypertest/model';
import { toolCall, viewOf, type BrainView, type RoleBrain } from '../brains.ts';
import type { BrainObservation } from '../fixtures.ts';

/** Which scripted arm the brains serve (provider ids differ; the policies are the same). */
export type ArmKind = 'multi' | 'single';

/** Arguments of the PoC brains factory (JSON: they travel to trial child processes). */
export interface PocBrainArgs {
  taskId: string;
  arm: ArmKind;
  /** JSON-lines observation log (what the model saw); omitted ⇒ nothing is recorded. */
  observationsFile?: string;
  /** Task variant (e.g. `insufficient`: the metrics analyst never records latency evidence). */
  variant?: string;
}

/** Provider ids of the scripted arms. multi: reason-a (lead/analysts), fast-b (executor, test designer, RCA, environment), judge-c (reviewer). */
export const MULTI_PROVIDERS = Object.freeze(['reason-a', 'fast-b', 'judge-c'] as const);
export const SINGLE_PROVIDERS = Object.freeze(['solo'] as const);

export function providersOf(arm: ArmKind): readonly string[] {
  return arm === 'multi' ? MULTI_PROVIDERS : SINGLE_PROVIDERS;
}

/**
 * A marker only the lead's private reasoning contains (its assistant text, never its plan): any other agent whose
 * request contains it inherited the lead's trace (a context-isolation breach).
 */
export const LEAD_TRACE_MARKER = 'LEAD-PRIVATE-REASONING-7f3a';

/** A reply with the lead's private reasoning (text) and one tool call. */
export function leadReply(thought: string, name: string, args: JsonValue): ScriptedReply {
  return { text: `${LEAD_TRACE_MARKER}: ${thought}`, ...toolCall(name, args) };
}

/** The JSON object of a domain tool result (`"<text>\n{json}"` or `{json}`), else {}. */
export function jsonOf(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  const i = content.indexOf('{');
  if (i < 0) return {};
  const body = content.slice(i).split('\n[evidence:')[0]!;
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // a text preamble with braces: try the last line
    const last = content.trim().split('\n').filter((l) => l.trim().startsWith('{')).at(-1);
    if (!last) return {};
    try {
      return JSON.parse(last) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

/** A string field of an object (or undefined). */
export function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

/** The content of the i-th tool result ('' when absent). */
export function resultText(v: BrainView, i: number): string {
  return v.toolResults[i]?.content ?? '';
}

/** Evidence ids (`ev_…`) in a text. */
export function evIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bev_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

/** Record ids (`rec_…`) in a text. */
export function recIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\brec_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

/** Operation ids (`op_…`) in a text. */
export function opIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bop_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

/** The replan ordinal of a lead replan item (`Replan #N (reason: …)`), 0 for the initial plan. */
export function replanOrdinal(v: BrainView): number {
  return Number(/Replan #(\d+)/.exec(v.userText)?.[1] ?? '0');
}

/** The replan reason (`plan_drained`, `gate_feedback`, …) of a lead replan item. */
export function replanReason(v: BrainView): string | undefined {
  return /Replan #\d+ \(reason: ([a-z_]+)\)/.exec(v.userText)?.[1];
}

/** Commits of the lead's initial objective: `commit under test <sha>` and `base commit <sha>`. */
export function targetCommits(v: BrainView): { head?: string; base?: string } {
  const out: { head?: string; base?: string } = {};
  const head = /commit under test ([0-9a-f]{7,64})/.exec(v.userText)?.[1];
  const base = /base commit ([0-9a-f]{7,64})/.exec(v.userText)?.[1];
  if (head) out.head = head;
  if (base) out.base = base;
  return out;
}

/** The input record of a reaction/work item (`### <type> <rec_…> (vN)` + JSON block in the task message). */
export function inputRecord(v: BrainView, recordType: string): { recordId: string; payload: Record<string, unknown>; evidenceRefs: string[] } | undefined {
  const re = new RegExp(`### ${recordType} (rec_[0-9A-Za-z]+) \\(v\\d+\\)\\n`);
  const m = re.exec(v.userText);
  if (!m) return undefined;
  const rest = v.userText.slice(m.index + m[0].length);
  const start = rest.indexOf('{');
  if (start < 0) return undefined;
  // the JSON block ends at the first line that closes the top-level object
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const o = JSON.parse(rest.slice(start, i + 1)) as { payload?: Record<string, unknown>; evidenceRefs?: string[] };
          return { recordId: m[1]!, payload: o.payload ?? {}, evidenceRefs: Array.isArray(o.evidenceRefs) ? o.evidenceRefs : [] };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Bytes of a request as sent to a provider (messages + tool definitions). */
export function requestBytes(request: ModelCallRequest): number {
  return Buffer.byteLength(JSON.stringify(request.messages)) + Buffer.byteLength(JSON.stringify(request.tools ?? []));
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

/** The observation of one model call (what the provider received). */
export function observationOf(provider: string, v: BrainView, tag?: string): BrainObservation {
  const messages = v.request.messages;
  let maxMessageBytes = 0;
  let sawLeadTrace = false;
  for (const m of messages) {
    const text = contentText((m as { content?: unknown }).content);
    maxMessageBytes = Math.max(maxMessageBytes, Buffer.byteLength(text));
    if (text.includes(LEAD_TRACE_MARKER)) sawLeadTrace = true;
  }
  const o: BrainObservation = {
    provider,
    role: v.role,
    workItemId: v.workItemId,
    kind: v.kind,
    step: v.step,
    requestBytes: requestBytes(v.request),
    maxMessageBytes,
    assistantMessages: messages.filter((m) => m.role === 'assistant').length,
    toolMessages: messages.filter((m) => m.role === 'tool').length,
    // the lead's own transcript legitimately contains its reasoning
    sawLeadTrace: v.role !== 'lead' && sawLeadTrace,
    offeredTools: [...new Set((v.request.tools ?? []).map((t) => t.name))].sort(),
  };
  if (tag !== undefined) o.tag = tag;
  return o;
}

/** Appends an observation (never fails the brain: an unwritable log only loses the observation). */
export function recordObservation(file: string | undefined, o: BrainObservation): void {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(o)}\n`);
  } catch {
    // observation logging is best effort
  }
}

export interface ProviderBrainOptions {
  observationsFile?: string;
  /**
   * A deterministic provider outage: when it returns true for a request, the provider answers with a timeout (every
   * attempt of that request: the router exhausts its same-route retries and falls back to another route).
   */
  outage?: (view: BrainView) => boolean;
  /** Tags an observation (e.g. requests after a large tool output). */
  tag?: (view: BrainView) => string | undefined;
}

/**
 * One provider's brain: parses the request, records the observation, applies the provider's outage rule, then asks the
 * role's policy. A role without a policy fails its work item (never hangs).
 */
export function providerBrain(provider: string, roles: Record<string, RoleBrain>, options: ProviderBrainOptions = {}): ScriptedBrain {
  return (request) => {
    const view = viewOf(request);
    recordObservation(options.observationsFile, observationOf(provider, view, options.tag?.(view)));
    if (options.outage?.(view)) return { error: 'timeout', message: `scripted outage of ${provider} for ${view.role} (step ${view.step})` };
    const brain = Object.hasOwn(roles, view.role) ? roles[view.role] : undefined;
    if (!brain) return toolCall('fail_work', { reason: 'agent_failed', message: `no scripted brain for role ${view.role}` });
    return brain(view);
  };
}

/** The brains of every provider of an arm (same role policies; per-provider outage rules). */
export function armBrains(args: PocBrainArgs, roles: Record<string, RoleBrain>, outages: Record<string, (view: BrainView) => boolean> = {}, tag?: (view: BrainView) => string | undefined): Record<string, ScriptedBrain> {
  const out: Record<string, ScriptedBrain> = {};
  for (const provider of providersOf(args.arm)) {
    const options: ProviderBrainOptions = {};
    if (args.observationsFile !== undefined) options.observationsFile = args.observationsFile;
    const outage = Object.hasOwn(outages, provider) ? outages[provider] : undefined;
    if (outage) options.outage = outage;
    if (tag) options.tag = tag;
    out[provider] = providerBrain(provider, roles, options);
  }
  return out;
}

/** Refuses malformed brain arguments (they come from JSON). */
export function assertBrainArgs(args: unknown): asserts args is PocBrainArgs {
  const a = args as Partial<PocBrainArgs> | undefined;
  if (!a || typeof a !== 'object') throw new HypertestError('invalid_argument', 'PoC brains need {taskId, arm}');
  if (typeof a.taskId !== 'string' || a.taskId === '') throw new HypertestError('invalid_argument', 'PoC brains: taskId must be a non-empty string');
  if (a.arm !== 'multi' && a.arm !== 'single') throw new HypertestError('invalid_argument', `PoC brains: arm must be multi or single, got ${String(a.arm)}`);
  if (a.observationsFile !== undefined && typeof a.observationsFile !== 'string') throw new HypertestError('invalid_argument', 'PoC brains: observationsFile must be a path');
}

export { toolCall, type BrainView, type RoleBrain };
