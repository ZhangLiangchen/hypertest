/**
 * Collects the TrialData of one trial: fixture probes first (environment state is the outcome), then everything the
 * graders need from the trial's stores through the Hypertest services (L0 events, operation ledger, blackboard,
 * evidence ledger + verification, policy decision log, session turns, pinned manifest, report).
 */
import { HypertestError, type JsonValue, type Logger } from '@hypertest/core';
import type { Finding, QualityDecision, RuntimeManifest } from '@hypertest/domain';
import type { HypertestInstance } from '@hypertest/app';
import type { RunOutcome, TrialData, TrialFixture } from './contracts.ts';

/** Default per-probe timeout. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * Runs every fixture probe once (sequentially, in name order) with a timeout. A probe that throws, times out or
 * returns a non-JSON value is a `precondition_failed` fault: the environment state is unknown, so the trial cannot be
 * graded (the harness records infra_error).
 */
export async function runProbes(fixture: TrialFixture, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const name of Object.keys(fixture.probes ?? {}).sort()) {
    const probe = fixture.probes![name]!;
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => probe()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      out[name] = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
    } catch (e) {
      throw new HypertestError('precondition_failed', `probe ${name} failed: ${(e as Error).message}`, { cause: e, details: { probe: name } });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return out;
}

function parseJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

/** Committed agent turns of a run from the SessionStore tables (the runtime's own record, independent of L0). */
export async function sessionTurns(ht: HypertestInstance, runId: string): Promise<TrialData['sessionTurns']> {
  const r = await ht.services.db.query<{ agent_id: string; route_id: string | null; turn: unknown; has_response: boolean }>(
    `SELECT s.agent_id, t.route_id, t.turn, (t.response IS NOT NULL) AS has_response
       FROM ht_turns t JOIN ht_sessions s ON s.session_id = t.session_id
      WHERE s.run_id = $1
      ORDER BY s.agent_id, t.turn`,
    [runId],
  );
  return r.rows.map((row) => ({ agentId: row.agent_id, routeId: row.route_id, turn: Number(row.turn), hasResponse: row.has_response === true }));
}

async function storedManifest(ht: HypertestInstance, manifestId: string): Promise<RuntimeManifest | undefined> {
  const r = await ht.services.db.query<{ manifest: unknown }>('SELECT manifest FROM ht_manifests WHERE manifest_id = $1', [manifestId]);
  return r.rows[0] ? parseJson<RuntimeManifest>(r.rows[0].manifest) : undefined;
}

async function decisionChain(ht: HypertestInstance, runId: string): Promise<QualityDecision[]> {
  const out: QualityDecision[] = [];
  const seen = new Set<string>();
  let d = await ht.services.decisions.latestForRun(runId);
  while (d && !seen.has(d.decisionId)) {
    seen.add(d.decisionId);
    out.push(d);
    d = d.supersedes ? await ht.services.decisions.get(d.supersedes) : undefined;
  }
  return out;
}

export interface CollectInput {
  runId?: string;
  outcome?: RunOutcome;
  probes: Record<string, JsonValue>;
  harness: TrialData['harness'];
  logger?: Logger;
}

/** An empty TrialData (no run was created). */
export function emptyTrialData(input: Pick<CollectInput, 'probes' | 'harness'>): TrialData {
  return { decisions: [], events: [], operations: [], findings: [], evidence: [], plans: [], workItems: [], policyDecisions: [], sessionTurns: [], probes: input.probes, harness: input.harness };
}

/** Reads the trial's stores. Unknown run ⇒ an empty TrialData (graders then fail on the missing run). */
export async function collectTrialData(ht: HypertestInstance, input: CollectInput): Promise<TrialData> {
  const data = emptyTrialData(input);
  if (input.outcome) data.outcome = input.outcome;
  const runId = input.runId;
  if (!runId) return data;
  data.runId = runId;
  const s = ht.services;
  const run = await s.runs.get(runId);
  if (!run) return data;
  data.run = run;
  data.status = run.status;
  data.events = await s.events.read(runId);
  data.decisions = await decisionChain(ht, runId);
  // Only the run's FINAL decision is its verdict. A run without one (cancelled, failed, timed out, still running) has
  // none, even when the gate recorded an interim feedback-loop decision (`final: false`, typically inconclusive): that
  // is an audit record (kept in `decisions`), never an outcome to grade.
  const decision = run.decisionId ? await s.decisions.get(run.decisionId) : undefined;
  if (decision) data.decision = decision;
  data.operations = await s.operations.list({ runId });
  data.findings = await s.blackboard.query<Finding>({ runId, recordType: 'finding' });
  data.evidence = await s.evidence.query({ runId });
  data.plans = await s.blackboard.listPlans(runId);
  data.workItems = await s.blackboard.listWorkItems({ runId });
  data.policyDecisions = await s.decisionLog.list(runId);
  data.sessionTurns = await sessionTurns(ht, runId);
  data.verification = await s.evidence.verify(runId, { publicKeys: s.publicKeys });
  data.verifyEvidence = await ht.verifyEvidence(runId);
  const manifest = await storedManifest(ht, run.runtimeManifestId);
  if (manifest) data.manifest = manifest;
  try {
    data.report = await ht.report(runId);
  } catch (e) {
    data.reportError = (e as Error).message;
    input.logger?.warn('the run report could not be built', { runId, error: data.reportError });
  }
  return data;
}
