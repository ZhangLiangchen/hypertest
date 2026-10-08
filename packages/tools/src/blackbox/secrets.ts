import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HypertestError, systemClock, type Clock, type Logger } from '@hypertest/core';
import type { BrokeredCredentialConfig, CredentialScope, MintedCredential, SecretBroker } from '../contracts.ts';

/**
 * (E[4] / coverage[8]) The secret broker: the LLM never receives a long-lived static credential.
 *
 * Long-lived secrets stay in the process environment of Hypertest (`*Env` variables named by the configuration); the
 * sandbox scrubs the environment of the commands agents run and its jail hides the key directory and the store. A tool
 * that needs a credential names WHICH one (`http.request` `credential: "<name>"`) — the capability must grant its scope
 * (`credential:<environmentId>/<name>`), the permit's `credentialScope` constraint must cover it — and the broker mints a
 * short-lived credential for that one call:
 *  - `jwt_hs256`: a JWT signed with the secret, valid `ttlMs` (default 5 min), bound to the run (`sub`), the credential
 *    (`scope`) and the invocation (`jti`); the SUT verifies it with the shared secret;
 *  - `oauth2_client_credentials`: an access token from the identity provider (client id + secret), cached until shortly
 *    before it expires.
 * Every long-lived secret and every minted value is redacted from tool output (`redact`), so a SUT echoing a header cannot
 * hand it to the model. The process supervisor's control token is never sent either: env.process mints a per-operation
 * control token (`mintControlToken`) the supervisor verifies.
 */

export const CREDENTIAL_SCOPE_PREFIX = 'credential:';
export const DEFAULT_CREDENTIAL_TTL_MS = 300_000;
export const MAX_CREDENTIAL_TTL_MS = 3_600_000;
const DEFAULT_GRANT = ['test_executor', 'environment_operator'];
/** Minted values remembered for redaction (most recent first). */
const MAX_REMEMBERED = 512;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The scope a capability / permit grants for brokered credential `name` of environment `environmentId`. */
export function credentialScope(environmentId: string, name: string): CredentialScope {
  return `${CREDENTIAL_SCOPE_PREFIX}${environmentId}/${name}`;
}

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/** A compact JWT (HS256) over `claims` signed with `secret`. */
export function signJwtHs256(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Verifies a JWT (HS256): signature, `exp` (> now) and optional `aud`. Returns the claims, or the exact reason it fails. */
export function verifyJwtHs256(token: string, secret: string, nowMs: number, options: { audience?: string } = {}): { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string } {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return { ok: false, reason: 'not a compact JWT' };
  const [head, body, sig] = parts as [string, string, string];
  let header: { alg?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown };
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed JWT' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: `unsupported alg ${String(header.alg)}` };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url'));
  const given = Buffer.from(sig);
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad signature' };
  if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  if (options.audience !== undefined && claims['aud'] !== options.audience) return { ok: false, reason: `audience ${String(claims['aud'])} is not ${options.audience}` };
  return { ok: true, claims };
}

/** Audience of the process supervisor's per-operation control tokens. */
export const CONTROL_TOKEN_AUDIENCE = 'hypertest-supervisor';
/** Lifetime of a control token (one control request). */
export const CONTROL_TOKEN_TTL_MS = 120_000;

/**
 * A per-operation control token for the process supervisor, signed with its long-lived control token (which never goes
 * over the wire): `{ aud: hypertest-supervisor, op: <operationId>, iat, exp, jti }`.
 */
export function mintControlToken(controlToken: string, operationId: string, nowMs: number, ttlMs = CONTROL_TOKEN_TTL_MS): string {
  const iat = Math.floor(nowMs / 1000);
  return signJwtHs256({ iss: 'hypertest', aud: CONTROL_TOKEN_AUDIENCE, op: operationId, iat, exp: iat + Math.max(1, Math.ceil(ttlMs / 1000)), jti: randomBytes(9).toString('base64url') }, controlToken);
}

/** Problems of a brokered credential configuration (empty when valid). */
export function brokeredCredentialProblems(c: BrokeredCredentialConfig, at = 'credential'): string[] {
  const out: string[] = [];
  if (!c || typeof c !== 'object') return [`${at} must be an object`];
  if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) out.push(`${at}.name must match ${NAME_RE.source}`);
  if (c.kind !== 'jwt_hs256' && c.kind !== 'oauth2_client_credentials') out.push(`${at}.kind must be jwt_hs256 or oauth2_client_credentials`);
  if (typeof c.secretEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(c.secretEnv)) out.push(`${at}.secretEnv must name an environment variable (upper case)`);
  if (c.header !== undefined && (typeof c.header !== 'string' || !HEADER_RE.test(c.header))) out.push(`${at}.header must be an HTTP header name`);
  if (c.ttlMs !== undefined && !(Number.isSafeInteger(c.ttlMs) && c.ttlMs >= 1000 && c.ttlMs <= MAX_CREDENTIAL_TTL_MS)) out.push(`${at}.ttlMs must be an integer in [1000, ${MAX_CREDENTIAL_TTL_MS}]`);
  if (c.kind === 'oauth2_client_credentials') {
    if (typeof c.tokenUrl !== 'string' || !/^https?:\/\//.test(c.tokenUrl)) out.push(`${at}.tokenUrl is required (an http(s) URL) for oauth2_client_credentials`);
    if ((c.clientId === undefined) === (c.clientIdEnv === undefined)) out.push(`${at}: set exactly one of clientId, clientIdEnv`);
  }
  if (c.grantTo !== undefined && (!Array.isArray(c.grantTo) || c.grantTo.some((g) => typeof g !== 'string' || g === ''))) out.push(`${at}.grantTo must be a list of permission profile names`);
  return out;
}

export interface SecretBrokerOptions {
  credentials: BrokeredCredentialConfig[];
  /** Where `*Env` variables are read (default `process.env`). */
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** The fetch the oauth2 token exchange uses (tests inject one). */
  fetch?: typeof fetch;
  logger?: Logger;
}

/** Creates the secret broker over the configured credentials (validated; duplicates refused). */
export function createSecretBroker(options: SecretBrokerOptions): SecretBroker {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const doFetch = options.fetch ?? fetch;
  const byKey = new Map<string, BrokeredCredentialConfig>();
  for (const [i, c] of (options.credentials ?? []).entries()) {
    const problems = brokeredCredentialProblems(c, `credentials[${i}]`);
    if (typeof c?.environmentId !== 'string' || c.environmentId === '') problems.push(`credentials[${i}].environmentId is required`);
    if (problems.length > 0) throw new HypertestError('invalid_argument', `invalid brokered credential: ${problems.join('; ')}`);
    const key = credentialScope(c.environmentId, c.name);
    if (byKey.has(key)) throw new HypertestError('invalid_argument', `duplicate brokered credential ${c.name} of environment ${c.environmentId}`);
    byKey.set(key, { ...c });
  }
  /** Values to redact: the long-lived secrets (read lazily) and minted credentials. */
  const minted: string[] = [];
  const cache = new Map<string, { value: string; expiresAtMs: number }>();
  const remember = (v: string) => {
    if (v.length < 8) return;
    minted.unshift(v);
    if (minted.length > MAX_REMEMBERED) minted.length = MAX_REMEMBERED;
  };
  const secretOf = (c: BrokeredCredentialConfig): string => {
    const v = env[c.secretEnv];
    if (v === undefined || v === '') throw new HypertestError('unavailable', `credential ${c.name} of environment ${c.environmentId}: ${c.secretEnv} is not set`);
    return v;
  };

  return {
    describe(environmentId) {
      return [...byKey.values()].filter((c) => c.environmentId === environmentId).map((c) => ({ name: c.name, scope: credentialScope(c.environmentId, c.name), kind: c.kind, grantTo: [...(c.grantTo ?? DEFAULT_GRANT)] }));
    },

    async mint(request) {
      const scope = credentialScope(request.environmentId, request.name);
      const c = byKey.get(scope);
      if (!c) throw new HypertestError('not_found', `environment ${request.environmentId} has no brokered credential ${request.name}`);
      const header = (c.header ?? 'authorization').toLowerCase();
      const nowMs = clock.nowMs();
      if (c.kind === 'jwt_hs256') {
        const ttl = c.ttlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
        const iat = Math.floor(nowMs / 1000);
        const exp = iat + Math.ceil(ttl / 1000);
        const jwt = signJwtHs256({ iss: 'hypertest', aud: c.audience ?? c.environmentId, sub: `run:${request.runId}`, scope: c.name, iat, exp, jti: request.invocationId }, secretOf(c));
        remember(jwt);
        return { header, value: `Bearer ${jwt}`, scope, kind: c.kind, expiresAt: new Date(exp * 1000).toISOString() };
      }
      // oauth2 client credentials: a cached token while it has ≥ 30 s left
      const cached = cache.get(scope);
      if (cached && cached.expiresAtMs - nowMs > 30_000) return { header, value: `Bearer ${cached.value}`, scope, kind: c.kind, expiresAt: new Date(cached.expiresAtMs).toISOString() };
      const clientId = c.clientId ?? env[c.clientIdEnv!];
      if (!clientId) throw new HypertestError('unavailable', `credential ${c.name} of environment ${c.environmentId}: ${c.clientIdEnv} is not set`);
      const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secretOf(c) });
      if (c.scope) form.set('scope', c.scope);
      let res: Response;
      try {
        res = await doFetch(c.tokenUrl!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(), signal: request.signal ?? AbortSignal.timeout(30_000) });
      } catch (e) {
        throw new HypertestError('unavailable', `credential ${c.name}: the token endpoint is unreachable (${(e as Error).message})`);
      }
      const text = await res.text();
      if (!res.ok) throw new HypertestError('unavailable', `credential ${c.name}: the token endpoint answered ${res.status}`);
      let body: { access_token?: unknown; expires_in?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new HypertestError('unavailable', `credential ${c.name}: the token endpoint did not answer JSON`);
      }
      if (typeof body.access_token !== 'string' || body.access_token === '') throw new HypertestError('unavailable', `credential ${c.name}: no access_token in the token response`);
      const lifetimeMs = typeof body.expires_in === 'number' && body.expires_in > 0 ? Math.min(body.expires_in * 1000, MAX_CREDENTIAL_TTL_MS) : DEFAULT_CREDENTIAL_TTL_MS;
      const expiresAtMs = nowMs + lifetimeMs;
      cache.set(scope, { value: body.access_token, expiresAtMs });
      remember(body.access_token);
      options.logger?.info('brokered credential minted', { environmentId: c.environmentId, name: c.name, kind: c.kind, expiresAt: new Date(expiresAtMs).toISOString() });
      return { header, value: `Bearer ${body.access_token}`, scope, kind: c.kind, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    redact(text) {
      if (typeof text !== 'string' || text === '') return text;
      let out = text;
      for (const c of byKey.values()) {
        const v = env[c.secretEnv];
        if (v && v.length >= 8 && out.includes(v)) out = out.split(v).join(`[REDACTED:${c.name}]`);
      }
      for (const v of minted) if (out.includes(v)) out = out.split(v).join('[REDACTED:minted-credential]');
      return out;
    },
  };
}
