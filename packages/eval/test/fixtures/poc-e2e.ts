/**
 * Shared set-up of the PoC e2e tests: trial options on PGlite (default) or a fresh PostgreSQL schema per trial
 * (HYPERTEST_TEST_DB=postgres), a capture grader that snapshots an acceptance table from the recorded state of the
 * trial (graders run while the trial's Hypertest instance is still open), and the post-test check that the harness
 * dropped every trial schema.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DomainEvent } from '@hypertest/domain';
import { defaultConfig, type HypertestConfig } from '@hypertest/app';
import { openDatabase } from '@hypertest/store';
import { infraEnv } from '@hypertest/testkit';
import type { EvalTrial, Grader, GraderContext, TrialOptions } from '../../src/index.ts';

export const PG = process.env['HYPERTEST_TEST_DB'] === 'postgres';

/** A unique schema prefix per test file (trial schemas are `<prefix>_…`). */
export function schemaPrefix(tag: string): string {
  return `ht_poc${tag}_${randomBytes(3).toString('hex')}`;
}

export function baseConfig(prefix: string): HypertestConfig | undefined {
  if (!PG) return undefined;
  const url = infraEnv().pgUrl;
  if (!url) throw new Error('HYPERTEST_TEST_DB=postgres needs HYPERTEST_TEST_PG_URL');
  return defaultConfig({ store: { kind: 'postgres', url, schema: prefix } });
}

export function trialOptions(prefix: string, workDir: string, extra: Partial<TrialOptions> = {}): TrialOptions {
  const o: TrialOptions = { workDir, trial: 0, seed: 'poc-e2e', timeoutMs: 240_000, ...extra };
  const base = baseConfig(prefix);
  if (base) o.baseConfig = base;
  return o;
}

/** Every trial schema of this file was dropped by the harness. */
export async function assertSchemasDropped(prefix: string): Promise<void> {
  if (!PG) return;
  const db = await openDatabase({ kind: 'postgres', url: infraEnv().pgUrl! });
  try {
    const left = await db.query<{ schema_name: string }>('SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1', [`${prefix}%`]);
    assert.deepEqual(left.rows, [], 'trial schemas left behind');
  } finally {
    await db.close();
  }
}

/** Failed graders of a trial as readable lines (empty = all passed). */
export function failures(t: EvalTrial): string[] {
  return t.graders.filter((g) => !g.pass).map((g) => `${g.graderId}: ${g.detail}`);
}

/** A grader that snapshots `fn(ctx)` (the acceptance table) and always passes; the snapshot is asserted after the trial. */
export function capture<T>(fn: (ctx: GraderContext) => T | Promise<T>): { grader: Grader; value: () => T } {
  let snapshot: { v: T } | undefined;
  return {
    grader: async (ctx) => {
      snapshot = { v: await fn(ctx) };
      return { graderId: 'acceptance', pass: true, score: 1, detail: 'captured' };
    },
    value: () => {
      if (!snapshot) throw new Error('the acceptance grader never ran');
      return snapshot.v;
    },
  };
}

export function payloadOf(e: DomainEvent<unknown>): Record<string, unknown> {
  return (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
}

/** role → sorted route ids of successful routing decisions (L0 model.routed). */
export function routesOfRoles(events: readonly DomainEvent<unknown>[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const e of events) {
    const p = payloadOf(e);
    if (e.eventType !== 'model.routed' || p['ok'] !== true || typeof p['role'] !== 'string' || typeof p['routeId'] !== 'string') continue;
    (out[p['role']] ??= new Set()).add(p['routeId']);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([r, s]) => [r, [...s].sort()]));
}

/** Count of events per type (only the given types). */
export function eventCounts(events: readonly DomainEvent<unknown>[], types: readonly string[]): Record<string, number> {
  return Object.fromEntries(types.map((t) => [t, events.filter((e) => e.eventType === t).length]));
}
