import { HypertestError, hashCanonical, type JsonValue } from '@hypertest/core';
import type { DispatchReceipt, ObservationResult, OperationContext, PreparedOperation, SideEffectAdapter, SideEffectCapabilities, VerificationResult } from '@hypertest/operation';

/**
 * Generic "record-only" SideEffectAdapters (conformance-7, I4): tools whose computed effect is `external` or
 * `destructive` but that have no SideEffectAdapter of their own — `http.request` with a non-idempotent method,
 * `browser.click`/`browser.fill`, `mcp.*` — run through `SideEffectGateway.run` keyed by the tool invocation id. The
 * operation IS the tool call:
 *   dispatch  = execute the tool once (the ToolRuntime binds the executor for the invocation in this process); its
 *               ToolOutcome becomes the verified `result` (ht_operations.result). The receipt persisted with
 *               `acknowledged` is COMPACT (status, error code, evidence ids, digest of the outcome — it travels in the
 *               L0 `operation.acknowledged` event): a crash between acknowledgement and verification recovers the
 *               outcome's status and evidence from it (the full response is in that evidence), never re-sending;
 *   observe   = the in-process outcome, else the receipt; a replay of a verified call returns the recorded result
 *               without executing again, so a durable retry never re-sends;
 *   unknown   = a crash or an abort between sending and recording: the effect may have happened and nothing can be
 *               asked. `tool.effect` answers `uncertain` ⇒ manual_review (never a blind resend).
 *               `tool.effect.resendable` (a target that deduplicates a resend of this invocation, e.g. an environment
 *               declaring `honoursIdempotencyKey` and a request carrying `Idempotency-Key: <invocationId>`) answers
 *               `absent` ⇒ not_applied ⇒ the gateway's single safe re-dispatch re-sends once (the target dedupes).
 * No executor bound for the invocation at dispatch (its caller is gone) ⇒ `not_applied`: nothing was sent.
 */
export const RECORD_EFFECT_ADAPTER_ID = 'tool.effect';
export const RECORD_EFFECT_RESENDABLE_ADAPTER_ID = 'tool.effect.resendable';

/** The JSON form of a ToolOutcome recorded as the operation's receipt/result. */
export type RecordedToolOutcome = { status: string } & Record<string, JsonValue>;

interface Binding {
  execute(signal: AbortSignal, operationId: string): Promise<RecordedToolOutcome>;
  outcome?: RecordedToolOutcome;
}

/** Executors of tool invocations in flight in THIS process (a restarted process has none: it cannot act blindly). */
const bindings = new Map<string, Binding[]>();
const keyOf = (runId: string, toolInvocationId: string): string => `${runId}\u0000${toolInvocationId}`;

/**
 * Binds the executor of one tool invocation for the duration of the gateway call; returns the unbind function.
 * Several concurrent callers of the same invocation (duplicate delivery) share the gateway's single-flight drive; the
 * first bound executor dispatches.
 */
export function bindRecordEffect(runId: string, toolInvocationId: string, execute: Binding['execute']): () => void {
  const key = keyOf(runId, toolInvocationId);
  const binding: Binding = { execute };
  const list = bindings.get(key) ?? [];
  list.push(binding);
  bindings.set(key, list);
  return () => {
    const cur = bindings.get(key);
    if (!cur) return;
    const i = cur.indexOf(binding);
    if (i >= 0) cur.splice(i, 1);
    if (cur.length === 0) bindings.delete(key);
  };
}

function bindingFor(op: OperationContext): Binding | undefined {
  const inv = op.operation.toolInvocationId;
  return inv === undefined ? undefined : bindings.get(keyOf(op.operation.runId, inv))?.[0];
}

const MAX_RECEIPT_EVIDENCE = 50;

/** The compact receipt of a recorded tool call (bounded: it is part of the operation's L0 event). */
function compactReceipt(outcome: RecordedToolOutcome): string {
  const r: Record<string, JsonValue> = { v: 1, status: outcome.status, digest: hashCanonical(outcome) };
  const err = outcome['error'] as { code?: unknown } | undefined;
  if (err && typeof err === 'object' && typeof err.code === 'string') r['errorCode'] = err.code.slice(0, 100);
  if (typeof outcome['operationId'] === 'string') r['operationId'] = outcome['operationId'];
  const evidence = Array.isArray(outcome['evidenceRefs']) ? (outcome['evidenceRefs'] as JsonValue[]).filter((x): x is string => typeof x === 'string') : [];
  r['evidenceRefs'] = evidence.slice(0, MAX_RECEIPT_EVIDENCE);
  return JSON.stringify(r);
}

/** The outcome recoverable from a receipt alone (after a crash between acknowledgement and verification). */
function fromReceipt(receipt: string | undefined): RecordedToolOutcome | undefined {
  if (receipt === undefined) return undefined;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(receipt) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== 'object' || v['v'] !== 1 || typeof v['status'] !== 'string') return undefined;
  const evidenceRefs = Array.isArray(v['evidenceRefs']) ? (v['evidenceRefs'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const out: RecordedToolOutcome = {
    status: v['status'],
    evidenceRefs,
    artifactRefs: [],
    text: `(recovered after an interruption between the call and its recording: the call completed with status ${v['status']}; its full response is in the evidence${evidenceRefs.length ? ` ${evidenceRefs.join(', ')}` : ''}. It was not sent again.)`,
    recoveredFromReceipt: true,
  };
  if (typeof v['errorCode'] === 'string') out['error'] = { code: v['errorCode'], message: `the call reported ${v['errorCode']} (recovered from its receipt)` };
  if (typeof v['operationId'] === 'string') out['operationId'] = v['operationId'];
  return out;
}

class RecordEffectAdapter implements SideEffectAdapter<unknown, RecordedToolOutcome> {
  readonly adapterId: string;
  readonly capabilities: SideEffectCapabilities;
  readonly #resendable: boolean;

  constructor(resendable: boolean) {
    this.#resendable = resendable;
    this.adapterId = resendable ? RECORD_EFFECT_RESENDABLE_ADAPTER_ID : RECORD_EFFECT_ADAPTER_ID;
    this.capabilities = resendable
      ? // "lookup" = the recorded outcome, else a resend the target deduplicates (native idempotency of the target)
        { supportsNativeIdempotency: true, supportsExternalLookupByOperationId: true, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'best_effort', riskClass: 'medium' }
      : { supportsNativeIdempotency: false, supportsExternalLookupByOperationId: false, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'non_reconcilable', riskClass: 'high' };
  }

  async prepare(op: OperationContext, input: unknown): Promise<PreparedOperation> {
    return { desiredState: null, desiredStateHash: hashCanonical({ tool: op.operation.operationType, input: input === undefined ? null : (input as JsonValue) }), target: op.operation.target };
  }

  async dispatch(_prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const binding = bindingFor(op);
    if (!binding) return { accepted: false, notAppliedReason: `no caller is executing tool invocation ${op.operation.toolInvocationId ?? '(none)'} in this process: nothing was sent` };
    const outcome = await binding.execute(op.signal, op.operation.operationId);
    binding.outcome = outcome;
    return { accepted: true, receipt: compactReceipt(outcome) };
  }

  async observe(op: OperationContext): Promise<ObservationResult<RecordedToolOutcome>> {
    const recorded = bindingFor(op)?.outcome ?? fromReceipt(op.operation.externalReceipt);
    if (recorded) return { state: 'present', observation: recorded };
    if (this.#resendable) return { state: 'absent' };
    return { state: 'uncertain', detail: `the outcome of ${op.operation.operationType} (invocation ${op.operation.toolInvocationId ?? '?'}) was never recorded — the call was interrupted between sending and recording it — and the target cannot be asked whether it applied` };
  }

  async verify(observation: RecordedToolOutcome): Promise<VerificationResult> {
    if (!observation || typeof observation.status !== 'string') throw new HypertestError('schema_violation', 'malformed recorded tool outcome');
    return { status: 'verified', result: observation };
  }
}

/** The two record-only adapters (register both with the gateway; `builtinSideEffectAdapters` includes them). */
export function recordEffectAdapters(): SideEffectAdapter[] {
  return [new RecordEffectAdapter(false), new RecordEffectAdapter(true)];
}
