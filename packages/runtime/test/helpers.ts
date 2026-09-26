import { FixedClock, MemoryLogger, SequentialIdGenerator, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import { InMemoryEventSink } from '@hypertest/domain';

export function baseDeps(start = '2026-02-01T00:00:00.000Z'): { ids: SequentialIdGenerator; clock: FixedClock; logger: MemoryLogger; events: InMemoryEventSink } {
  return { ids: new SequentialIdGenerator(), clock: new FixedClock(start), logger: new MemoryLogger(), events: new InMemoryEventSink() };
}

/**
 * Wraps a database so that statements matching `fail` throw (inside and outside transactions) — fault injection
 * for atomicity tests. `armed` toggles the fault.
 */
export function faultyDb(db: SqlDatabase, fail: (sql: string, params: readonly unknown[] | undefined) => boolean): SqlDatabase & { armed: boolean; hits: number } {
  const state = { armed: true, hits: 0 };
  const check = (sql: string, params: readonly unknown[] | undefined) => {
    if (state.armed && fail(sql, params)) {
      state.hits++;
      throw new Error(`injected fault: ${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
    }
  };
  const wrapExec = (x: SqlExecutor): SqlExecutor => ({
    query: async (sql, params) => {
      check(sql, params);
      return x.query(sql, params);
    },
  });
  const wrapped = {
    kind: db.kind,
    get armed() {
      return state.armed;
    },
    set armed(v: boolean) {
      state.armed = v;
    },
    get hits() {
      return state.hits;
    },
    query: async (sql: string, params?: Parameters<SqlDatabase['query']>[1]) => {
      check(sql, params);
      return db.query(sql, params);
    },
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => db.transaction((tx) => fn(wrapExec(tx))),
    close: () => db.close(),
  };
  return wrapped as unknown as SqlDatabase & { armed: boolean; hits: number };
}
