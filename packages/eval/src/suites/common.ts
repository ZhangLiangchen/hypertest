/** Shared pieces of the PoC suites. */
import { join } from 'node:path';
import type { JsonValue } from '@hypertest/core';
import type { TrialContext } from '../contracts.ts';
import { asJson, readObservations } from '../fixtures.ts';

/** Revision of the PoC suites (paired seeds and reports carry it). */
export const POC_SUITE_REVISION = 'poc-1';

/** The brains' observation log of a trial (inside the trial directory: removed with it). */
export function observationsFile(ctx: Pick<TrialContext, 'workDir'>): string {
  return join(ctx.workDir, 'brain-observations.jsonl');
}

/** Probe: the brains' observations (what every model call received). */
export function observationsProbe(file: string): () => Promise<JsonValue> {
  return async () => asJson(readObservations(file));
}

/** Probe name of the brains' observation log (read by contextIsolation / offloadBounded). */
export const OBSERVATIONS_PROBE = 'observations';
