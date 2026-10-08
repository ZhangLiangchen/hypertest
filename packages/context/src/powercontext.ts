import { HypertestError, noopLogger, type Logger } from '@hypertest/core';
import type { EventContext } from '@hypertest/domain';
import type { DurableMemory, ExperienceDecision, ExperienceItem, ExperienceStatus, PowerContextOptions } from './contracts.ts';
import { creatorActing, DECISION_STATUS, EXPERIENCE_STATUSES, RETRIEVABLE_STATUSES, scopeMatches } from './experience.ts';
import { isRecord, resolveLimit } from './util.ts';

export const POWERCONTEXT_DEFAULT_PATHS = {
  propose: '/v1/experiences',
  review: '/v1/experiences/{id}/review',
  retrieve: '/v1/context/prepare',
  list: '/v1/experiences',
} as const;

function parseItem(v: unknown, what: string): ExperienceItem {
  const raw = isRecord(v) && (isRecord(v['experience']) || isRecord(v['item'])) ? ((v['experience'] ?? v['item']) as Record<string, unknown>) : v;
  if (!isRecord(raw)) throw new HypertestError('provider_error', `PowerContext ${what}: response is not an experience object`);
  const status = raw['status'];
  if (typeof raw['experienceId'] !== 'string' || typeof status !== 'string' || !EXPERIENCE_STATUSES.includes(status as ExperienceStatus)) {
    throw new HypertestError('provider_error', `PowerContext ${what}: response lacks experienceId or a known status`);
  }
  if (typeof raw['content'] !== 'string' || typeof raw['createdBy'] !== 'string') throw new HypertestError('provider_error', `PowerContext ${what}: response lacks content/createdBy`);
  const item: ExperienceItem = {
    experienceId: raw['experienceId'],
    scope: isRecord(raw['scope']) ? (raw['scope'] as ExperienceItem['scope']) : {},
    kind: raw['kind'] as ExperienceItem['kind'],
    content: raw['content'],
    sourceRunId: typeof raw['sourceRunId'] === 'string' ? raw['sourceRunId'] : '',
    evidenceRefs: Array.isArray(raw['evidenceRefs']) ? (raw['evidenceRefs'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    status: status as ExperienceStatus,
    createdBy: raw['createdBy'],
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : '',
  };
  if (typeof raw['reviewedBy'] === 'string') item.reviewedBy = raw['reviewedBy'];
  return item;
}

function parseItems(v: unknown, what: string): ExperienceItem[] {
  const arr = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v['items']) ? v['items'] : undefined;
  if (!arr) throw new HypertestError('provider_error', `PowerContext ${what}: response has no items array`);
  return arr.map((x) => parseItem(x, what));
}

/**
 * DurableMemory over HTTP (PowerContext as an external L4 context service). Endpoint mapping (configurable via
 * `paths`): POST /v1/experiences (propose), POST /v1/experiences/{id}/review, POST /v1/context/prepare
 * ({query, scope, limit} → {items}; conceptually PowerContext's prepare_context), GET /v1/experiences?status=
 * (list). Errors: 5xx / network / timeout ⇒ `unavailable` (retryable), 429 ⇒ rate_limited, 401/403 ⇒
 * permission_denied, 404 ⇒ not_found, 409 ⇒ conflict, 412/422 ⇒ precondition_failed, other 4xx ⇒
 * invalid_argument. The timeout covers the whole exchange (a stalled body is `unavailable`, never an empty
 * answer). Invariants are re-checked client side: a self-review is refused before any request (actor ids are
 * compared trimmed and case-insensitively), a review answer must carry the requested id and decision status,
 * propose must keep createdBy, and retrieve() drops every item that is not approved/published or out of scope.
 */
export class PowerContextClient implements DurableMemory {
  readonly kind = 'powercontext' as const;
  readonly #base: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #paths: { propose: string; review: string; retrieve: string; list: string };
  readonly #logger: Logger;
  /** createdBy of items this client proposed or saw (self-review is refused without a round trip). */
  readonly #creators = new Map<string, string>();

  constructor(options: PowerContextOptions) {
    if (!options || typeof options.baseUrl !== 'string' || !/^https?:\/\//.test(options.baseUrl)) throw new HypertestError('invalid_argument', 'PowerContextClient needs an http(s) baseUrl');
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new HypertestError('invalid_argument', 'timeoutMs must be a positive number');
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#paths = { ...POWERCONTEXT_DEFAULT_PATHS, ...(options.paths ?? {}) };
    this.#logger = options.logger ?? noopLogger;
  }

  async #request(method: 'GET' | 'POST', path: string, body: unknown, what: string, ctx?: EventContext): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.#apiKey) headers['authorization'] = `Bearer ${this.#apiKey}`;
    if (ctx) {
      headers['x-hypertest-run-id'] = ctx.runId;
      headers['x-correlation-id'] = ctx.correlationId;
      // (B[4]) the calling actor (URI-encoded: a header is Latin-1): the service re-checks reviewer ≠ creator against it too
      headers['x-hypertest-actor-id'] = encodeURIComponent(ctx.actorId);
      if (ctx.agentId) headers['x-hypertest-agent-id'] = encodeURIComponent(ctx.agentId);
    }
    const ctrl = new AbortController();
    // The deadline covers the whole exchange (headers AND body): a server that answers headers and then stalls
    // must not hang the caller.
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    const failed = (e: unknown, stage: string): HypertestError => {
      const timedOut = ctrl.signal.aborted;
      return new HypertestError('unavailable', timedOut ? `PowerContext ${what} timed out after ${this.#timeoutMs}ms` : `PowerContext ${what} failed (${stage}): ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
        details: { timeout: timedOut },
      });
    };
    let res: Response;
    let text: string;
    try {
      try {
        res = await this.#fetch(this.#base + path, { method, headers, signal: ctrl.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      } catch (e) {
        throw failed(e, 'request');
      }
      try {
        text = await res.text();
      } catch (e) {
        // A truncated or stalled body is a transport fault, never an empty answer.
        throw failed(e, 'response body');
      }
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const code = res.status >= 500 ? 'unavailable'
        : res.status === 429 ? 'rate_limited'
        : res.status === 401 || res.status === 403 ? 'permission_denied'
        : res.status === 404 ? 'not_found'
        : res.status === 409 ? 'conflict'
        : res.status === 412 || res.status === 422 ? 'precondition_failed'
        : 'invalid_argument';
      this.#logger.warn('powercontext request failed', { what, status: res.status });
      throw new HypertestError(code, `PowerContext ${what} answered HTTP ${res.status}: ${text.slice(0, 300)}`, { details: { status: res.status } });
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new HypertestError('provider_error', `PowerContext ${what} returned invalid JSON`, { cause: e });
    }
  }

  #remember(item: ExperienceItem): ExperienceItem {
    this.#creators.delete(item.experienceId);
    this.#creators.set(item.experienceId, item.createdBy);
    // Bounded (oldest first): the service remains the authority for items this client has not seen recently.
    if (this.#creators.size > 10_000) this.#creators.delete(this.#creators.keys().next().value!);
    return item;
  }

  async propose(item: Omit<ExperienceItem, 'experienceId' | 'status' | 'createdAt' | 'updatedAt' | 'reviewedBy'>, ctx: EventContext): Promise<ExperienceItem> {
    if (!item || typeof item.content !== 'string' || item.content.length === 0 || typeof item.createdBy !== 'string' || item.createdBy.length === 0) {
      throw new HypertestError('invalid_argument', 'experience needs content and createdBy');
    }
    const res = parseItem(await this.#request('POST', this.#paths.propose, { ...item }, 'propose', ctx), 'propose');
    if (res.status !== 'candidate') throw new HypertestError('provider_error', `PowerContext propose returned status ${res.status}; new experience must be a candidate`);
    // The creator is what makes self-review detectable: a service that rewrites it cannot be trusted.
    if (res.createdBy !== item.createdBy) throw new HypertestError('provider_error', `PowerContext propose returned createdBy ${res.createdBy}, expected ${item.createdBy}`);
    return this.#remember(res);
  }

  async review(experienceId: string, decision: ExperienceDecision, reviewer: string, ctx: EventContext): Promise<ExperienceItem> {
    if (typeof reviewer !== 'string' || reviewer.length === 0) throw new HypertestError('invalid_argument', 'reviewer must be a non-empty string');
    if (!DECISION_STATUS[decision]) throw new HypertestError('invalid_argument', `unknown review decision ${String(decision)}`);
    const creator = this.#creators.get(experienceId);
    const self = creator !== undefined ? creatorActing(creator, reviewer, ctx) : undefined;
    if (self !== undefined) {
      throw new HypertestError('permission_denied', `experience ${experienceId} cannot be reviewed by its creator ${self}`);
    }
    const path = this.#paths.review.replace('{id}', encodeURIComponent(experienceId));
    const res = parseItem(await this.#request('POST', path, { decision, reviewer }, 'review', ctx), 'review');
    const accepted = creatorActing(res.createdBy, reviewer, ctx);
    if (accepted !== undefined) {
      // The service accepted a self-review: never treat it as valid.
      throw new HypertestError('integrity_violation', `PowerContext accepted a self-review of ${experienceId} by ${accepted}`);
    }
    // The answer must be the decision that was asked for, on the item that was asked for.
    const expected = DECISION_STATUS[decision];
    if (res.experienceId !== experienceId || res.status !== expected) {
      throw new HypertestError('provider_error', `PowerContext review of ${experienceId} (${decision}) returned ${res.experienceId} with status ${res.status}, expected ${expected}`, {
        details: { experienceId, decision, returnedId: res.experienceId, returnedStatus: res.status },
      });
    }
    return this.#remember(res);
  }

  async retrieve(query: { text: string; scope?: ExperienceItem['scope']; limit?: number }): Promise<ExperienceItem[]> {
    const body = { query: query.text, scope: query.scope ?? {}, limit: resolveLimit(query.limit, 10) };
    const items = parseItems(await this.#request('POST', this.#paths.retrieve, body, 'retrieve'), 'retrieve');
    const allowed = items.filter((it) => RETRIEVABLE_STATUSES.includes(it.status));
    if (allowed.length !== items.length) {
      this.#logger.warn('powercontext returned non-approved experience; dropped', { dropped: items.filter((it) => !allowed.includes(it)).map((it) => `${it.experienceId}:${it.status}`) });
    }
    // Scope is re-checked client side too (same rule as the SQL store): another project's knowledge never leaks in.
    const inScope = allowed.filter((it) => scopeMatches(it.scope, query.scope));
    if (inScope.length !== allowed.length) {
      this.#logger.warn('powercontext returned out-of-scope experience; dropped', { dropped: allowed.filter((it) => !inScope.includes(it)).map((it) => it.experienceId) });
    }
    return inScope.slice(0, body.limit).map((it) => this.#remember(it));
  }

  async list(filter: { status?: ExperienceStatus[]; sourceRunId?: string }): Promise<ExperienceItem[]> {
    const qs = new URLSearchParams();
    if (filter?.status && filter.status.length > 0) qs.set('status', filter.status.join(','));
    if (filter?.sourceRunId !== undefined) qs.set('sourceRunId', filter.sourceRunId);
    const q = qs.toString();
    const items = parseItems(await this.#request('GET', this.#paths.list + (q ? `?${q}` : ''), undefined, 'list'), 'list');
    // The filter is applied client side as well: a service that ignores a query parameter cannot widen the list.
    return items
      .filter((it) => (!filter?.status || filter.status.length === 0 || filter.status.includes(it.status)) && (filter?.sourceRunId === undefined || it.sourceRunId === filter.sourceRunId))
      .map((it) => this.#remember(it));
  }
}
