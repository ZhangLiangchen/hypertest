import { HypertestError, newId, systemClock, validateJson, type Clock } from '@hypertest/core';
import type { ActionPermit, ActionRequest, OpaPolicyEngineOptions, PermitConstraints, PolicyEngine } from './contracts.ts';
import { PERMIT_CONSTRAINTS_SCHEMA, checkCapability } from './engine.ts';

/**
 * OPA adapter (HTTP data API): POST `{url}/v1/data/{path}` with `{ input: request }` and expects
 * `{ result: { allow: boolean, approval_required?: boolean, reasons?: string[], constraints?: {...} } }`.
 * Fail closed: transport errors, timeouts, non-2xx, an undefined result or a malformed document all
 * yield `deny` with first reason `opa_unavailable`. The capability is checked locally first.
 */
export class OpaPolicyEngine implements PolicyEngine {
  readonly revision: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #newId: () => string;
  readonly #clock: Clock;
  readonly #secret: string | undefined;

  constructor(options: OpaPolicyEngineOptions) {
    if (!options.url) throw new HypertestError('invalid_argument', 'OPA url is required');
    if (!options.revision) throw new HypertestError('invalid_argument', 'policy revision is required');
    const path = (options.path ?? 'hypertest/authz').replace(/^\/+|\/+$/g, '').replace(/\./g, '/');
    // package path segments only: `..`, query strings or encoded characters could redirect to another OPA API
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) throw new HypertestError('invalid_argument', `invalid OPA decision path: ${options.path}`);
    this.#endpoint = `${options.url.replace(/\/+$/, '')}/v1/data/${path}`;
    this.#timeoutMs = options.timeoutMs ?? 2000;
    this.#fetch = options.fetch ?? fetch;
    this.#newId = options.newId ?? (() => newId('pdec'));
    this.#clock = options.clock ?? systemClock;
    this.#secret = options.capabilitySecret;
    this.revision = options.revision;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  async evaluate(request: ActionRequest): Promise<ActionPermit> {
    const decisionId = this.#newId();
    const deny = (reasons: string[]): ActionPermit => ({ decision: 'deny', decisionId, reasons, policyRevision: this.revision });
    const cap = checkCapability(request, this.#clock, this.#secret);
    if (!cap.ok) return deny([cap.reason!]);

    let doc: unknown;
    try {
      const { signature: _sig, ...capability } = request.capability;
      const res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { ...request, capability } }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return deny(['opa_unavailable', `http_status: ${res.status}`]);
      }
      doc = await res.json();
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      const detail = name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${this.#timeoutMs}ms` : e instanceof Error ? e.message : String(e);
      return deny(['opa_unavailable', detail]);
    }

    const result = (doc as { result?: unknown } | null)?.result;
    if (result === undefined || result === null || typeof result !== 'object' || Array.isArray(result)) return deny(['opa_unavailable', 'undefined decision document']);
    const r = result as Record<string, unknown>;
    if (typeof r['allow'] !== 'boolean') return deny(['opa_unavailable', 'decision document has no boolean allow']);
    if (r['approval_required'] !== undefined && typeof r['approval_required'] !== 'boolean') return deny(['opa_unavailable', 'approval_required is not boolean']);
    const reasons = Array.isArray(r['reasons']) ? (r['reasons'] as unknown[]).filter((x): x is string => typeof x === 'string').sort() : [];
    let constraints: PermitConstraints | undefined;
    if (r['constraints'] !== undefined) {
      const v = validateJson<PermitConstraints>(PERMIT_CONSTRAINTS_SCHEMA, r['constraints']);
      if (!v.valid) return deny(['opa_unavailable', 'malformed constraints']);
      constraints = v.value;
    }
    const decision: ActionPermit['decision'] = r['approval_required'] === true ? 'approval_required' : r['allow'] === true ? 'allow' : 'deny';
    const permit: ActionPermit = { decision, decisionId, reasons: reasons.length ? reasons : [`opa:${decision}`], policyRevision: this.revision };
    if (constraints && decision !== 'deny') permit.constraints = constraints;
    return permit;
  }
}
