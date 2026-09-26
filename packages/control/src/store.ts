import { fromJsonColumn, toIso, toNumber, type SqlDatabase, type SqlExecutor } from '@hypertest/core';
import type { ActionCapability, ActorRef, GateSpec, ModelPolicy, ReportClaim, RuntimeManifest, ToolPolicy } from '@hypertest/domain';

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

/**
 * (conformance-9) How a run's gate came about: the base it was derived from (DEFAULT_GATE_SPEC ⊕ configuration), the
 * fields the run's own override weakens relative to it, and the human/system authority recorded for that weakening.
 */
export interface GateAuthority {
  baseGate?: GateSpec;
  /** `field: base → effective` of each weakened field (empty: the run's gate is at least as strict as its base). */
  weakened: string[];
  by?: ActorRef;
  rationale?: string;
}

/** A parent's message to a continuable child (delegate.message), delivered as a user message of the child's session. */
export interface DelegationMessage {
  messageId: string;
  text: string;
  from: { agentId: string; role: string; workItemId: string };
  at: string;
  /** True once handed to the child's session (inbox or initial messages); the transcript then shows when it was read. */
  enqueued: boolean;
}

/** One delegated child work item (the delegate tool): its parent, its mode and the parent's messages. */
export interface Delegation {
  childWorkItemId: string;
  runId: string;
  parentWorkItemId: string;
  parentAgentId: string;
  /** The parent did not wait: delegate returned at once (delegate.status / delegate.collect report on the child). */
  background: boolean;
  /** The child stays waiting for more input after each task until it is released (delegate.release / parent ended). */
  continuable: boolean;
  messages: DelegationMessage[];
  releasedAt?: string;
  releaseReason?: string;
  createdAt: string;
}

interface DelegationRow {
  child_work_item_id: string;
  run_id: string;
  parent_work_item_id: string;
  parent_agent_id: string;
  background: boolean;
  continuable: boolean;
  messages: unknown;
  released_at: unknown;
  release_reason: string | null;
  created_at: unknown;
}

function toDelegation(r: DelegationRow): Delegation {
  const d: Delegation = {
    childWorkItemId: r.child_work_item_id,
    runId: r.run_id,
    parentWorkItemId: r.parent_work_item_id,
    parentAgentId: r.parent_agent_id,
    background: r.background === true,
    continuable: r.continuable === true,
    messages: fromJsonColumn<DelegationMessage[]>(r.messages) ?? [],
    createdAt: toIso(r.created_at),
  };
  if (r.released_at !== null && r.released_at !== undefined) d.releasedAt = toIso(r.released_at);
  if (r.release_reason !== null) d.releaseReason = r.release_reason;
  return d;
}

const DELEGATION_COLUMNS = 'child_work_item_id, run_id, parent_work_item_id, parent_agent_id, background, continuable, messages, released_at, release_reason, created_at';

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

  /** Records the run's effective gate and (additive, conformance-9) how it came about: its base, weakenings and authority. */
  async putGate(runId: string, gate: GateSpec, tx?: SqlExecutor, authority?: GateAuthority): Promise<void> {
    await q(this.#db, tx).query(
      `INSERT INTO ht_run_gates (run_id, gate, base_gate, weakened, override_by, override_rationale) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        runId, JSON.stringify(gate), authority?.baseGate ? JSON.stringify(authority.baseGate) : null, authority ? JSON.stringify(authority.weakened) : null,
        authority?.by ? JSON.stringify(authority.by) : null, authority?.rationale ?? null,
      ],
    );
  }

  async getGate(runId: string): Promise<GateSpec | undefined> {
    const r = await this.#db.query<{ gate: unknown }>('SELECT gate FROM ht_run_gates WHERE run_id = $1', [runId]);
    return r.rows[0] ? fromJsonColumn<GateSpec>(r.rows[0].gate) : undefined;
  }

  /** (conformance-9) The recorded base, weakenings and authority of the run's gate (undefined: no gate row, or one without). */
  async gateAuthority(runId: string): Promise<GateAuthority | undefined> {
    const r = await this.#db.query<{ base_gate: unknown; weakened: unknown; override_by: unknown; override_rationale: string | null }>(
      'SELECT base_gate, weakened, override_by, override_rationale FROM ht_run_gates WHERE run_id = $1',
      [runId],
    );
    const row = r.rows[0];
    if (!row || row.weakened === null || row.weakened === undefined) return undefined;
    const out: GateAuthority = { weakened: fromJsonColumn<string[]>(row.weakened) ?? [] };
    if (row.base_gate !== null && row.base_gate !== undefined) out.baseGate = fromJsonColumn<GateSpec>(row.base_gate);
    if (row.override_by !== null && row.override_by !== undefined) out.by = fromJsonColumn<ActorRef>(row.override_by);
    if (row.override_rationale !== null) out.rationale = row.override_rationale;
    return out;
  }

  // ------------------------------------------------------------------------------------------------ delegations

  /** Records a delegated child (idempotent: a replayed delegate call finds the first row). */
  async putDelegation(d: Omit<Delegation, 'messages' | 'releasedAt' | 'releaseReason'>, tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query(
      `INSERT INTO ht_delegations (child_work_item_id, run_id, parent_work_item_id, parent_agent_id, background, continuable, messages, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7) ON CONFLICT (child_work_item_id) DO NOTHING`,
      [d.childWorkItemId, d.runId, d.parentWorkItemId, d.parentAgentId, d.background, d.continuable, d.createdAt],
    );
  }

  /** The delegation of a child work item; `forUpdate` locks the row for the caller's transaction (messages, release). */
  async delegation(childWorkItemId: string, tx?: SqlExecutor, forUpdate = false): Promise<Delegation | undefined> {
    const r = await q(this.#db, tx).query<DelegationRow>(`SELECT ${DELEGATION_COLUMNS} FROM ht_delegations WHERE child_work_item_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [childWorkItemId]);
    return r.rows[0] ? toDelegation(r.rows[0]) : undefined;
  }

  /** The run's delegations (oldest first). */
  async delegations(runId: string): Promise<Delegation[]> {
    const r = await this.#db.query<DelegationRow>(`SELECT ${DELEGATION_COLUMNS} FROM ht_delegations WHERE run_id = $1 ORDER BY created_at, child_work_item_id`, [runId]);
    return r.rows.map(toDelegation);
  }

  async setDelegationMessages(childWorkItemId: string, messages: DelegationMessage[], tx?: SqlExecutor): Promise<void> {
    await q(this.#db, tx).query('UPDATE ht_delegations SET messages = $2::jsonb WHERE child_work_item_id = $1', [childWorkItemId, JSON.stringify(messages)]);
  }

  /** Releases a continuable child once (true when this call released it). */
  async releaseDelegation(childWorkItemId: string, reason: string, at: string, tx?: SqlExecutor): Promise<boolean> {
    const r = await q(this.#db, tx).query('UPDATE ht_delegations SET released_at = $2, release_reason = $3 WHERE child_work_item_id = $1 AND released_at IS NULL', [childWorkItemId, at, reason]);
    return r.rowCount > 0;
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
