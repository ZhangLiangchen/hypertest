/**
 * Child-process probe for "close() releases everything": create a Hypertest (PGlite store, in-process bus, local
 * durable runtime, fs artifacts), run the tiny scripted run to its verdict, close, clean up — and then simply return.
 * The parent test measures that the process exits on its own (no open handles: timers, sockets, db, workers).
 */
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest } from '../../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, tinyRunBrains } from '../helpers.ts';

const dir = await tempDir('ht-app-exit-');
const repo = await sumRepo();
const ht = await createHypertest(scriptedConfig(dir.path, { gate: { requireIndependentReview: false } }), { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
const outcome = await ht.run({ goal: 'exit probe', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 60_000 });
await ht.close();
await repo.cleanup();
await dir.cleanup();
process.stdout.write(`closed ${outcome.status} ${outcome.decision?.verdict ?? 'none'} ${Date.now()}\n`);
