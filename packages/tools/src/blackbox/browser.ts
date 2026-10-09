import { HypertestError, abortReason, isHypertestError, sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EnvironmentRef, EvidenceRecord } from '@hypertest/domain';
import type { Browser, BrowserContext, Page, Route, WebSocketRoute } from 'playwright-core';
import type { EnvironmentDescriptor, ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import {
  ENV_ID_SCHEMA, checkEgress, environmentForUrl, environmentOrigins, errorMessage, isTextualContentType, redactHeaders, redactUrl, requireEnvironment, storableText,
} from './common.ts';
import { resolveTarget, targetEnvironmentClass, targetResources } from './http.ts';

/**
 * Browser tools (Playwright over playwright-core + a local Chromium). DOM/API tools come first; these are
 * the fallback path for behaviour only observable in a real browser. One BrowserContext per
 * (runId, agentId), pages per `sessionId`, closed after an idle timeout.
 *
 * Egress guard: checking only the URL handed to browser.navigate is not enough — redirects, link clicks,
 * form posts, popups, scripts and subresources can reach any host. Every context therefore routes ALL
 * requests (and WebSockets) through the egress guard of the session's last browser.navigate (permit
 * allowedHosts, environment origins, httpAllowlist, loopback-for-local, never supervisor control
 * endpoints); anything else is aborted (`blockedbyclient`) and reported. A context without a guard (no
 * navigate yet) sends nothing (fail closed).
 */

/** Why a URL may not be requested by the page (undefined = allowed). */
export type BrowserEgressGuard = (url: URL) => string | undefined;

export interface BlockedRequest {
  url: string;
  reason: string;
}

const MAX_BLOCKED_RECORDED = 50;

export const DEFAULT_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const MAX_TEXT_BYTES = 64 * 1024;

type AriaRole = Parameters<Page['getByRole']>[0];

export interface BrowserManagerOptions {
  chromiumPath?: string;
  idleTimeoutMs?: number;
  launchTimeoutMs?: number;
  /** Extra Chromium args (`--no-sandbox` is added automatically when running as root). */
  args?: string[];
}

interface Session {
  context: BrowserContext;
  pages: Map<string, Page>;
  timer?: NodeJS.Timeout;
  guard?: BrowserEgressGuard;
  blocked: BlockedRequest[];
}

/** Egress decision for one request URL under a session guard (http(s)/ws(s) are checked; data/blob/about pass). */
function blockReason(guard: BrowserEgressGuard | undefined, raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unparseable request URL';
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return undefined;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') url = new URL(`${url.protocol === 'wss:' ? 'https:' : 'http:'}${url.href.slice(url.protocol.length)}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `scheme ${url.protocol} is not allowed`;
  if (!guard) return 'no egress policy for this browser session (call browser.navigate first)';
  return guard(url);
}

/** Resolves the Chromium executable: option → HYPERTEST_CHROMIUM_PATH → /opt/pw-browsers/chromium. */
export function chromiumExecutablePath(explicit?: string): string {
  return explicit ?? process.env['HYPERTEST_CHROMIUM_PATH'] ?? DEFAULT_CHROMIUM_PATH;
}

export class BrowserSessionManager {
  readonly #o: BrowserManagerOptions;
  #browser: Promise<Browser> | undefined;
  readonly #sessions = new Map<string, Promise<Session>>();

  constructor(options: BrowserManagerOptions = {}) {
    this.#o = options;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  #launch(): Promise<Browser> {
    if (!this.#browser) {
      const attempt = (async () => {
        const { chromium } = await import('playwright-core');
        const args = [...(this.#o.args ?? [])];
        if (typeof process.getuid === 'function' && process.getuid() === 0 && !args.includes('--no-sandbox')) args.push('--no-sandbox');
        return chromium.launch({ executablePath: chromiumExecutablePath(this.#o.chromiumPath), headless: true, args, timeout: this.#o.launchTimeoutMs ?? 30_000 });
      })();
      this.#browser = attempt;
      attempt.then(
        (b) => b.on('disconnected', () => {
          if (this.#browser === attempt) this.#browser = undefined;
          this.#sessions.clear();
        }),
        () => {
          if (this.#browser === attempt) this.#browser = undefined;
        },
      );
    }
    return this.#browser;
  }

  #touch(key: string, session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => void this.#closeKey(key), this.#o.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    session.timer.unref();
  }

  async #closeKey(key: string): Promise<void> {
    const pending = this.#sessions.get(key);
    if (!pending) return;
    this.#sessions.delete(key);
    try {
      const s = await pending;
      if (s.timer) clearTimeout(s.timer);
      await s.context.close();
    } catch {
      // already gone
    }
    if (this.#sessions.size === 0) await this.#closeBrowser();
  }

  async #closeBrowser(): Promise<void> {
    const b = this.#browser;
    this.#browser = undefined;
    if (!b) return;
    try {
      await (await b).close();
    } catch {
      // launch failed or already closed
    }
  }

  #block(session: Session, url: string, reason: string): void {
    if (session.blocked.length < MAX_BLOCKED_RECORDED) session.blocked.push({ url: url.slice(0, 500), reason });
  }

  /**
   * The page of (runId, agentId, sessionId); creates the context/page on first use. `guard` (set by
   * browser.navigate) becomes the session's egress policy for every later request of the context.
   */
  async page(runId: string, agentId: string, sessionId = 'default', guard?: BrowserEgressGuard): Promise<Page> {
    const key = `${runId}\u0000${agentId}`;
    let pending = this.#sessions.get(key);
    if (!pending) {
      pending = (async () => {
        const browser = await this.#launch();
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
        const session: Session = { context, pages: new Map<string, Page>(), blocked: [] };
        try {
          await context.route('**/*', (route: Route) => {
            const raw = route.request().url();
            const reason = blockReason(session.guard, raw);
            if (reason === undefined) return route.continue().catch(() => undefined);
            this.#block(session, raw, reason);
            return route.abort('blockedbyclient').catch(() => undefined);
          });
          await context.routeWebSocket(/.*/, (ws: WebSocketRoute) => {
            const reason = blockReason(session.guard, ws.url());
            if (reason === undefined) {
              ws.connectToServer();
              return;
            }
            this.#block(session, ws.url(), reason);
            return ws.close({ code: 1008, reason: 'blocked by the hypertest egress guard' }).catch(() => undefined);
          });
        } catch (e) {
          await context.close().catch(() => undefined);
          throw e;
        }
        return session;
      })();
      this.#sessions.set(key, pending);
      pending.catch(() => this.#sessions.delete(key));
    }
    const session = await pending;
    if (guard) session.guard = guard;
    this.#touch(key, session);
    let page = session.pages.get(sessionId);
    if (!page || page.isClosed()) {
      page = await session.context.newPage();
      session.pages.set(sessionId, page);
    }
    return page;
  }

  /** The existing page (no creation); undefined when the session has not navigated yet. */
  async existingPage(runId: string, agentId: string, sessionId = 'default'): Promise<Page | undefined> {
    const pending = this.#sessions.get(`${runId}\u0000${agentId}`);
    if (!pending) return undefined;
    const session = await pending;
    this.#touch(`${runId}\u0000${agentId}`, session);
    const page = session.pages.get(sessionId);
    return page && !page.isClosed() ? page : undefined;
  }

  /** Requests the egress guard refused since the last call (and clears the list). */
  async drainBlocked(runId: string, agentId: string): Promise<BlockedRequest[]> {
    const pending = this.#sessions.get(`${runId}\u0000${agentId}`);
    if (!pending) return [];
    const session = await pending.catch(() => undefined);
    if (!session) return [];
    return session.blocked.splice(0, session.blocked.length);
  }

  closeSession(runId: string, agentId: string): Promise<void> {
    return this.#closeKey(`${runId}\u0000${agentId}`);
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.#sessions.keys()]) await this.#closeKey(key);
    await this.#closeBrowser();
  }
}

/** Process-wide default manager used by browserTools() unless one is injected. */
export const defaultBrowserManager = new BrowserSessionManager();
/** Managers created by browserTools() itself (closed by closeBrowserManagers()). */
const ownedManagers = new Set<BrowserSessionManager>([defaultBrowserManager]);

/** Closes every browser session/browser opened by managers that browserTools() created. */
export async function closeBrowserManagers(): Promise<void> {
  for (const m of ownedManagers) await m.closeAll();
}

export interface BrowserToolOptions {
  chromiumPath?: string;
  httpAllowlist?: string[];
  manager?: BrowserSessionManager;
}

const SESSION_SCHEMA: JsonSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };

function failure(e: unknown, ctx: ToolContext, what: string): ToolOutcome {
  if (ctx.signal.aborted) throw abortReason(ctx.signal);
  if (isHypertestError(e)) return { status: 'failed', error: { code: e.code, message: e.message } };
  const err = e as Error;
  if (err?.name === 'TimeoutError') return { status: 'timeout', error: { code: 'timeout', message: `${what}: ${err.message.split('\n')[0]}` } };
  const msg = errorMessage(e).split('\n')[0] ?? 'browser error';
  if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(msg)) return { status: 'failed', error: { code: 'unavailable', message: `browser unavailable: ${msg}` } };
  return { status: 'failed', error: { code: 'unavailable', message: `${what}: ${msg}` } };
}

/** Adds the requests the egress guard refused during an interaction to its result (bounded). */
function withBlocked(outcome: ToolOutcome, blocked: BlockedRequest[]): ToolOutcome {
  if (blocked.length === 0) return outcome;
  const structured = { ...(outcome.structured as Record<string, JsonValue>), blockedRequests: blocked.slice(0, 5) as unknown as JsonValue };
  return { ...outcome, structured, text: `${JSON.stringify(structured)}\n[egress guard refused ${blocked.length} request(s) off the allowlist; the page did not leave it]` };
}

/**
 * (review) The origins browser.navigate ADMITTED for a page: those of the resource its capability was checked on (the
 * addressed environment's origins, or the URL's own origin) plus the page's origin when the load finished. A read that
 * names no environment (browser.text / browser.screenshot) is a read of what navigate admitted — and nothing else: a page
 * an interaction moved to another origin (a link to another environment the session's egress policy lets through) is
 * read only by naming its environment, whose `env/<id>` the capability then covers (or refuses).
 */
const admittedOrigins = new WeakMap<Page, Set<string>>();

function pageOrigin(page: Page): string {
  try {
    return new URL(page.url()).origin;
  } catch {
    return 'null';
  }
}

/** (review) A read without environmentId: the page must still be on an origin browser.navigate admitted. */
function assertAdmitted(page: Page, environmentId: string | undefined): void {
  if (environmentId !== undefined) return;
  const origin = pageOrigin(page);
  if (admittedOrigins.get(page)?.has(origin) === true) return;
  throw new HypertestError('permission_denied', `the page is on ${origin}, which browser.navigate did not admit (an interaction moved it there): name the environment it is on (environmentId) or navigate to it`);
}

/** When an environmentId is given, the page must currently be on one of that environment's origins. */
function assertOnEnvironment(page: Page, environmentId: string | undefined, ctx: ToolContext): void {
  if (environmentId === undefined) return;
  const env = requireEnvironment(ctx.environments, environmentId);
  let origin: string;
  try {
    origin = new URL(page.url()).origin;
  } catch {
    origin = 'null';
  }
  if (!environmentOrigins(env).includes(origin)) throw new HypertestError('permission_denied', `the page is on ${origin}, not on environment ${environmentId}`);
}

/**
 * (e2e[1]) Resource keys of a session tool: the environment the call names (`env/<id>`, the page must be on it) — the
 * scope every black-box role's grant covers (`env/**`). The browser session itself is the calling agent's own (keyed by
 * run + agent, never shared), not a governed resource: a read without environmentId touches nothing beyond the page
 * browser.navigate already admitted (capability, policy, egress guard; (review) enforced: `assertAdmitted`), and an
 * interaction (click/fill, an external effect) must name its environment — so it is classified, claimed and ledgered on it.
 */
function sessionResource(input: { environmentId?: string }): string[] {
  return input.environmentId !== undefined ? [`env/${input.environmentId}`] : [];
}

/**
 * (e2e[1]) The registered environment the page is on (evidence provenance): the environment the call names when the page
 * is on it, else the one environment serving the page's origin; undefined otherwise.
 */
function pageEnvironment(page: Page, ctx: ToolContext, named?: string): EnvironmentRef | undefined {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return undefined;
  }
  const preferred = named !== undefined ? ctx.environments.get(named) : undefined;
  const env = preferred && environmentOrigins(preferred).includes(url.origin) ? preferred : environmentForUrl(url, ctx.environments);
  if (!env) return undefined;
  const ref: EnvironmentRef = { environmentId: env.environmentId, environmentClass: env.environmentClass, generation: env.generation };
  if (env.buildDigest !== undefined) ref.buildDigest = env.buildDigest;
  return ref;
}

/** The path an oracle names (`http_expectation.path`): below the environment's baseUrl path prefix, never the query. */
function environmentRelativePath(url: URL, env: EnvironmentDescriptor | undefined): string {
  const prefix = env?.baseUrl ? new URL(env.baseUrl).pathname.replace(/\/+$/, '') : '';
  return prefix !== '' && url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname;
}

/** Bytes of a navigation's response body kept inline in the evidence `structured` payload (the artifact holds it all). */
const NAVIGATION_EVIDENCE_BODY_LIMIT = 256 * 1024;

/**
 * (e2e[1]) Records the page load of browser.navigate as `api-response` evidence — the HTTP exchange the browser made for the
 * document (final response after redirects: method, environment-relative path, status, redacted headers, body), the page
 * title and the redirect chain — anchored to the environment the page is on. Like http.request evidence it can satisfy or
 * violate an oracle's http_expectation.
 */
async function recordNavigation(ctx: ToolContext, page: Page, response: Awaited<ReturnType<Page['goto']>>, sessionId: string, title: string, named?: string): Promise<EvidenceRecord> {
  const scrub = (t: string): string => (ctx.secrets ? ctx.secrets.redact(t) : t);
  const finalUrl = new URL(response?.url() ?? page.url());
  let bytes: Uint8Array | undefined;
  if (response) {
    try {
      bytes = new Uint8Array(await response.body());
    } catch {
      bytes = undefined;
    }
  }
  const headers = response ? Object.fromEntries(Object.entries(redactHeaders(response.headers())).map(([k, v]) => [k, scrub(v)])) : {};
  const contentType = headers['content-type'] ?? 'text/html';
  if (bytes === undefined) bytes = new Uint8Array(Buffer.from(await page.content(), 'utf8'));
  const textual = isTextualContentType(contentType);
  let bodyText: string | null = null;
  if (textual) {
    const full = scrub(Buffer.from(bytes).toString('utf8'));
    bytes = new Uint8Array(Buffer.from(full, 'utf8'));
    const cut = Buffer.from(full, 'utf8');
    bodyText = storableText(cut.byteLength > NAVIGATION_EVIDENCE_BODY_LIMIT ? cut.subarray(0, NAVIGATION_EVIDENCE_BODY_LIMIT).toString('utf8') : full);
  }
  const redirectedFrom: string[] = [];
  let prior = response?.request().redirectedFrom() ?? null;
  while (prior && redirectedFrom.length < 10) {
    try {
      redirectedFrom.unshift(redactUrl(new URL(prior.url())));
    } catch {
      redirectedFrom.unshift('unparseable');
    }
    prior = prior.redirectedFrom();
  }
  const env = pageEnvironment(page, ctx, named);
  const owner = env ? ctx.environments.get(env.environmentId) : undefined;
  const status = response?.status() ?? null;
  const structured = {
    via: 'browser.navigate',
    request: { method: response?.request().method() ?? 'GET', url: redactUrl(finalUrl), path: environmentRelativePath(finalUrl, owner) },
    response: response
      ? { status, statusText: response.statusText(), headers, body: bodyText, bodyBytes: bytes.byteLength, bodyEncoding: textual ? 'utf-8' : 'binary', bodySha256: sha256Hex(bytes) }
      : null,
    page: { url: redactUrl(finalUrl), title: scrub(title) },
    redirectedFrom,
    sessionId,
  };
  return ctx.recordEvidence({
    evidenceType: 'api-response',
    data: bytes,
    mimeType: contentType,
    summary: `browser GET ${redactUrl(finalUrl)} → ${status ?? 'no response'}${title ? ` (${scrub(title)})` : ''}`.slice(0, 500),
    structured: JSON.parse(JSON.stringify(structured)) as JsonValue,
    provenance: { target: `GET ${redactUrl(finalUrl)}` },
    ...(env ? { environment: env } : {}),
  });
}

export interface BrowserNavigateInput {
  url?: string;
  environmentId?: string;
  path?: string;
  sessionId?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  timeoutMs?: number;
}

export function browserTools(options: BrowserToolOptions = {}): ToolSpec[] {
  let manager = options.manager ?? defaultBrowserManager;
  if (!options.manager && options.chromiumPath !== undefined) {
    manager = new BrowserSessionManager({ chromiumPath: options.chromiumPath });
    ownedManagers.add(manager);
  }
  const allow = options.httpAllowlist;

  const navigate: ToolSpec<BrowserNavigateInput> = {
    id: 'browser.navigate',
    title: 'Browser: navigate',
    description: 'Open a URL (or environmentId + path) in this agent\'s browser session (Playwright/Chromium). Prefer http.request for APIs; use the browser only for UI behaviour.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 8192 },
        environmentId: ENV_ID_SCHEMA,
        path: { type: 'string', maxLength: 8192, pattern: '^/(?!/)' },
        sessionId: SESSION_SCHEMA,
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
      allOf: [{ anyOf: [{ required: ['url'] }, { required: ['environmentId'] }] }, { not: { required: ['url', 'environmentId'] } }, { not: { required: ['url', 'path'] } }],
    },
    effect: 'read',
    riskClass: 'low',
    resources: (input, ctx) => targetResources(input, ctx.environments),
    environmentClass: (input, ctx) => targetEnvironmentClass(input, ctx.environments),
    // (e2e[1]) the page load is recorded as api-response evidence (the document exchange)
    evidenceTypes: ['api-response'],
    timeoutMs: 120_000,
    async execute(input, ctx) {
      try {
        const target = resolveTarget(input, ctx.environments);
        const hostCheck = { allowlist: allow, permitHosts: ctx.permit.constraints?.allowedHosts, environmentClass: target.environmentClass, trustedOrigins: target.trustedOrigins };
        const envs = ctx.environments;
        const guard: BrowserEgressGuard = (url) => {
          const c = checkEgress(url, hostCheck, envs);
          return c.allowed ? undefined : c.reason;
        };
        const refused = guard(target.url);
        if (refused !== undefined) return { status: 'failed', error: { code: 'permission_denied', message: refused } };
        const page = await manager.page(ctx.runId, ctx.agentId, input.sessionId, guard);
        await manager.drainBlocked(ctx.runId, ctx.agentId);
        let response: Awaited<ReturnType<Page['goto']>>;
        try {
          response = await page.goto(target.url.href, { waitUntil: input.waitUntil ?? 'load', timeout: input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS * 2 });
        } catch (e) {
          const blocked = await manager.drainBlocked(ctx.runId, ctx.agentId);
          if (blocked.length > 0 && /ERR_BLOCKED_BY_CLIENT/.test(errorMessage(e))) {
            return { status: 'failed', error: { code: 'permission_denied', message: `navigation was redirected off the allowlist: ${blocked[0]!.reason} (${blocked[0]!.url})` } };
          }
          throw e;
        }
        const finalUrl = new URL(page.url());
        const after = guard(finalUrl);
        if (after !== undefined) {
          await page.goto('about:blank').catch(() => undefined);
          return { status: 'failed', error: { code: 'permission_denied', message: `navigation was redirected off the allowlist: ${after}` } };
        }
        const blocked = await manager.drainBlocked(ctx.runId, ctx.agentId);
        // (review) what this navigation admitted: the checked resource's origins and where the load ended
        admittedOrigins.set(page, new Set([...(target.trustedOrigins.length > 0 ? target.trustedOrigins : [target.url.origin]), finalUrl.origin]));
        const title = await page.title();
        const sessionId = input.sessionId ?? 'default';
        // (e2e[1]) the page load is evidence: what the browser received for the document, anchored to its environment
        const evidence = await recordNavigation(ctx, page, response, sessionId, title, input.environmentId);
        const structured: Record<string, unknown> = { url: finalUrl.href, status: response?.status() ?? null, title, sessionId, evidenceId: evidence.evidenceId };
        if (blocked.length > 0) structured['blockedRequests'] = blocked.slice(0, 5);
        return { status: 'success', structured: structured as JsonValue, evidenceRefs: [evidence.evidenceId] };
      } catch (e) {
        return failure(e, ctx, 'navigate');
      }
    },
  };

  const click: ToolSpec<{ selector?: string; role?: string; name?: string; sessionId?: string; environmentId: string; timeoutMs?: number }> = {
    id: 'browser.click',
    title: 'Browser: click',
    description: 'Click an element by CSS/text selector, or by ARIA role + accessible name. environmentId is required: the environment the page is on (the click changes it; it is refused when the page is elsewhere).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1, maxLength: 2048 },
        role: { type: 'string', minLength: 1, maxLength: 64 },
        name: { type: 'string', maxLength: 1024 },
        sessionId: SESSION_SCHEMA,
        environmentId: ENV_ID_SCHEMA,
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
      required: ['environmentId'],
      anyOf: [{ required: ['selector'] }, { required: ['role'] }],
      not: { required: ['selector', 'role'] },
    },
    effect: 'external',
    riskClass: 'medium',
    resources: (input) => sessionResource(input),
    environmentClass: (input, ctx) => (input.environmentId !== undefined ? requireEnvironment(ctx.environments, input.environmentId).environmentClass : undefined),
    evidenceTypes: [],
    timeoutMs: 120_000,
    async execute(input, ctx) {
      try {
        const page = await manager.existingPage(ctx.runId, ctx.agentId, input.sessionId);
        if (!page) return { status: 'failed', error: { code: 'precondition_failed', message: 'no page in this session; call browser.navigate first' } };
        assertOnEnvironment(page, input.environmentId, ctx);
        await manager.drainBlocked(ctx.runId, ctx.agentId);
        const locator = input.selector !== undefined ? page.locator(input.selector) : page.getByRole(input.role as AriaRole, input.name !== undefined ? { name: input.name } : {});
        await locator.first().click({ timeout: input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
        await page.waitForLoadState('domcontentloaded', { timeout: input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS }).catch(() => undefined);
        return withBlocked({ status: 'success', structured: { url: page.url(), title: await page.title() } }, await manager.drainBlocked(ctx.runId, ctx.agentId));
      } catch (e) {
        return failure(e, ctx, 'click');
      }
    },
  };

  const fill: ToolSpec<{ selector: string; value: string; sessionId?: string; environmentId: string; timeoutMs?: number }> = {
    id: 'browser.fill',
    title: 'Browser: fill',
    description: 'Fill an input/textarea matched by selector with a value. environmentId is required: the environment the page is on (refused when the page is elsewhere).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1, maxLength: 2048 },
        value: { type: 'string', maxLength: 100_000 },
        sessionId: SESSION_SCHEMA,
        environmentId: ENV_ID_SCHEMA,
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
      required: ['selector', 'value', 'environmentId'],
    },
    effect: 'external',
    riskClass: 'medium',
    resources: (input) => sessionResource(input),
    environmentClass: (input, ctx) => (input.environmentId !== undefined ? requireEnvironment(ctx.environments, input.environmentId).environmentClass : undefined),
    evidenceTypes: [],
    timeoutMs: 120_000,
    async execute(input, ctx) {
      try {
        const page = await manager.existingPage(ctx.runId, ctx.agentId, input.sessionId);
        if (!page) return { status: 'failed', error: { code: 'precondition_failed', message: 'no page in this session; call browser.navigate first' } };
        assertOnEnvironment(page, input.environmentId, ctx);
        await manager.drainBlocked(ctx.runId, ctx.agentId);
        await page.locator(input.selector).first().fill(input.value, { timeout: input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
        return withBlocked({ status: 'success', structured: { url: page.url(), selector: input.selector } }, await manager.drainBlocked(ctx.runId, ctx.agentId));
      } catch (e) {
        return failure(e, ctx, 'fill');
      }
    },
  };

  const text: ToolSpec<{ selector?: string; sessionId?: string; environmentId?: string; timeoutMs?: number }> = {
    id: 'browser.text',
    title: 'Browser: read text',
    description: 'Visible text of the element matched by selector (default: the whole page body), recorded as dom-snapshot evidence (cite it for DOM checks). Optional environmentId: the page must be on it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { selector: { type: 'string', minLength: 1, maxLength: 2048 }, sessionId: SESSION_SCHEMA, environmentId: ENV_ID_SCHEMA, timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 } },
    },
    effect: 'read',
    riskClass: 'low',
    resources: (input) => sessionResource(input),
    environmentClass: (input, ctx) => (input.environmentId !== undefined ? requireEnvironment(ctx.environments, input.environmentId).environmentClass : undefined),
    // (e2e[1]) a DOM check's evidence: the exact rendered text the agent read
    evidenceTypes: ['dom-snapshot'],
    timeoutMs: 60_000,
    async execute(input, ctx) {
      try {
        const page = await manager.existingPage(ctx.runId, ctx.agentId, input.sessionId);
        if (!page) return { status: 'failed', error: { code: 'precondition_failed', message: 'no page in this session; call browser.navigate first' } };
        assertOnEnvironment(page, input.environmentId, ctx);
        assertAdmitted(page, input.environmentId);
        const selector = input.selector ?? 'body';
        const content = await page.locator(selector).first().innerText({ timeout: input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
        const scrubbed = ctx.secrets ? ctx.secrets.redact(content) : content;
        const buf = Buffer.from(scrubbed, 'utf8');
        const truncated = buf.byteLength > MAX_TEXT_BYTES;
        const out = truncated ? buf.subarray(0, MAX_TEXT_BYTES).toString('utf8') : scrubbed;
        const url = page.url();
        const env = pageEnvironment(page, ctx, input.environmentId);
        const evidence = await ctx.recordEvidence({
          evidenceType: 'dom-snapshot',
          data: buf,
          mimeType: 'text/plain; charset=utf-8',
          summary: `DOM text of ${selector} on ${url}: ${JSON.stringify(out.slice(0, 120))}`.slice(0, 500),
          structured: { url, selector, text: out, truncated, sessionId: input.sessionId ?? 'default' },
          provenance: { target: `${url} ${selector}`.slice(0, 500) },
          ...(env ? { environment: env } : {}),
        });
        return { status: 'success', structured: { url, text: out, truncated, evidenceId: evidence.evidenceId }, text: `${out}\n[dom-snapshot evidence ${evidence.evidenceId}]`, evidenceRefs: [evidence.evidenceId] };
      } catch (e) {
        return failure(e, ctx, 'text');
      }
    },
  };

  const screenshot: ToolSpec<{ fullPage?: boolean; sessionId?: string; environmentId?: string }> = {
    id: 'browser.screenshot',
    title: 'Browser: screenshot',
    description: 'PNG screenshot of the current page, stored as a screenshot evidence artifact (judge it visually only for what DOM and API cannot decide). Optional environmentId: the page must be on it.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { fullPage: { type: 'boolean' }, sessionId: SESSION_SCHEMA, environmentId: ENV_ID_SCHEMA } },
    effect: 'read',
    riskClass: 'low',
    resources: (input) => sessionResource(input),
    environmentClass: (input, ctx) => (input.environmentId !== undefined ? requireEnvironment(ctx.environments, input.environmentId).environmentClass : undefined),
    evidenceTypes: ['screenshot'],
    timeoutMs: 60_000,
    async execute(input, ctx) {
      try {
        const page = await manager.existingPage(ctx.runId, ctx.agentId, input.sessionId);
        if (!page) return { status: 'failed', error: { code: 'precondition_failed', message: 'no page in this session; call browser.navigate first' } };
        assertOnEnvironment(page, input.environmentId, ctx);
        assertAdmitted(page, input.environmentId);
        const png = await page.screenshot({ fullPage: input.fullPage === true, type: 'png' });
        const url = page.url();
        const env = pageEnvironment(page, ctx, input.environmentId);
        const evidence = await ctx.recordEvidence({
          evidenceType: 'screenshot',
          data: new Uint8Array(png),
          mimeType: 'image/png',
          summary: `screenshot of ${url}${input.fullPage ? ' (full page)' : ''}`.slice(0, 500),
          structured: { url, fullPage: input.fullPage === true, bytes: png.byteLength },
          provenance: { target: url },
          ...(env ? { environment: env } : {}),
        });
        return { status: 'success', structured: { url, bytes: png.byteLength, evidenceId: evidence.evidenceId }, evidenceRefs: [evidence.evidenceId] };
      } catch (e) {
        return failure(e, ctx, 'screenshot');
      }
    },
  };

  return [navigate, click, fill, text, screenshot] as ToolSpec[];
}
