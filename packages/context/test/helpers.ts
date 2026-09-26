import { HypertestError, type Migration, type SqlDatabase } from '@hypertest/core';
import type { ChatMessage, ReadSetEntry } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { testDeps } from '@hypertest/testkit';
import type { ContextDeps, TranscriptEntry } from '../src/index.ts';

export interface Db {
  db: SqlDatabase;
  deps: ContextDeps & ReturnType<typeof testDeps>;
  dispose(): Promise<void>;
}

/** One migrated database per test file (PGlite by default, PostgreSQL with HYPERTEST_TEST_DB=postgres). */
export async function openDb(migrations: readonly Migration[], start?: string): Promise<Db> {
  const t = await createTestDatabase({ migrations });
  const base = testDeps(start);
  return { db: t.db, deps: { ...base, db: t.db }, dispose: t.dispose };
}

/** Asserts a promise rejects with a HypertestError of the given code; returns it for detail checks. */
export async function rejectsWith(p: Promise<unknown> | (() => unknown), code: HypertestError['code']): Promise<HypertestError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof HypertestError && e.code === code) return e;
    throw new Error(`expected HypertestError(${code}), got ${e instanceof HypertestError ? `HypertestError(${e.code}): ${e.message}` : String(e)}`);
  }
  throw new Error(`expected HypertestError(${code}), but it succeeded`);
}

export function entry(resourceType: string, resourceId: string, observedVersion: string, freshness: ReadSetEntry['freshness'] = { kind: 'exact_version' }, observedAt = '2026-01-01T00:00:00.000Z'): ReadSetEntry {
  return { resourceType, resourceId, observedVersion, observedAt, freshness };
}

// ----------------------------------------------------------------------------- transcripts

export const user = (text: string): ChatMessage => ({ role: 'user', content: text });
export const say = (text: string, calls: Array<{ id: string; name: string; args?: Record<string, unknown> }> = []): ChatMessage => {
  const m: ChatMessage = { role: 'assistant', content: [{ type: 'text', text }] };
  if (calls.length > 0) m.toolCalls = calls.map((c) => ({ id: c.id, name: c.name, arguments: (c.args ?? {}) as never }));
  return m;
};
export const result = (toolCallId: string, toolName: string, content: string, isError = false): ChatMessage => {
  const m: ChatMessage = { role: 'tool', toolCallId, toolName, content };
  if (isError) m.isError = true;
  return m;
};
export const at = (turn: number, message: ChatMessage): TranscriptEntry => ({ turn, message });

/** Every tool result in `messages` has its assistant tool call earlier in the same list. */
export function orphanedToolResults(messages: readonly ChatMessage[]): string[] {
  const calls = new Set<string>();
  const orphans: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) calls.add(c.id);
    if (m.role === 'tool' && !calls.has(m.toolCallId)) orphans.push(m.toolCallId);
  }
  return orphans;
}
