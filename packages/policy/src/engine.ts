import { HypertestError, deepFreeze, hashCanonical, isHypertestError, newId, systemClock, validateJson, type Clock, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { ActorRef, EventContext } from '@hypertest/domain';
import { EFFECT_ORDER, RISK_ORDER } from '@hypertest/domain';
import { capabilityAllows, verifyCapability } from './capabilities.ts';
import type { ActionPermit, ActionRequest, ApprovalGateOptions, ApprovalRequest, PermitConstraints, PolicyEngine, PolicyEngineOptions, PolicyRule } from './contracts.ts';
import { intersectPatterns, matchesResourcePattern, matchesToolPattern } from './patterns.ts';
import { POLICY_PHASES, flaggedActionsOf, requestPhase } from './phases.ts';
import { storable } from './storable.ts';

/** The tool effects (review E[2]: a relayed write names its call's own effect). */
const EFFECT_ORDER_KEYS: ReadonlySet<string> = new Set(Object.keys(EFFECT_ORDER));

type Decision = ActionPermit['decision'];
const DECISION_RANK: Record<Decision, number> = { allow: 0, approval_required: 1, deny: 2 };

/** Most restrictive of two decisions (deny > approval_required > allow). */
export function mostRestrictive(a: Decision, b: Decision): Decision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

const effectEnum = ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'];
const stringList = { type: 'array', items: { type: 'string', minLength: 1 } };

export const PERMIT_CONSTRAINTS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    allowedPaths: stringList,
    allowedHosts: stringList,
    allowedCommands: stringList,
    credentialScope: stringList,
    maxDurationMs: { type: 'integer', minimum: 0 },
  },
};

/** JSON Schema of a PolicyRule (used to validate configured rules; app config reuses it). */
export const POLICY_RULE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description', 'match', 'decision'],
  properties: {
    id: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    match: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: stringList,
        effects: { type: 'array', items: { enum: effectEnum } },
        minRisk: { enum: ['low', 'medium', 'high', 'critical'] },
        roles: stringList,
        environmentClasses: stringList,
        resources: stringList,
        phases: { type: 'array', minItems: 1, items: { enum: [...POLICY_PHASES] } },
        transitions: stringList,
        undeclaredEvidence: { type: 'boolean' },
        flaggedActions: { type: 'boolean' },
        verdicts: { type: 'array', minItems: 1, items: { enum: ['pass', 'fail', 'conditional', 'inconclusive'] } },
      },
    },
    decision: { enum: ['allow', 'deny', 'approval_required'] },
    constraints: PERMIT_CONSTRAINTS_SCHEMA,
  },
};

/**
 * Default rule set (fail closed: anything not allowed here is denied).
 * Rule ids are stable API (they appear in permit reasons and decision logs). The action rules carry no `phases`
 * (before_action only); each other BUGate time point has its own defaults: after_action allows and flags evidence of
 * a type the tool does not declare; before_transition allows and refuses the completion of a work item whose calls were
 * flagged; before_acceptance allows and sends a run with flagged calls to human review (never `pass`).
 */
export const DEFAULT_POLICY_RULES: PolicyRule[] = deepFreeze<PolicyRule[]>([
  { id: 'allow-read-record', description: 'reads and blackboard/evidence records are allowed everywhere', match: { effects: ['read', 'record'] }, decision: 'allow' },
  {
    id: 'allow-workspace-write-execute',
    description: 'workspace writes and sandboxed execution are allowed inside workspace/**',
    match: { effects: ['write_workspace', 'execute'], resources: ['workspace/**'] },
    decision: 'allow',
  },
  { id: 'allow-external-local-sandbox', description: 'reconcilable external effects are allowed on local and sandbox environments', match: { effects: ['external'], environmentClasses: ['local', 'sandbox'] }, decision: 'allow' },
  { id: 'approve-external-staging', description: 'external effects on staging require approval', match: { effects: ['external'], environmentClasses: ['staging'] }, decision: 'approval_required' },
  { id: 'allow-destructive-local-sandbox', description: 'destructive effects are allowed on local and sandbox environments (high risk needs approval on sandbox)', match: { effects: ['destructive'], environmentClasses: ['local', 'sandbox'] }, decision: 'allow' },
  { id: 'approve-destructive-staging', description: 'destructive effects on staging require approval', match: { effects: ['destructive'], environmentClasses: ['staging'] }, decision: 'approval_required' },
  {
    id: 'approve-destructive-high-risk',
    description: 'destructive effects with risk >= high on sandbox or staging require approval',
    match: { effects: ['destructive'], minRisk: 'high', environmentClasses: ['sandbox', 'staging'] },
    decision: 'approval_required',
  },
  { id: 'approve-critical-risk', description: 'critical-risk external or destructive effects always require approval', match: { effects: ['external', 'destructive'], minRisk: 'critical' }, decision: 'approval_required' },
  { id: 'deny-destructive-production', description: 'destructive effects on production are denied', match: { effects: ['destructive'], environmentClasses: ['production'] }, decision: 'deny' },
  {
    id: 'deny-mutation-production',
    description: 'any effect beyond read on production is denied',
    match: { effects: ['record', 'write_workspace', 'execute', 'external', 'destructive'], environmentClasses: ['production'] },
    decision: 'deny',
  },
  {
    id: 'deny-governance-tools',
    description: 'oracle approval and approval decisions are never agent tools (defense in depth)',
    match: { tools: ['oracle.approve*', 'approval.decide*', 'oracle.decide*'] },
    decision: 'deny',
  },
  // after_action: what did the call produce?
  { id: 'allow-after-action', description: 'an executed call whose outcome no rule flags passes the after_action check', match: { phases: ['after_action'] }, decision: 'allow' },
  {
    id: 'flag-undeclared-evidence',
    description: 'a call that produced evidence of a type its tool does not declare is flagged (evidence must come from the tool that is entitled to produce it)',
    match: { phases: ['after_action'], undeclaredEvidence: true },
    decision: 'deny',
  },
  // before_transition: may the work item complete, the plan be accepted, the run be gated?
  { id: 'allow-transitions', description: 'state transitions are allowed unless a rule refuses them', match: { phases: ['before_transition'] }, decision: 'allow' },
  {
    id: 'deny-completion-with-flagged-actions',
    description: 'a work item whose calls were flagged after action cannot complete (fail it; the flagged evidence never backs a completion)',
    match: { phases: ['before_transition'], transitions: ['work_item:completed'], flaggedActions: true },
    decision: 'deny',
  },
  // before_acceptance: may the run claim its verdict?
  { id: 'allow-acceptance', description: 'the gate verdict stands unless a rule withholds it', match: { phases: ['before_acceptance'] }, decision: 'allow' },
  {
    id: 'review-flagged-actions',
    description: 'a run with calls flagged after action needs human review before its verdict is accepted (at best inconclusive)',
    match: { phases: ['before_acceptance'], flaggedActions: true },
    decision: 'approval_required',
  },
]);

/**
 * True when the rule's match block applies to the request (see PolicyRule for resource semantics). Phase first: a rule
 * without `phases` applies to before_action only; the phase facts (`transitions`, `undeclaredEvidence`,
 * `flaggedActions`, `verdicts`) match only requests that carry the corresponding facts (a missing fact never matches a
 * positive condition).
 */
export function ruleMatches(rule: PolicyRule, req: ActionRequest): boolean {
  const m = rule.match;
  if (!(m.phases ?? ['before_action']).includes(requestPhase(req))) return false;
  if (m.transitions) {
    const t = req.transition;
    if (!t || !m.transitions.some((p) => matchesToolPattern(p, `${t.subject}:${t.to}`))) return false;
  }
  if (m.undeclaredEvidence !== undefined && ((req.outcome?.undeclaredEvidenceTypes?.length ?? 0) > 0) !== m.undeclaredEvidence) return false;
  if (m.flaggedActions !== undefined && (flaggedActionsOf(req) > 0) !== m.flaggedActions) return false;
  if (m.verdicts && (!req.acceptance || !m.verdicts.includes(req.acceptance.verdict))) return false;
  if (m.tools && !m.tools.some((p) => matchesToolPattern(p, req.tool))) return false;
  if (m.effects && !m.effects.includes(req.effect)) return false;
  if (m.minRisk && !(RISK_ORDER[req.riskClass] >= RISK_ORDER[m.minRisk])) return false;
  if (m.roles && (req.role === undefined || !m.roles.includes(req.role))) return false;
  if (m.environmentClasses && (req.environmentClass === undefined || !m.environmentClasses.includes(req.environmentClass))) return false;
  if (m.resources) {
    const hit = (r: string) => m.resources!.some((p) => matchesResourcePattern(p, r));
    if (rule.decision === 'allow') {
      if (req.resources.length === 0 || !req.resources.every(hit)) return false;
    } else if (!req.resources.some(hit)) {
      return false;
    }
  }
  return true;
}

function intersectStrings(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b === undefined ? undefined : [...b];
  if (b === undefined) return [...a];
  return [...new Set(a.filter((x) => b.includes(x)))].sort();
}

/** Intersects permit constraints (undefined = unconstrained; defined lists intersect; durations take the min). */
export function intersectConstraints(a: PermitConstraints | undefined, b: PermitConstraints | undefined): PermitConstraints | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  const out: PermitConstraints = {};
  const paths = a.allowedPaths && b.allowedPaths ? intersectPatterns(a.allowedPaths, b.allowedPaths, 'resource') : (a.allowedPaths ?? b.allowedPaths);
  if (paths) out.allowedPaths = [...paths];
  const hosts = intersectStrings(a.allowedHosts, b.allowedHosts);
  if (hosts) out.allowedHosts = hosts;
  const cmds = intersectStrings(a.allowedCommands, b.allowedCommands);
  if (cmds) out.allowedCommands = cmds;
  const creds = intersectStrings(a.credentialScope, b.credentialScope);
  if (creds) out.credentialScope = creds;
  if (a.maxDurationMs !== undefined || b.maxDurationMs !== undefined) out.maxDurationMs = Math.min(a.maxDurationMs ?? Infinity, b.maxDurationMs ?? Infinity);
  return out;
}

function defaultDecisionId(): string {
  return newId('pdec');
}

export interface CapabilityGateResult {
  ok: boolean;
  reason?: string;
}

const EFFECTS: ReadonlySet<string> = new Set(effectEnum);
const isStringList = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');

/** Structural problem of a request (engines deny instead of throwing on malformed input), if any. */
function malformedRequest(request: ActionRequest): string | undefined {
  if (!request || typeof request !== 'object') return 'request is not an object';
  if (typeof request.runId !== 'string' || request.runId === '') return 'runId';
  if (typeof request.tool !== 'string' || request.tool === '') return 'tool';
  if (typeof request.effect !== 'string' || !EFFECTS.has(request.effect)) return `effect ${String(request.effect)}`;
  if (typeof request.riskClass !== 'string' || !Object.hasOwn(RISK_ORDER, request.riskClass)) return `riskClass ${String(request.riskClass)}`;
  if (!isStringList(request.resources)) return 'resources';
  for (const k of ['environmentClass', 'role', 'agentId', 'workItemId'] as const) {
    if (request[k] !== undefined && typeof request[k] !== 'string') return k;
  }
  if (request.phase !== undefined && !(POLICY_PHASES as readonly string[]).includes(request.phase)) return `phase ${String(request.phase)}`;
  if (request.outcome !== undefined && (!request.outcome || typeof request.outcome !== 'object' || !isStringList(request.outcome.undeclaredEvidenceTypes))) return 'outcome';
  if (request.transition !== undefined && (!request.transition || typeof request.transition !== 'object' || typeof request.transition.subject !== 'string' || typeof request.transition.to !== 'string')) {
    return 'transition';
  }
  if (request.acceptance !== undefined && (!request.acceptance || typeof request.acceptance !== 'object' || typeof request.acceptance.verdict !== 'string')) return 'acceptance';
  return undefined;
}

function malformedCapability(cap: ActionRequest['capability']): string | undefined {
  if (!cap || typeof cap !== 'object') return 'not an object';
  for (const k of ['capabilityId', 'runId', 'subjectAgentId', 'workItemId', 'expiresAt', 'maxRiskClass'] as const) if (typeof cap[k] !== 'string') return k;
  for (const k of ['tools', 'resourceScopes', 'allowedEffects', 'credentialScopes', 'environmentClasses'] as const) if (!isStringList(cap[k])) return k;
  return undefined;
}

/**
 * Shared pre-check (I1/I2): well-formed request, signature (when a secret is configured), the capability is
 * bound to this run, agent and work item (no confused deputy), then capabilityAllows.
 */
export function checkCapability(request: ActionRequest, clock: Clock, secret: string | undefined): CapabilityGateResult {
  const badRequest = malformedRequest(request);
  if (badRequest !== undefined) return { ok: false, reason: `malformed_request: ${badRequest}` };
  if (!request.capability) return { ok: false, reason: 'capability_missing' };
  const badCap = malformedCapability(request.capability);
  if (badCap !== undefined) return { ok: false, reason: `capability_malformed: ${badCap}` };
  if (secret !== undefined && !verifyCapability(request.capability, secret)) return { ok: false, reason: 'capability_signature_invalid' };
  if (request.capability.runId !== request.runId) return { ok: false, reason: `capability_run_mismatch: ${request.capability.runId} != ${request.runId}` };
  if (request.agentId !== undefined && request.agentId !== request.capability.subjectAgentId) {
    return { ok: false, reason: `capability_subject_mismatch: ${request.capability.subjectAgentId} != ${request.agentId}` };
  }
  if (request.workItemId !== undefined && request.workItemId !== request.capability.workItemId) {
    return { ok: false, reason: `capability_work_item_mismatch: ${request.capability.workItemId} != ${request.workItemId}` };
  }
  // (review E[2]) a relayed write of a sandboxed command is bounded by the CALL's grant and the environment class
  const relayed = request.relayedWrite;
  if (relayed !== undefined) {
    if (!relayed || typeof relayed !== 'object' || !EFFECT_ORDER_KEYS.has(relayed.callEffect)) return { ok: false, reason: 'malformed_request: relayedWrite.callEffect must be a tool effect' };
    if (request.environmentClass === undefined) return { ok: false, reason: 'capability_denied: a relayed write needs the environment class of its target' };
  }
  const check = capabilityAllows(request.capability, {
    tool: request.tool,
    effect: relayed !== undefined ? relayed.callEffect : request.effect,
    riskClass: request.riskClass,
    resources: relayed !== undefined ? [] : request.resources,
    ...(request.environmentClass !== undefined ? { environmentClass: request.environmentClass } : {}),
    // E[4]: a brokered credential the call uses must be granted by the capability
    ...(request.credentialScopes !== undefined && request.credentialScopes.length > 0 ? { credentialScopes: request.credentialScopes } : {}),
    now: clock.isoNow(),
  });
  if (check.allowed) return { ok: true };
  return { ok: false, reason: `capability_denied: ${check.reason}` };
}

/**
 * Built-in rule engine (I1). Order: capability check (deny when the capability forbids the action) →
 * all matching rules → most restrictive decision; no matching rule ⇒ deny (fail closed). Constraints
 * of the matching allow/approval rules are intersected.
 */
export class BuiltinPolicyEngine implements PolicyEngine {
  readonly revision: string;
  readonly #rules: PolicyRule[];
  readonly #newId: () => string;
  readonly #clock: Clock;
  readonly #secret: string | undefined;

  constructor(rules: PolicyRule[], revision: string, options: PolicyEngineOptions = {}) {
    if (!revision) throw new HypertestError('invalid_argument', 'policy revision is required');
    const ids = new Set<string>();
    for (const r of rules) {
      const v = validateJson(POLICY_RULE_SCHEMA, r);
      if (!v.valid) throw new HypertestError('invalid_argument', `invalid policy rule ${(r as { id?: string }).id ?? '?'}: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
      if (ids.has(r.id)) throw new HypertestError('invalid_argument', `duplicate policy rule id ${r.id}`);
      ids.add(r.id);
    }
    // a private deep-frozen copy: neither the caller's array nor the `rules` getter can change evaluation
    this.#rules = deepFreeze(rules.map((r) => structuredClone(r)));
    this.revision = revision;
    this.#newId = options.newId ?? defaultDecisionId;
    this.#clock = options.clock ?? systemClock;
    this.#secret = options.capabilitySecret;
  }

  get rules(): readonly PolicyRule[] {
    return this.#rules;
  }

  async evaluate(request: ActionRequest): Promise<ActionPermit> {
    return this.evaluateSync(request);
  }

  /** Synchronous evaluation (deterministic apart from the decision id). */
  evaluateSync(request: ActionRequest): ActionPermit {
    const decisionId = this.#newId();
    const cap = checkCapability(request, this.#clock, this.#secret);
    if (!cap.ok) return { decision: 'deny', decisionId, reasons: [cap.reason!], policyRevision: this.revision };
    const matched = this.#rules.filter((r) => ruleMatches(r, request));
    if (matched.length === 0) {
      return { decision: 'deny', decisionId, reasons: [`no_matching_rule: ${request.tool} (${request.effect}${request.environmentClass ? ` on ${request.environmentClass}` : ''})`], policyRevision: this.revision };
    }
    let decision: Decision = 'allow';
    for (const r of matched) decision = mostRestrictive(decision, r.decision);
    const reasons = matched.filter((r) => r.decision === decision).map((r) => `rule:${r.id}: ${r.description}`);
    const permit: ActionPermit = { decision, decisionId, reasons, policyRevision: this.revision };
    if (decision !== 'deny') {
      let constraints: PermitConstraints | undefined;
      for (const r of matched) if (r.decision !== 'deny' && r.constraints) constraints = intersectConstraints(constraints, r.constraints);
      if (constraints) permit.constraints = constraints;
    }
    return permit;
  }
}

/**
 * Combines engines: deny wins, approval_required beats allow, reasons are concatenated (prefixed by the
 * engine revision), constraints intersected, revision = joined revisions. No engines ⇒ deny. An engine
 * that throws counts as deny (fail closed).
 */
export class CompositePolicyEngine implements PolicyEngine {
  readonly revision: string;
  readonly #engines: PolicyEngine[];
  readonly #newId: () => string;

  constructor(engines: PolicyEngine[], options: Pick<PolicyEngineOptions, 'newId'> = {}) {
    this.#engines = [...engines];
    this.revision = engines.map((e) => e.revision).join('+') || 'composite:empty';
    this.#newId = options.newId ?? defaultDecisionId;
  }

  async evaluate(request: ActionRequest): Promise<ActionPermit> {
    const decisionId = this.#newId();
    if (this.#engines.length === 0) return { decision: 'deny', decisionId, reasons: ['no_policy_engines'], policyRevision: this.revision };
    const permits = await Promise.all(
      this.#engines.map(async (e): Promise<ActionPermit> => {
        try {
          return await e.evaluate(request);
        } catch (err) {
          return { decision: 'deny', decisionId: '', reasons: [`engine_error: ${err instanceof Error ? err.message : String(err)}`], policyRevision: e.revision };
        }
      }),
    );
    let decision: Decision = 'allow';
    const reasons: string[] = [];
    for (let i = 0; i < permits.length; i++) {
      const p = permits[i]!;
      const revision = this.#engines[i]!.revision;
      const wellFormed = p !== null && typeof p === 'object' && isDecision(p.decision) && Array.isArray(p.reasons);
      // a malformed permit counts as deny (fail closed)
      decision = mostRestrictive(decision, wellFormed ? p.decision : 'deny');
      if (!wellFormed) {
        reasons.push(`[${revision}] engine_error: malformed permit`);
        continue;
      }
      for (const r of p.reasons) reasons.push(`[${revision}] ${String(r)}`);
    }
    const permit: ActionPermit = { decision, decisionId, reasons, policyRevision: this.revision };
    if (decision !== 'deny') {
      let constraints: PermitConstraints | undefined;
      for (const p of permits) if (p.constraints) constraints = intersectConstraints(constraints, p.constraints);
      if (constraints) permit.constraints = constraints;
    }
    return permit;
  }
}

function isDecision(x: unknown): x is Decision {
  return x === 'allow' || x === 'deny' || x === 'approval_required';
}


// ------------------------------------------------------------------------------------------------ approval gate (E[8])

/** Default validity of an action approval request (its `subject.expiresAt`). */
export const DEFAULT_ACTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * (E[8]) The exact action an approval authorizes: run, work item, tool, effect, risk, resources (the target), environment
 * class and the digest of the (redacted) arguments. The same call with other arguments, on another target or for another
 * work item is another action and needs its own approval.
 */
export function actionDigest(request: Pick<ActionRequest, 'runId' | 'workItemId' | 'tool' | 'effect' | 'riskClass' | 'resources' | 'environmentClass' | 'input'>): string {
  // (review) over the STORED form (storable: U+0000 → U+FFFD), so the digest an approval's subject re-describes matches
  return hashCanonical(
    storable({
      runId: request.runId,
      workItemId: request.workItemId ?? null,
      tool: request.tool,
      effect: request.effect,
      riskClass: request.riskClass,
      resources: [...request.resources].sort(),
      environmentClass: request.environmentClass ?? null,
      inputDigest: hashCanonical(storable(request.input === undefined ? null : request.input)),
    }),
  );
}

/** The action digest an approval request is bound to (`subject.actionDigest`). */
export function approvalActionDigest(a: Pick<ApprovalRequest, 'subject'>): string | undefined {
  const s = a.subject as { actionDigest?: unknown } | null;
  return s && typeof s === 'object' && typeof s.actionDigest === 'string' ? s.actionDigest : undefined;
}

/**
 * (review) The digest of the action an approval's subject DESCRIBES — what its decider was shown: tool, effect, risk,
 * resources, work item, environment class and the (redacted) arguments of run `a.runId`. undefined when the subject is
 * not a complete action description. The gate honours an approval only when this equals its `actionDigest`: anyone may
 * FILE an action approval (an agent's request_approval), but the action it authorizes is always exactly the one a human
 * saw and approved — never another action hidden behind a forged digest.
 */
export function subjectActionDigest(a: Pick<ApprovalRequest, 'runId' | 'subject'>): string | undefined {
  const s = a.subject as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const { tool, effect, riskClass, resources, workItemId, environmentClass } = s;
  if (typeof tool !== 'string' || typeof effect !== 'string' || typeof riskClass !== 'string') return undefined;
  if (!Array.isArray(resources) || resources.some((r) => typeof r !== 'string')) return undefined;
  if (workItemId !== undefined && typeof workItemId !== 'string') return undefined;
  if (environmentClass !== undefined && typeof environmentClass !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(s, 'input')) return undefined;
  const described: Pick<ActionRequest, 'runId' | 'workItemId' | 'tool' | 'effect' | 'riskClass' | 'resources' | 'environmentClass' | 'input'> = {
    runId: a.runId, tool, effect: effect as ActionRequest['effect'], riskClass: riskClass as ActionRequest['riskClass'], resources: resources as string[],
  };
  if (s['input'] !== null && s['input'] !== undefined) described.input = s['input'] as NonNullable<ActionRequest['input']>;
  if (workItemId !== undefined) described.workItemId = workItemId;
  if (environmentClass !== undefined) described.environmentClass = environmentClass;
  return actionDigest(described);
}

/** (review) Why an action approval cannot authorize anything (undefined: it is a truthful, time-boxed action description). */
function unusableActionApproval(a: Pick<ApprovalRequest, 'approvalId' | 'runId' | 'subject'>): string | undefined {
  const bound = approvalActionDigest(a);
  if (bound === undefined || subjectActionDigest(a) !== bound) return `approval_mismatch: approval ${a.approvalId} does not describe the action it is bound to (its subject's tool, arguments and target do not digest to ${bound ?? 'its actionDigest'}): it authorizes nothing`;
  if (approvalExpiresAt(a) === undefined) return `approval_unusable: approval ${a.approvalId} has no decision window (subject.expiresAt): it authorizes nothing`;
  return undefined;
}

function approvalExpiresAt(a: Pick<ApprovalRequest, 'subject'>): number | undefined {
  const s = a.subject as { expiresAt?: unknown } | null;
  const t = s && typeof s === 'object' && typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * (E[8]) The human-in-the-loop of action permits. Wraps an engine (the built-in rules + OPA composite): a `before_action`
 * request the inner engine sends to `approval_required` is turned into
 *  - `allow`, when an approval of kind `action` bound to the exact action digest is `approved` by an independent human or
 *    system actor (never the requesting agent: approvals of kind action are never decided by agents), not expired, and
 *    can be CONSUMED by this request (exactly once: a replay of the same request finds its own consumption; another
 *    request is refused) — the permit names it (`approvalId`) and keeps the inner engine's constraints;
 *  - `deny`, when the latest decision on this exact action is a denial, or its approval expired (no silent re-request);
 *  - `approval_required` with the `approvalId` of the pending request for this exact action — created (subject: action
 *    digest, tool, input digest, resources, risk, effect, environment class, run, work item, invocation, expiresAt) when
 *    none is pending.
 * An `approvalId` named by the request that does not match the action (another digest, another run, not an action
 * approval) is refused (deny, exact reason). Every other decision of the inner engine is returned unchanged.
 */
export class ApprovalGatedPolicyEngine implements PolicyEngine {
  readonly revision: string;
  readonly #inner: PolicyEngine;
  readonly #o: ApprovalGateOptions;
  readonly #ttlMs: number;

  constructor(inner: PolicyEngine, options: ApprovalGateOptions) {
    if (!options?.approvals) throw new HypertestError('invalid_argument', 'ApprovalGatedPolicyEngine requires an approval service');
    this.#inner = inner;
    this.#o = options;
    this.#ttlMs = options.approvalTtlMs ?? DEFAULT_ACTION_APPROVAL_TTL_MS;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) throw new HypertestError('invalid_argument', 'approvalTtlMs must be positive');
    // the gate does not change which actions need approval: the policy revision is the inner engine's
    this.revision = inner.revision;
  }

  async evaluate(request: ActionRequest): Promise<ActionPermit> {
    const permit = await this.#inner.evaluate(request);
    if (permit.decision !== 'approval_required' || requestPhase(request) !== 'before_action') return permit;
    const digest = actionDigest(request);
    const ctx: EventContext = { runId: request.runId, correlationId: request.requestId, actorId: request.agentId !== undefined ? `agent:${request.agentId}` : 'system:policy' };
    if (request.workItemId !== undefined) ctx.workItemId = request.workItemId;
    if (request.agentId !== undefined) ctx.agentId = request.agentId;
    const nowMs = this.#o.clock.nowMs();
    const deny = (reason: string, approvalId?: string): ActionPermit => {
      const out: ActionPermit = { decision: 'deny', decisionId: permit.decisionId, reasons: [...permit.reasons, reason], policyRevision: permit.policyRevision };
      if (approvalId !== undefined) out.approvalId = approvalId;
      return out;
    };
    let candidates: ApprovalRequest[];
    if (request.approvalId !== undefined) {
      const named = await this.#o.approvals.get(request.approvalId);
      if (!named || named.kind !== 'action' || named.runId !== request.runId) return deny(`approval_mismatch: ${request.approvalId} is not an action approval of run ${request.runId}`);
      if (approvalActionDigest(named) !== digest) return deny(`approval_mismatch: approval ${request.approvalId} authorizes another action (digest ${approvalActionDigest(named) ?? 'none'}, this action ${digest})`, request.approvalId);
      // (review) the approval must truthfully describe this action (what its decider saw) and be time-boxed
      const unusable = unusableActionApproval(named);
      if (unusable !== undefined) return deny(unusable, request.approvalId);
      candidates = [named];
    } else {
      // (review) only truthful, time-boxed descriptions of THIS action count: an approval filed with a forged digest (its
      // subject shows another action) neither authorizes nor blocks it
      candidates = (await this.#o.approvals.list({ runId: request.runId })).filter((a) => a.kind === 'action' && approvalActionDigest(a) === digest && unusableActionApproval(a) === undefined).reverse();
    }
    // newest first: an approved one (unconsumed or consumed by this very request) authorizes the action once
    for (const a of candidates) {
      if (a.status === 'approved') {
        const until = approvalExpiresAt(a);
        if (until !== undefined && until <= nowMs) return deny(`approval_expired: approval ${a.approvalId} of this action expired at ${new Date(until).toISOString()}`, a.approvalId);
        const by = a.decidedBy;
        if (!by || (by.kind !== 'human' && by.kind !== 'system') || by.id === a.requestedBy.id || (request.agentId !== undefined && by.id === request.agentId)) {
          return deny(`approval_not_independent: approval ${a.approvalId} was not decided by an independent human or system actor`, a.approvalId);
        }
        if (!this.#o.approvals.consume) return deny('approval_unconsumable: the approval store cannot consume approvals (exactly-once is required)', a.approvalId);
        const used = await this.#o.approvals.consume(a.approvalId, { requestId: request.requestId, digest }, ctx);
        if (!used.consumed) {
          // consumed by another request: this one needs (and gets) its own approval request below
          continue;
        }
        const allowed: ActionPermit = { decision: 'allow', decisionId: permit.decisionId, reasons: [...permit.reasons, `approval:${a.approvalId}: granted by ${by.kind}:${by.id}${a.rationale ? ` (${a.rationale})` : ''}; consumed by ${request.requestId}`], policyRevision: permit.policyRevision, approvalId: a.approvalId };
        if (permit.constraints) allowed.constraints = permit.constraints;
        return allowed;
      }
      if (a.status === 'denied') return deny(`approval_denied: approval ${a.approvalId} of this action was denied by ${a.decidedBy ? `${a.decidedBy.kind}:${a.decidedBy.id}` : 'its decider'}${a.rationale ? ` (${a.rationale})` : ''}; do not retry it`, a.approvalId);
      if (a.status === 'expired') return deny(`approval_expired: approval ${a.approvalId} of this action expired before it was decided`, a.approvalId);
      if (a.status === 'pending') {
        const until = approvalExpiresAt(a);
        if (until !== undefined && until <= nowMs) {
          if (this.#o.approvals.expire) await this.#o.approvals.expire(a.approvalId, ctx);
          return deny(`approval_expired: approval ${a.approvalId} of this action expired before it was decided`, a.approvalId);
        }
        return { ...permit, approvalId: a.approvalId, reasons: [...permit.reasons, `approval:${a.approvalId}: pending`] };
      }
    }
    // (review E[2]) a caller that cannot wait for a decision (a relayed sandbox write) gets approval_required as is: no request
    if (request.noApprovalRequest === true) return { ...permit, reasons: [...permit.reasons, 'approval: not requested (the caller cannot wait for a human decision)'] };
    // no usable approval for this exact action: request one
    const requestedBy: ActorRef = request.agentId !== undefined ? { kind: 'agent', id: request.agentId } : { kind: 'system', id: 'policy' };
    if (request.role !== undefined) requestedBy.role = request.role;
    const subject: Record<string, JsonValue> = {
      actionDigest: digest,
      tool: request.tool,
      effect: request.effect,
      riskClass: request.riskClass,
      resources: [...request.resources].sort(),
      inputDigest: hashCanonical(storable(request.input === undefined ? null : request.input)),
      input: request.input ?? null,
      requestId: request.requestId,
      policyDecisionId: permit.decisionId,
      reasons: permit.reasons.slice(0, 20),
      expiresAt: new Date(nowMs + this.#ttlMs).toISOString(),
    };
    if (request.workItemId !== undefined) subject['workItemId'] = request.workItemId;
    if (request.environmentClass !== undefined) subject['environmentClass'] = request.environmentClass;
    let created: ApprovalRequest;
    try {
      created = await this.#o.approvals.request({ runId: request.runId, kind: 'action', subject, requestedBy, rationale: `policy ${permit.decisionId}: ${permit.reasons.join('; ').slice(0, 1000)}` }, ctx);
    } catch (e) {
      if (isHypertestError(e)) return deny(`approval_unavailable: the approval request could not be recorded (${e.code}): ${e.message}`);
      throw e;
    }
    return { ...permit, approvalId: created.approvalId, reasons: [...permit.reasons, `approval:${created.approvalId}: requested`] };
  }
}
