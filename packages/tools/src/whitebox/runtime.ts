import { HypertestError, abortReason, compileSchema, throwIfAborted, withTimeout, type JsonValue } from '@hypertest/core';
import { EFFECT_ORDER, EVENT_TYPES, RISK_ORDER, eventFrom, type ArtifactRef, type EnvironmentRef, type EventContext, type EvidenceRecord, type Provenance, type ResourceRef, type RiskClass, type ToolEffect } from '@hypertest/domain';
import { recordEvidence, type RecordEvidenceInput } from '@hypertest/evidence';
import type { SideEffectGateway, SideEffectOutcome } from '@hypertest/operation';
import { capabilityAllows, matchesResourcePattern, verifyCapability, type ActionPermit, type ActionRequest } from '@hypertest/policy';
import type { ToolContext, ToolExecutionRequest, ToolExecutionResult, ToolOutcome, ToolRuntime, ToolRuntimeDeps, ToolSpec, ToolStatus } from '../contracts.ts';

/** Default model-visible byte budget before a tool output is offloaded to the ArtifactStore (I9). */
export const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
/** Keys whose values are redacted before a tool input reaches policy evaluation and decision logs. */
export const SECRET_KEY_PATTERN = /secret|token|password|api[_-]?key|authorization/i;
export const REDACTED = '[REDACTED]';
const MAX_LISTED_EVIDENCE = 20;
const EFFECTS_WITHOUT_FRESHNESS: ReadonlySet<ToolEffect> = new Set(['read', 'record']);

/** Deep copy of a JSON-like value with every property whose key matches SECRET_KEY_PATTERN replaced. */
export function redactSecrets(value: unknown, pattern: RegExp = SECRET_KEY_PATTERN): JsonValue {
  const seen = new Set<object>();
  const walk = (v: unknown): JsonValue | undefined => {
    if (v === null) return null;
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        return Number.isFinite(v) ? v : null;
      case 'object': {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
        try {
          if (Array.isArray(v)) return v.map((x) => walk(x) ?? null);
          const out: Record<string, JsonValue> = {};
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (pattern.test(k)) {
              out[k] = REDACTED;
              continue;
            }
            const w = walk(x);
            if (w !== undefined) out[k] = w;
          }
          return out;
        } finally {
          seen.delete(v as object);
        }
      }
      default:
        return undefined;
    }
  };
  return walk(value) ?? null;
}

function toJson(value: unknown, what: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (e) {
    throw new HypertestError('internal', `${what} is not JSON-serializable: ${(e as Error).message}`);
  }
}

/** First `maxBytes` UTF-8 bytes of `s`, cut on a code point boundary. */
export function utf8Head(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let n = Math.max(0, maxBytes);
  while (n > 0 && (buf[n]! & 0xc0) === 0x80) n--;
  return buf.subarray(0, n).toString('utf8');
}

/** Last `maxBytes` UTF-8 bytes of `s`, cut on a code point boundary. */
export function utf8Tail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let start = buf.byteLength - Math.max(0, maxBytes);
  while (start < buf.byteLength && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

function evidenceLine(ids: readonly string[]): string {
  if (ids.length === 0) return '';
  const shown = ids.slice(0, MAX_LISTED_EVIDENCE);
  const more = ids.length > shown.length ? `, +${ids.length - shown.length} more` : '';
  return `\n[evidence: ${shown.join(', ')}${more}]`;
}

function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/** Grace period for the gateway to record an interrupted operation (e.g. `outcome_unknown`) after an abort. */
export const SIDE_EFFECT_SETTLE_MS = 5_000;

/**
 * Runs a gateway call under the tool timeout and the request signal. Unlike withTimeout it does not drop the
 * gateway's answer on abort: the gateway records an interrupted dispatch (outcome_unknown) and answers
 * `pending` with its operation id, which is what the model must see (never a bare timeout that invites a
 * duplicate external effect). Only if the gateway does not settle within SIDE_EFFECT_SETTLE_MS does the
 * abort reason (timeout / cancelled) surface.
 */
async function runSideEffect(run: (signal: AbortSignal) => Promise<SideEffectOutcome>, timeoutMs: number, parent: AbortSignal, what: string): Promise<SideEffectOutcome> {
  throwIfAborted(parent);
  const ctrl = new AbortController();
  const onParent = () => ctrl.abort(parent.reason);
  parent.addEventListener('abort', onParent, { once: true });
  const timer = setTimeout(() => ctrl.abort(new HypertestError('timeout', `${what} timed out after ${timeoutMs}ms`)), timeoutMs);
  let settle: NodeJS.Timeout | undefined;
  const giveUp = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => {
      settle = setTimeout(() => reject(abortReason(ctrl.signal)), SIDE_EFFECT_SETTLE_MS);
    }, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(ctrl.signal)), giveUp]);
  } finally {
    clearTimeout(timer);
    if (settle) clearTimeout(settle);
    parent.removeEventListener('abort', onParent);
  }
}

/** Read-only view of the gateway for tools without a side-effect binding: observe only (no dispatch). */
function observeOnly(gateway: SideEffectGateway): SideEffectGateway {
  return {
    run() {
      return Promise.reject(new HypertestError('permission_denied', 'this tool has no side-effect binding; external effects run only through the runtime'));
    },
    observe(operationId, ctx, signal) {
      return gateway.observe(operationId, ctx, signal);
    },
    compensate() {
      return Promise.reject(new HypertestError('permission_denied', 'this tool has no side-effect binding; compensation runs only through a bound tool'));
    },
  };
}

interface Stage {
  status: ToolStatus;
  structured?: JsonValue;
  text?: string;
  error?: { code: string; message: string };
  operationId?: string;
  artifactRefs: ArtifactRef[];
  evidenceRefs: string[];
}

/**
 * The Tool & Capability Runtime (I1, I4, I9, I10). Pipeline per invocation:
 *  1 lookup (unknown ⇒ denied/not_found) · 2 input schema (⇒ failed/schema_violation) · 3 capability
 *  signature + binding to run/agent/work item · 4 effect/risk/resources/environment ⇒ capabilityAllows ·
 *  5 PolicyEngine permit on the redacted input, recorded in the decision log (deny / approval_required ⇒
 *  denied; permit constraints enforced) · 6 FreshnessGuard for effects beyond read/record ⇒ stale_context ·
 *  7 tool.called · 8 execution (side effects ONLY via the SideEffectGateway with the invocation id; other
 *  tools under min(request, spec) timeout + the request signal) · 9 output schema · 10 bounded model text
 *  with artifact offload + evidence · 11 tool.completed (tool.denied for denials).
 * Domain outcomes never throw; only programmer errors (malformed request objects) do.
 */
export function createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime {
  if (!deps.capabilitySecret) throw new HypertestError('invalid_argument', 'ToolRuntimeDeps.capabilitySecret is required');
  const { registry, clock } = deps;

  return {
    registry,
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      if (!request || typeof request !== 'object' || typeof request.toolId !== 'string' || typeof request.invocationId !== 'string' || !request.eventContext || !request.workspace || !request.signal) {
        throw new HypertestError('invalid_argument', 'malformed ToolExecutionRequest');
      }
      const started = clock.nowMs();
      const evCtx: EventContext = {
        ...request.eventContext,
        workItemId: request.eventContext.workItemId ?? request.workItemId,
        agentId: request.eventContext.agentId ?? request.agentId,
      };
      const logger = deps.logger.child({ toolId: request.toolId, invocationId: request.invocationId, runId: request.runId });

      const emit = async (eventType: string, payload: Record<string, unknown>): Promise<void> => {
        if (!deps.events) return;
        const clean = toJson(payload, 'event payload') as Record<string, JsonValue>;
        await deps.events.emit([eventFrom(evCtx, eventType, 'tool', request.invocationId, clean)]);
      };

      const finish = (stage: Stage, modelText: string, permit?: ActionPermit): ToolExecutionResult => {
        const r: ToolExecutionResult = {
          toolId: request.toolId,
          invocationId: request.invocationId,
          status: stage.status,
          modelText,
          artifactRefs: stage.artifactRefs,
          evidenceRefs: stage.evidenceRefs,
          durationMs: Math.max(0, clock.nowMs() - started),
        };
        if (stage.structured !== undefined) r.structured = stage.structured;
        if (stage.operationId !== undefined) r.operationId = stage.operationId;
        if (permit) r.permit = permit;
        if (stage.error) r.error = stage.error;
        return r;
      };

      /** A denial (never executed): tool.denied event + bounded explanation for the model. */
      const deny = async (status: ToolStatus, code: string, reason: string, permit?: ActionPermit, extraText?: string): Promise<ToolExecutionResult> => {
        const payload: Record<string, unknown> = { toolId: request.toolId, invocationId: request.invocationId, status, errorCode: code, reason };
        if (permit) payload['permitDecisionId'] = permit.decisionId;
        try {
          await emit(EVENT_TYPES.toolDenied, payload);
        } catch (e) {
          logger.error('failed to emit tool.denied', { error: (e as Error).message });
        }
        const text = utf8Head(`[${status}] ${code}: ${reason}${extraText ? `\n${extraText}` : ''}`, DEFAULT_MAX_INLINE_BYTES);
        return finish({ status, error: { code, message: reason }, artifactRefs: [], evidenceRefs: [] }, text, permit);
      };

      // 1 lookup
      const spec: ToolSpec | undefined = registry.get(request.toolId);
      if (!spec) return deny('denied', 'not_found', `unknown tool ${request.toolId}`);

      // 2 input validation — on a private deep copy: what is classified, authorized and executed is exactly
      // what was validated, even if the caller mutates request.input while the pipeline awaits
      let input: unknown;
      try {
        input = request.input === undefined ? undefined : structuredClone(request.input);
      } catch (e) {
        return deny('failed', 'schema_violation', `input is not plain JSON data: ${(e as Error).message}`);
      }
      let validation: ReturnType<ReturnType<typeof compileSchema>>;
      try {
        validation = compileSchema(spec.inputSchema)(input);
      } catch (e) {
        return deny('failed', 'internal', `tool ${spec.id} has an invalid input schema: ${(e as Error).message}`);
      }
      if (!validation.valid) {
        const issues = validation.issues.map((i) => `${i.path} ${i.message}`).join('; ');
        return deny('failed', 'schema_violation', `input does not match the ${spec.id} schema: ${issues}`);
      }
      // resource keys (capability scopes) derive from resourcePrefix: it must name this very workspace
      if (request.workspace.resourcePrefix !== `workspace/${request.workspace.workspaceId}`) {
        return deny('denied', 'permission_denied', `workspace_handle_inconsistent: resourcePrefix ${String(request.workspace.resourcePrefix)} != workspace/${String(request.workspace.workspaceId)}`);
      }

      // 3 capability authenticity and binding (no confused deputy)
      const cap = request.capability;
      if (!cap || typeof cap !== 'object' || !verifyCapability(cap, deps.capabilitySecret)) return deny('denied', 'permission_denied', 'capability_signature_invalid');
      if (cap.runId !== request.runId) return deny('denied', 'permission_denied', `capability_run_mismatch: ${cap.runId} != ${request.runId}`);
      if (cap.subjectAgentId !== request.agentId) return deny('denied', 'permission_denied', `capability_subject_mismatch: ${cap.subjectAgentId} != ${request.agentId}`);
      if (cap.workItemId !== request.workItemId) return deny('denied', 'permission_denied', `capability_work_item_mismatch: ${cap.workItemId} != ${request.workItemId}`);

      // 4 effect / risk / resources / environment ⇒ capability scope
      let effect: ToolEffect;
      let riskClass: RiskClass;
      let resources: string[];
      let environmentClass: string | undefined;
      try {
        effect = typeof spec.effect === 'function' ? spec.effect(input) : spec.effect;
        riskClass = typeof spec.riskClass === 'function' ? spec.riskClass(input) : spec.riskClass;
        if (!Object.hasOwn(EFFECT_ORDER, effect)) throw new HypertestError('internal', `tool ${spec.id} computed an unknown effect ${String(effect)}`);
        if (!Object.hasOwn(RISK_ORDER, riskClass)) throw new HypertestError('internal', `tool ${spec.id} computed an unknown risk class ${String(riskClass)}`);
        resources = spec.resources(input, { workspace: request.workspace, runId: request.runId, environments: deps.environments });
        if (!Array.isArray(resources) || resources.some((r) => typeof r !== 'string')) throw new HypertestError('internal', `tool ${spec.id} returned malformed resources`);
        environmentClass = spec.environmentClass?.(input, { environments: deps.environments });
      } catch (e) {
        const he = e instanceof HypertestError ? e : new HypertestError('internal', (e as Error)?.message ?? String(e));
        if (he.code === 'internal') logger.error('tool classification failed', { error: he.message });
        return deny('denied', he.code, `cannot classify the action: ${he.message}`);
      }
      const check = capabilityAllows(cap, { tool: spec.id, effect, riskClass, resources, ...(environmentClass !== undefined ? { environmentClass } : {}), now: clock.isoNow() });
      if (!check.allowed) return deny('denied', 'permission_denied', `capability_denied: ${check.reason}`);

      // 5 policy permit (redacted input) + decision log
      const actionRequest: ActionRequest = {
        requestId: request.invocationId,
        runId: request.runId,
        workItemId: request.workItemId,
        agentId: request.agentId,
        role: request.role,
        tool: spec.id,
        effect,
        riskClass,
        resources,
        capability: cap,
        input: redactSecrets(input),
        phase: 'before_action',
      };
      if (environmentClass !== undefined) actionRequest.environmentClass = environmentClass;
      if (request.snapshot?.snapshotId) actionRequest.snapshotId = request.snapshot.snapshotId;
      let permit: ActionPermit;
      try {
        permit = await deps.policy.evaluate(actionRequest);
        if (!permit || (permit.decision !== 'allow' && permit.decision !== 'deny' && permit.decision !== 'approval_required') || typeof permit.decisionId !== 'string' || permit.decisionId === '' || !Array.isArray(permit.reasons)) {
          throw new HypertestError('internal', 'policy engine returned a malformed permit');
        }
      } catch (e) {
        logger.error('policy evaluation failed; denying (fail closed)', { error: (e as Error).message });
        permit = { decision: 'deny', decisionId: deps.ids.next('pdec'), reasons: [`policy_engine_error: ${(e as Error).message}`], policyRevision: deps.policy.revision };
      }
      if (deps.decisionLog) {
        try {
          await deps.decisionLog.record(actionRequest, permit, evCtx);
        } catch (e) {
          logger.error('policy decision could not be recorded; not executing', { error: (e as Error).message });
          return deny('failed', e instanceof HypertestError ? e.code : 'internal', `policy decision ${permit.decisionId} could not be recorded: ${(e as Error).message}`, permit);
        }
      }
      if (permit.decision === 'deny') return deny('denied', 'permission_denied', `policy denied (decision ${permit.decisionId}): ${permit.reasons.join('; ') || 'no reason given'}`, permit);
      if (permit.decision === 'approval_required') {
        const approvalId = permit.approvalId ?? permit.decisionId;
        return deny(
          'denied',
          'approval_required',
          `approval required (approvalId ${approvalId}, decision ${permit.decisionId}): ${permit.reasons.join('; ')}`,
          permit,
          `To proceed, request approval referencing approvalId ${approvalId} (policy decision ${permit.decisionId}), then retry once it is granted.`,
        );
      }
      const allowedPaths = permit.constraints?.allowedPaths;
      if (allowedPaths !== undefined) {
        const outside = resources.filter((r) => !allowedPaths.some((p) => matchesResourcePattern(p, r)));
        if (outside.length > 0) return deny('denied', 'permission_denied', `permit_constraint_violated: resources outside allowedPaths: ${outside.join(', ')}`, permit);
      }

      // 6 freshness for mutating effects — fail closed: a configured guard with no snapshot cannot vouch for the action.
      //   Exception: the REPLAY of a side-effect call that was already dispatched (the same invocation: a durable retry of
      //   a committed turn, e.g. after a crash) on a snapshot that is stale by now. Its act happened (or may have) under
      //   the snapshot validated when it was dispatched — the recovery's own reconciliation may even have moved the
      //   environment on since. Refusing it would hide the recorded outcome and invite the model to re-issue the act (a
      //   second operation, a duplicate side effect: §4.4, I4). It only SETTLES that operation: reconcile-only, never
      //   dispatched again (a re-dispatch would be a new decision on a stale view).
      let replayOf: string | undefined;
      if (!EFFECTS_WITHOUT_FRESHNESS.has(effect) && deps.freshness) {
        let staleText: string | undefined;
        if (!request.snapshot) staleText = 'no context snapshot supplied for a mutating action; freshness cannot be validated';
        else {
          let fresh: Awaited<ReturnType<NonNullable<ToolRuntimeDeps['freshness']>['validate']>>;
          try {
            fresh = await deps.freshness.validate(request.snapshot, { tool: spec.id, resources, mutating: true }, evCtx);
          } catch (e) {
            logger.error('freshness validation failed; not executing', { error: (e as Error).message });
            return deny('stale_context', 'stale_context', `freshness could not be validated: ${(e as Error).message}`, permit);
          }
          if (!fresh.fresh) staleText = `stale context (snapshot ${request.snapshot.snapshotId}): ${fresh.stale.map((s) => `${s.resourceType}/${s.resourceId}: ${s.reason}`).join('; ')}`;
        }
        if (staleText !== undefined && spec.sideEffect && deps.sideEffects?.find) {
          try {
            const prior = await deps.sideEffects.find(request.invocationId, spec.sideEffect.operationType, request.runId);
            if (prior && prior.status !== 'prepared' && prior.status !== 'not_applied') replayOf = prior.operationId;
          } catch (e) {
            logger.warn('operation lookup failed; the stale call is refused', { invocationId: request.invocationId, error: (e as Error).message });
          }
        }
        if (staleText !== undefined && replayOf === undefined) {
          return request.snapshot
            ? deny('stale_context', 'stale_context', staleText, permit, 'Refresh your view of these resources (new context snapshot) before retrying the mutating action.')
            : deny('stale_context', 'stale_context', staleText, permit, 'The runtime must execute mutating tools against the current turn snapshot.');
        }
      }

      // 7 tool.called (audit before any effect)
      try {
        const called: Record<string, JsonValue> = { toolId: spec.id, invocationId: request.invocationId, effect, riskClass, resources, permitDecisionId: permit.decisionId };
        // (audit) a stale replay: this call only settles the operation it dispatched before (reconcile-only)
        if (replayOf !== undefined) called['replayOfOperation'] = replayOf;
        await emit(EVENT_TYPES.toolCalled, called);
      } catch (e) {
        logger.error('tool.called could not be emitted; not executing', { error: (e as Error).message });
        return finish({ status: 'failed', error: { code: 'unavailable', message: `audit event could not be written: ${(e as Error).message}` }, artifactRefs: [], evidenceRefs: [] }, '[failed] unavailable: audit event could not be written; the tool was not executed', permit);
      }

      // 8 execute
      const produced: EvidenceRecord[] = [];
      const recordEv: ToolContext['recordEvidence'] = async (inp) => {
        const provenance: Provenance = { ...(inp.provenance ?? {}), toolId: spec.id, toolInvocationId: request.invocationId, workspaceId: request.workspace.workspaceId };
        const commit = inp.provenance?.commit ?? request.workspace.baseCommit;
        if (commit !== undefined) provenance.commit = commit;
        else delete provenance.commit;
        const evInput: RecordEvidenceInput = {
          runId: request.runId,
          evidenceType: inp.evidenceType,
          data: inp.data,
          mimeType: inp.mimeType,
          summary: inp.summary,
          workItemId: request.workItemId,
          agentId: request.agentId,
          toolInvocationId: request.invocationId,
          producer: { agentId: request.agentId, workerId: deps.workerId, runtimeManifestId: deps.runtimeManifestId },
          provenance,
        };
        if (inp.structured !== undefined) evInput.structured = inp.structured;
        const environment = inp.environment ?? addressedEnvironment(input, deps.environments);
        if (environment !== undefined) evInput.environment = environment;
        if (inp.operationId !== undefined) evInput.operationId = inp.operationId;
        if (inp.parentEvidenceIds !== undefined) evInput.parentEvidenceIds = inp.parentEvidenceIds;
        const eventContext: Partial<Omit<EventContext, 'runId'>> = { correlationId: evCtx.correlationId, actorId: evCtx.actorId, workItemId: request.workItemId, agentId: request.agentId };
        if (evCtx.causationId !== undefined) eventContext.causationId = evCtx.causationId;
        const rec = await recordEvidence(deps.evidence, deps.artifacts, evInput, undefined, { eventContext });
        produced.push(rec);
        return rec;
      };

      let timeoutMs = spec.timeoutMs;
      if (typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) timeoutMs = Math.min(timeoutMs, request.timeoutMs);
      if (permit.constraints?.maxDurationMs !== undefined && permit.constraints.maxDurationMs > 0) timeoutMs = Math.min(timeoutMs, permit.constraints.maxDurationMs);

      const stage: Stage = { status: 'failed', artifactRefs: [], evidenceRefs: [] };
      try {
        if (spec.sideEffect) {
          const binding = spec.sideEffect;
          const gateway = deps.sideEffects;
          if (!gateway) throw new HypertestError('precondition_failed', `tool ${spec.id} needs a SideEffectGateway, none is configured`);
          const baseCtx = makeCtx(request.signal);
          const target: ResourceRef = binding.target(input, baseCtx);
          // the external target must be a resource the capability and the permit were checked against
          if (!target || typeof target.resourceKey !== 'string' || !resources.some((r) => target.resourceKey === r || target.resourceKey.startsWith(r + '/'))) {
            throw new HypertestError('permission_denied', `side-effect target ${String(target?.resourceKey)} is not among the authorized resources (${resources.join(', ')})`);
          }
          const outcome = await runSideEffect(
            (signal) =>
              gateway.run({
                runId: request.runId,
                workItemId: request.workItemId,
                agentId: request.agentId,
                toolInvocationId: request.invocationId,
                operationType: binding.operationType,
                adapterId: binding.adapterId,
                input,
                target,
                lease: { resourceKey: target.resourceKey, ttlMs: binding.leaseTtlMs ?? Math.max(spec.timeoutMs, 60_000), owner: request.agentId },
                ctx: evCtx,
                signal,
                // a replay settles its operation; a (re-)dispatch would be a new decision on a snapshot nobody validated
                ...(replayOf !== undefined ? { reconcileOnly: true } : {}),
              }),
            timeoutMs,
            request.signal,
            `tool ${spec.id}`,
          );
          applySideEffectOutcome(stage, outcome);
        } else {
          const outcome: ToolOutcome = await withTimeout(timeoutMs, (signal) => spec.execute(input, makeCtx(signal)), request.signal, `tool ${spec.id}`);
          if (!outcome || typeof outcome !== 'object' || typeof outcome.status !== 'string') throw new HypertestError('internal', `tool ${spec.id} returned a malformed outcome`);
          stage.status = outcome.status;
          const structured = toJson(outcome.structured, `tool ${spec.id} structured output`);
          if (structured !== undefined) stage.structured = structured;
          if (outcome.text !== undefined) stage.text = String(outcome.text);
          if (outcome.error) stage.error = { code: String(outcome.error.code), message: String(outcome.error.message) };
          if (outcome.operationId !== undefined) stage.operationId = outcome.operationId;
          stage.artifactRefs = [...(outcome.artifactRefs ?? [])];
          stage.evidenceRefs = [...(outcome.evidenceRefs ?? [])];
          if (stage.status !== 'success' && stage.status !== 'pending' && !stage.error) stage.error = { code: stage.status, message: `tool reported ${stage.status}` };
        }
      } catch (e) {
        if (e instanceof HypertestError) {
          stage.status = e.code === 'timeout' ? 'timeout' : 'failed';
          stage.error = { code: e.code, message: e.message };
          if (spec.sideEffect && (e.code === 'timeout' || e.code === 'cancelled')) {
            stage.error.message += `; the external outcome is unknown: do not re-issue this action as a new call — re-running this same invocation (${request.invocationId}) reconciles it through the Operation Ledger`;
          }
        } else {
          logger.error('tool execution failed unexpectedly', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
          stage.status = 'failed';
          stage.error = { code: 'internal', message: e instanceof Error ? e.message : String(e) };
        }
      }

      // 9 output schema
      if (stage.status === 'success' && spec.outputSchema) {
        const v = compileSchema(spec.outputSchema)(stage.structured);
        if (!v.valid) {
          stage.status = 'failed';
          stage.error = { code: 'schema_violation', message: `output does not match the ${spec.id} output schema: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` };
        }
      }

      // 10 bounded model text (+ offload) and evidence refs
      stage.evidenceRefs = uniq([...stage.evidenceRefs, ...produced.map((p) => p.evidenceId)]);
      const opNote = stage.operationId ? ` (operation ${stage.operationId})` : '';
      let body = stage.status === 'success' ? '' : stage.error ? `[${stage.status}] ${stage.error.code}: ${stage.error.message}${opNote}` : `[${stage.status}]${opNote}`;
      const content = stage.text ?? (stage.structured !== undefined ? JSON.stringify(stage.structured) : '');
      if (content) body = body ? `${body}\n${content}` : content;
      const maxInline = spec.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
      let modelText: string;
      const bodyBytes = Buffer.byteLength(body, 'utf8');
      if (bodyBytes + Buffer.byteLength(evidenceLine(stage.evidenceRefs), 'utf8') <= maxInline) {
        modelText = body + evidenceLine(stage.evidenceRefs);
      } else {
        let marker: string;
        try {
          const rec = await recordEv({ evidenceType: 'tool-output', data: body, mimeType: 'text/plain', summary: `full ${spec.id} output (${bodyBytes} bytes; offloaded from the model context)` });
          stage.artifactRefs.push(rec.artifact);
          stage.evidenceRefs = uniq([...stage.evidenceRefs, rec.evidenceId]);
          marker = `\n…[output truncated: ${bodyBytes} bytes; full output artifact ${rec.artifact.uri} evidence ${rec.evidenceId}]\n`;
        } catch (e) {
          logger.error('tool output offload failed; truncating without artifact', { error: (e as Error).message });
          marker = `\n…[output truncated: ${bodyBytes} bytes; offload failed: ${(e as Error).message.slice(0, 200)}]\n`;
        }
        const evLine = evidenceLine(stage.evidenceRefs);
        const avail = Math.max(0, maxInline - Buffer.byteLength(marker, 'utf8') - Buffer.byteLength(evLine, 'utf8'));
        const headBytes = Math.min(Math.floor(maxInline / 2), avail);
        const tailBytes = Math.min(Math.floor(maxInline / 4), avail - headBytes);
        modelText = utf8Head(body, headBytes) + marker + (tailBytes > 0 ? utf8Tail(body, tailBytes) : '') + evLine;
      }

      // 11 completion event
      const done = finish(stage, modelText, permit);
      try {
        if (done.status === 'denied') {
          await emit(EVENT_TYPES.toolDenied, { toolId: spec.id, invocationId: request.invocationId, status: done.status, errorCode: done.error?.code ?? 'denied', reason: done.error?.message ?? 'denied by the tool', permitDecisionId: permit.decisionId, durationMs: done.durationMs, evidenceRefs: done.evidenceRefs });
        } else {
          const payload: Record<string, unknown> = { toolId: spec.id, invocationId: request.invocationId, status: done.status, durationMs: done.durationMs, evidenceRefs: done.evidenceRefs, artifactRefs: done.artifactRefs };
          if (done.operationId !== undefined) payload['operationId'] = done.operationId;
          if (done.error) payload['errorCode'] = done.error.code;
          await emit(EVENT_TYPES.toolCompleted, payload);
        }
      } catch (e) {
        logger.error('tool completion event could not be emitted', { error: (e as Error).message });
      }
      return done;

      function makeCtx(signal: AbortSignal): ToolContext {
        const ctx: ToolContext = {
          runId: request.runId,
          workItemId: request.workItemId,
          agentId: request.agentId,
          role: request.role,
          invocationId: request.invocationId,
          workspace: request.workspace,
          artifacts: deps.artifacts,
          recordEvidence: recordEv,
          eventContext: evCtx,
          permit,
          signal,
          logger,
          environments: deps.environments,
        };
        if (request.snapshot) ctx.snapshot = request.snapshot;
        if (deps.sideEffects) ctx.sideEffects = spec!.sideEffect ? deps.sideEffects : observeOnly(deps.sideEffects);
        return ctx;
      }
    },
  };
}

function applySideEffectOutcome(stage: Stage, outcome: SideEffectOutcome): void {
  stage.operationId = outcome.operation.operationId;
  stage.evidenceRefs = [...outcome.operation.evidenceRefs];
  switch (outcome.status) {
    case 'verified': {
      stage.status = 'success';
      const s = toJson(outcome.result, 'side-effect result');
      if (s !== undefined) stage.structured = s;
      return;
    }
    case 'pending': {
      stage.status = 'pending';
      const structured: Record<string, JsonValue> = { operationId: outcome.operation.operationId, operationStatus: outcome.operation.status };
      const progress = toJson(outcome.progress, 'side-effect progress');
      if (progress !== undefined) structured['progress'] = progress;
      stage.structured = structured;
      stage.text = `operation ${outcome.operation.operationId} is ${outcome.operation.status}; its outcome is not settled yet (observe it by operation id, do not re-issue the action)`;
      return;
    }
    default:
      stage.status = 'failed';
      stage.error = { code: outcome.status, message: outcome.reason };
      stage.structured = { operationId: outcome.operation.operationId, operationStatus: outcome.operation.status };
  }
}

/**
 * The environment a tool input addresses (`environmentId` of a registered environment) as an evidence EnvironmentRef,
 * at its generation now (the generation the tool executed against).
 */
function addressedEnvironment(input: unknown, environments: ToolRuntimeDeps['environments']): EnvironmentRef | undefined {
  const id = input !== null && typeof input === 'object' ? (input as { environmentId?: unknown }).environmentId : undefined;
  if (typeof id !== 'string' || !environments) return undefined;
  const env = environments.get(id);
  if (!env) return undefined;
  const ref: EnvironmentRef = { environmentId: env.environmentId, environmentClass: env.environmentClass, generation: env.generation };
  if (env.buildDigest !== undefined) ref.buildDigest = env.buildDigest;
  return ref;
}
