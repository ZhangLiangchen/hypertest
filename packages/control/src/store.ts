import { fromJsonColumn, toNumber, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import type { ActionCapability, GateSpec, ModelPolicy, ReportClaim, RuntimeManifest, ToolPolicy } from '@hypertest/domain';

/** Gate feedback recorded when an inconclusive gate asks for more evidence (drives a `gate_feedback` replan). */
export interface GateFeedback {
  decisionId: string;
  verdict: string;
  unknownCriteria: Array<{ criterionId: string; description: string; detail?: string }>;
  violatedCriteria: Array<{ criterionId: string; description: string; detail?: string }>;
  reasons: string[];
}

export interface ReplanState {
  runId: string;
  revisionCount: number;
  lastReason?: string;
  gateAttempts: number;
  feedback?: GateFeedback;
  feedbackPending: boolean;
}

/** How an agent's workspace is (re)created: the WorkspaceManager re-attaches deterministically. */
export type WorkspaceRecipe =
  | { kind: 'shared_readonly'; repoPath: string; commit?: string }
  | { kind: 'isolated_worktree'; repoPath: string; baseCommit?: string }
  | { kind: 'scratch' };

/**
 * A writable worktree whose governed test code was changed by an execution tool (shell.exec, test.run, …) behind the
 * dispatcher's back (I8). Until every listed diff section is back to its recorded pre-command state, the agent may not
 * turn the change into evidence: test execution, commits, test artifact registration and complete_work are refused.
 */
export interface WorkspaceQuarantine {
  toolId: string;
  invocationId: string;
  categories: string[];
  findings: string[];
  /** Workspace-relative paths to restore. */
  paths: string[];
  /** `diff --git` header of each governed section → its text before the command ('' = unchanged vs base). */
  expected: Record<string, string>;
  /** Set when the post-command diff could not be computed: the whole diff must equal `expectedDiff`. */
  expectedDiff?: string;
  at: string;
}

/** Everything needed to rebuild an agent's EngineHost after a restart. */
export interface AgentHostSpec {
  agentId: string;
  runId: string;
  workItemId: string;
  role: string;
  workspace: WorkspaceRecipe;
  workspaceId: string;
  modelPolicy: ModelPolicy;
  toolPolicy: ToolPolicy;
  capability: ActionCapability;
  /** Present while the agent's worktree is quarantined (see WorkspaceQuarantine). */
  quarantine?: WorkspaceQuarantine;
  /**
   * The pre-execution worktree diff of the execution tool call in flight: a call re-dispatched after a crash (same
   * invocation id) is checked against the state BEFORE its first execution, not against what that execution left.
   */
  guard?: { invocationId: string; before: string };
}

function q(db: SqlDatabase, tx?: SqlExecutor): SqlExecutor {
  return tx ?? db;
}

/** Access to the control plane's own tables (controlMigrations). */
export class ControlStore {
  readonly #db: SqlDatabase;
  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async putManifest(manifest: RuntimeManifest, now: string, tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query('INSERT INTO ht_manifests (manifest_id, manifest, created_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (manifest_id) DO NOTHING', [
      manifest.manifestId, JSON.stringify(manifest), now,
    ]);
  }

  async getManifest(manifestId: string): Promise<RuntimeManifest | undefined> {
    const r = await this.#db.query<{ manifest: unknown }>('SELECT manifest FROM ht_manifests WHERE manifest_id = $1', [manifestId]);
    return r.rows[0] ? fromJsonColumn<RuntimeManifest>(r.rows[0].manifest) : undefined;
  }

  async putGate(runId: string, gate: GateSpec, tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query('INSERT INTO ht_run_gates (run_id, gate) VALUES ($1, $2::jsonb) ON CONFLICT (run_id) DO NOTHING', [runId, JSON.stringify(gate)]);
  }

  async getGate(runId: string): Promise<GateSpec | undefined> {
    const r = await this.#db.query<{ gate: unknown }>('SELECT gate FROM ht_run_gates WHERE run_id = $1', [runId]);
    return r.rows[0] ? fromJsonColumn<GateSpec>(r.rows[0].gate) : undefined;
  }

  async cursor(runId: string, consumer: string, tx?: SqlExecutor): Promise<number> {
    const r = await q(this.#db, tx).query<{ last_seq: unknown }>('SELECT last_seq FROM ht_reactor_cursors WHERE run_id = $1 AND consumer = $2', [runId, consumer]);
    return r.rows[0] ? toNumber(r.rows[0].last_seq) : 0;
  }

  /** Moves the cursor forward only (never back). */
  async advanceCursor(runId: string, consumer: string, seq: number, tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query(
      `INSERT INTO ht_reactor_cursors (run_id, consumer, last_seq) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, consumer) DO UPDATE SET last_seq = GREATEST(ht_reactor_cursors.last_seq, EXCLUDED.last_seq)`,
      [runId, consumer, seq],
    );
  }

  async putClaim(runId: string, claim: ReportClaim, now: string, tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query('INSERT INTO ht_claims (claim_id, run_id, claim, created_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (claim_id) DO NOTHING', [
      claim.claimId, runId, JSON.stringify(claim), now,
    ]);
  }

  async claims(runId: string): Promise<ReportClaim[]> {
    const r = await this.#db.query<{ claim: unknown }>('SELECT claim FROM ht_claims WHERE run_id = $1 ORDER BY created_at, claim_id', [runId]);
    return r.rows.map((row) => fromJsonColumn<ReportClaim>(row.claim));
  }

  async replans(runId: string, tx?: SqlExecutor): Promise<ReplanState> {
    const r = await q(this.#db, tx).query<{ revision_count: unknown; last_reason: string | null; gate_attempts: unknown; feedback: unknown; feedback_pending: boolean }>(
      'SELECT revision_count, last_reason, gate_attempts, feedback, feedback_pending FROM ht_replans WHERE run_id = $1',
      [runId],
    );
    const row = r.rows[0];
    if (!row) return { runId, revisionCount: 0, gateAttempts: 0, feedbackPending: false };
    const out: ReplanState = { runId, revisionCount: toNumber(row.revision_count), gateAttempts: toNumber(row.gate_attempts), feedbackPending: row.feedback_pending === true };
    if (row.last_reason !== null) out.lastReason = row.last_reason;
    const fb = row.feedback === null || row.feedback === undefined ? undefined : fromJsonColumn<GateFeedback | null>(row.feedback);
    if (fb) out.feedback = fb;
    return out;
  }

  /** Records that a replan with the given ordinal was scheduled (clears pending gate feedback). */
  async recordReplan(runId: string, reason: string, now: string, tx?: SqlExecutor): Promise<number> {
    const r = await q(this.#db, tx).query<{ revision_count: unknown }>(
      `INSERT INTO ht_replans (run_id, revision_count, last_reason, gate_attempts, feedback_pending, updated_at) VALUES ($1, 1, $2, 0, false, $3)
       ON CONFLICT (run_id) DO UPDATE SET revision_count = ht_replans.revision_count + 1, last_reason = EXCLUDED.last_reason, feedback_pending = false,
         updated_at = EXCLUDED.updated_at
       RETURNING revision_count`,
      [runId, reason, now],
    );
    return toNumber(r.rows[0]!.revision_count);
  }

  /** Counts one gate evaluation; with feedback, marks it pending for the next replan. Returns the new attempt count. */
  async recordGateAttempt(runId: string, feedback: GateFeedback | undefined, now: string, tx?: SqlExecutor): Promise<number> {
    const r = await q(this.#db, tx).query<{ gate_attempts: unknown }>(
      `INSERT INTO ht_replans (run_id, revision_count, gate_attempts, feedback, feedback_pending, updated_at) VALUES ($1, 0, 1, $2::jsonb, $3, $4)
       ON CONFLICT (run_id) DO UPDATE SET gate_attempts = ht_replans.gate_attempts + 1,
         feedback = COALESCE(EXCLUDED.feedback, ht_replans.feedback), feedback_pending = EXCLUDED.feedback_pending, updated_at = EXCLUDED.updated_at
       RETURNING gate_attempts`,
      [runId, feedback ? JSON.stringify(feedback) : null, feedback !== undefined, now],
    );
    return toNumber(r.rows[0]!.gate_attempts);
  }

  async putAgentHost(spec: AgentHostSpec, now: string, tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query(
      'INSERT INTO ht_agent_hosts (agent_id, run_id, work_item_id, spec, created_at) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (agent_id) DO NOTHING',
      [spec.agentId, spec.runId, spec.workItemId, JSON.stringify(spec), now],
    );
  }

  async agentHost(agentId: string): Promise<AgentHostSpec | undefined> {
    const r = await this.#db.query<{ spec: unknown }>('SELECT spec FROM ht_agent_hosts WHERE agent_id = $1', [agentId]);
    return r.rows[0] ? fromJsonColumn<AgentHostSpec>(r.rows[0].spec) : undefined;
  }

  /** Records (or with `null` clears) the pre-execution diff of the guarded tool call in flight. */
  async setGuard(agentId: string, guard: { invocationId: string; before: string } | null): Promise<void> {
    if (guard === null) {
      await this.#db.query("UPDATE ht_agent_hosts SET spec = spec - 'guard' WHERE agent_id = $1", [agentId]);
      return;
    }
    await this.#db.query("UPDATE ht_agent_hosts SET spec = jsonb_set(spec, '{guard}', $2::jsonb, true) WHERE agent_id = $1", [agentId, JSON.stringify(guard)]);
  }

  /** Sets (or with `null` lifts) the quarantine of an agent's worktree; survives restarts with the host spec. */
  async setQuarantine(agentId: string, quarantine: WorkspaceQuarantine | null): Promise<void> {
    if (quarantine === null) {
      await this.#db.query("UPDATE ht_agent_hosts SET spec = spec - 'quarantine' WHERE agent_id = $1", [agentId]);
      return;
    }
    await this.#db.query("UPDATE ht_agent_hosts SET spec = jsonb_set(spec, '{quarantine}', $2::jsonb, true) WHERE agent_id = $1", [agentId, JSON.stringify(quarantine)]);
  }
}
