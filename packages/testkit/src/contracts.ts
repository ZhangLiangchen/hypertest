/**
 * @hypertest/testkit — shared test helpers (used only from test/ directories).
 *
 * Implementations to export from src/index.ts:
 *   testDeps(options?): { ids: SequentialIdGenerator; clock: FixedClock; logger: MemoryLogger }
 *   withTestDatabase(migrations, fn): Promise<void>            (createTestDatabase + dispose)
 *   tempDir(prefix?): Promise<{ path: string; cleanup(): Promise<void> }>
 *   createGitRepo(files: Record<string,string>, commits?: Array<{ message: string; files: Record<string, string | null> }>): Promise<{ path, commits: string[], cleanup }>
 *   infraEnv(): { pgUrl?: string; natsUrl?: string; temporalAddress?: string }   (from env / .infra/env)
 *   skipUnless(condition, reason): test options helper producing { skip: reason } for node:test
 *   eventCtx(runId, overrides?): EventContext
 */
export {};
