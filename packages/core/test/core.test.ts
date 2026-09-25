import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UlidIdGenerator, SequentialIdGenerator, idPrefix, FixedClock, canonicalJson, hashCanonical, sha256Hex,
  validateJson, assertValid, isValidSchema, HypertestError, toHypertestError, subjectMatches, eventSubject,
  withTimeout, retry, sleep, Semaphore, truncateUtf8, MemoryLogger,
} from '../src/index.ts';

test('ulid ids are prefixed, sortable and monotonic within the same millisecond', () => {
  const gen = new UlidIdGenerator(() => 1_700_000_000_000);
  const a = gen.next('run');
  const b = gen.next('run');
  assert.match(a, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < b);
  assert.equal(idPrefix(a), 'run');
  assert.throws(() => gen.next('Bad-Prefix'));
});

test('sequential ids are deterministic per prefix', () => {
  const g = new SequentialIdGenerator();
  assert.equal(g.next('wi'), 'wi_000001');
  assert.equal(g.next('wi'), 'wi_000002');
  assert.equal(g.next('ev'), 'ev_000001');
});

test('fixed clock advances', () => {
  const c = new FixedClock('2026-01-01T00:00:00.000Z');
  c.advance(1500);
  assert.equal(c.isoNow(), '2026-01-01T00:00:01.500Z');
});

test('canonical json sorts keys, drops undefined, rejects NaN and cycles', () => {
  assert.equal(canonicalJson({ b: 1, a: [1, { d: true, c: null }], u: undefined }), '{"a":[1,{"c":null,"d":true}],"b":1}');
  assert.equal(hashCanonical({ x: 1, y: 2 }), hashCanonical({ y: 2, x: 1 }));
  assert.throws(() => canonicalJson({ n: Number.NaN }));
  const cyc: Record<string, unknown> = {};
  cyc['self'] = cyc;
  assert.throws(() => canonicalJson(cyc));
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('json schema validation reports issues and rejects invalid schemas', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'integer', minimum: 1 } }, additionalProperties: false };
  assert.deepEqual(validateJson(schema, { a: 2 }), { valid: true, value: { a: 2 } });
  const bad = validateJson(schema, { a: 0, b: 1 });
  assert.equal(bad.valid, false);
  assert.throws(() => assertValid(schema, {}), (e: unknown) => e instanceof HypertestError && e.code === 'schema_violation');
  assert.equal(isValidSchema({ type: 'nonsense-type' }), false);
  assert.equal(isValidSchema({ type: 'string', format: 'date-time' }), true);
});

test('errors normalize and carry retryability', () => {
  assert.equal(new HypertestError('timeout', 'x').retryable, true);
  assert.equal(new HypertestError('permission_denied', 'x').retryable, false);
  assert.equal(toHypertestError(new Error('boom')).code, 'internal');
});

test('subject matching follows NATS wildcard semantics', () => {
  assert.ok(subjectMatches('ht.*.finding.created', eventSubject('run_1', 'finding.created')));
  assert.ok(subjectMatches('ht.>', 'ht.run_1.work.completed'));
  assert.ok(!subjectMatches('ht.*.finding.*', 'ht.run_1.work.completed'));
  assert.ok(!subjectMatches('ht.*', 'ht.run_1.work'));
});

test('withTimeout aborts and retry stops on non-retryable errors', async () => {
  await assert.rejects(withTimeout(20, (s) => sleep(1000, s)), (e: unknown) => e instanceof HypertestError && e.code === 'timeout');
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new HypertestError('permission_denied', 'no'); }, { attempts: 3, baseDelayMs: 1 }));
  assert.equal(calls, 1);
  calls = 0;
  const v = await retry(async (n) => { calls++; if (n < 3) throw new HypertestError('unavailable', 'x'); return 'ok'; }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(v, 'ok');
  assert.equal(calls, 3);
});

test('semaphore bounds concurrency', async () => {
  const s = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    const release = await s.acquire();
    active++; peak = Math.max(peak, active);
    await sleep(5);
    active--; release();
  }));
  assert.equal(peak, 2);
});

test('truncateUtf8 respects byte limit', () => {
  const r = truncateUtf8('é'.repeat(100), 20);
  assert.ok(r.truncated);
  assert.ok(Buffer.byteLength(r.text) <= 20);
  const log = new MemoryLogger();
  log.child({ a: 1 }).info('m', { b: 2 });
  assert.deepEqual(log.entries[0], { level: 'info', msg: 'm', fields: { a: 1, b: 2 } });
});
