import type { Migration } from '@hypertest/core';
import { RELEASE_MIGRATION } from './releases.ts';

/**
 * Runtime schema (PGlite + PostgreSQL 16).
 *
 * - `ht_sessions` / `ht_transcript` / `ht_turns` / `ht_tool_calls`: the portable SessionStore. A turn's response is
 *   persisted (with one pending `ht_tool_calls` row per call) BEFORE any tool executes; each call is settled
 *   individually; `invocation_id` (`sessionId:turn:toolCallId`) is unique so a replay reuses exactly the same ids.
 * - `ht_agent_inbox`: queued inputs for the next turn (peer messages, wake-ups, nudges), drained atomically.
 * - `ht_agents`: durable agent identities (+ the settled SubagentResult in `result`).
 * - `ht_epochs` / `ht_pending_fallbacks`: ModelEpochs (I3) and the fallback decided by a failed invoke, applied
 *   only at the next turn boundary.
 * - `ht_compactions`: L2 compaction records (reversible: the transcript keeps everything).
 * - 004: `ht_turns.outcome` (the engine's turn decision, committed with the completion), `ht_agents.capability` and
 *   `ht_agents.max_depth` (the grant recorded at spawn; a child's capability must be covered by it, I2, and its depth
 *   cap can only shrink, I12).
 * - 005 (runtime release registry, `releases.ts`): `ht_runtime_releases` (registered manifests and their release state;
 *   the manifest is immutable), `ht_runtime_release_pointer` (the active pointer), `ht_runtime_release_lock`,
 *   `ht_runtime_suite_results` / `ht_runtime_release_transitions` / `ht_runtime_epochs` (append-only).
 * - 006: `ht_agents.resume_pending` (A[4]: a resumed child continues through its engine's resumeChild at the next step),
 *   `ht_epochs.route_profile` (A[3]: the route's capability profile when the epoch started, to tell a quality switch
 *   from a policy switch after a catalog change), `ht_model_pauses` (A[0]: a session paused for model unavailability, durable resume time), `ht_model_switches` +
 *   `ht_model_switch_outcomes` (A[3]: manual model switch requests and each target agent's applied/refused outcome).
 * - 007: `ht_agents.resume_after_turn` (A[4]: the session's last settled turn when a resume through resumeChild was
 *   requested — a later settled turn, or the session active again, means the engine already took the resume over, so a
 *   crash before the flag was cleared never runs a second turn).
 */
export const runtimeMigrations: Migration[] = [
  {
    id: 'runtime/001-sessions',
    sql: `
CREATE TABLE IF NOT EXISTS ht_sessions (
  session_id       text PRIMARY KEY,
  run_id           text NOT NULL,
  agent_id         text NOT NULL,
  engine_kind      text NOT NULL,
  status           text NOT NULL CHECK (status IN ('active', 'waiting', 'completed', 'failed', 'interrupted', 'disposed')),
  turn_count       integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  current_epoch_id text,
  output_schema    jsonb,
  native_state     jsonb,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_sessions_run_idx ON ht_sessions (run_id, agent_id);

CREATE TABLE IF NOT EXISTS ht_transcript (
  session_id text NOT NULL REFERENCES ht_sessions (session_id),
  seq        integer NOT NULL CHECK (seq >= 1),
  turn       integer NOT NULL CHECK (turn >= 0),
  message    jsonb NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS ht_turns (
  session_id   text NOT NULL REFERENCES ht_sessions (session_id),
  turn         integer NOT NULL CHECK (turn >= 1),
  status       text NOT NULL CHECK (status IN ('started', 'model_responded', 'completed', 'boundary', 'failed')),
  epoch_id     text,
  route_id     text,
  snapshot_id  text,
  response     jsonb,
  usage        jsonb,
  started_at   timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (session_id, turn)
);

CREATE TABLE IF NOT EXISTS ht_tool_calls (
  session_id           text NOT NULL,
  turn                 integer NOT NULL,
  tool_call_id         text NOT NULL,
  ordinal              integer NOT NULL CHECK (ordinal >= 0),
  name                 text NOT NULL,
  invocation_id        text NOT NULL UNIQUE,
  status               text NOT NULL CHECK (status IN ('pending', 'settled')),
  result               jsonb,
  pending_operation_id text,
  terminal             jsonb,
  settled_at           timestamptz,
  PRIMARY KEY (session_id, turn, tool_call_id),
  UNIQUE (session_id, turn, ordinal),
  FOREIGN KEY (session_id, turn) REFERENCES ht_turns (session_id, turn),
  CHECK (status = 'pending' OR result IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ht_agent_inbox (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES ht_sessions (session_id),
  message     jsonb NOT NULL,
  drained     boolean NOT NULL DEFAULT false,
  enqueued_at timestamptz NOT NULL,
  drained_at  timestamptz
);
CREATE INDEX IF NOT EXISTS ht_agent_inbox_pending_idx ON ht_agent_inbox (session_id, id) WHERE NOT drained;

CREATE TABLE IF NOT EXISTS ht_compactions (
  compaction_id    text PRIMARY KEY,
  session_id       text NOT NULL REFERENCES ht_sessions (session_id),
  level            text NOT NULL CHECK (level IN ('soft', 'hard')),
  up_to_turn       integer NOT NULL,
  summary          text NOT NULL,
  evidence_refs    jsonb NOT NULL,
  summary_artifact jsonb,
  created_at       timestamptz NOT NULL,
  seq              bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_compactions_session_idx ON ht_compactions (session_id, seq);
`,
  },
  {
    id: 'runtime/002-agents',
    sql: `
CREATE TABLE IF NOT EXISTS ht_agents (
  agent_id        text PRIMARY KEY,
  run_id          text NOT NULL,
  role            text NOT NULL,
  work_item_id    text NOT NULL,
  parent_agent_id text,
  depth           integer NOT NULL CHECK (depth >= 0),
  engine_kind     text NOT NULL,
  session_id      text NOT NULL,
  status          text NOT NULL CHECK (status IN ('active', 'waiting', 'completed', 'failed', 'interrupted', 'disposed')),
  capability_id   text NOT NULL,
  continuable     boolean NOT NULL,
  background      boolean NOT NULL,
  result          jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  seq             bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_agents_run_idx ON ht_agents (run_id, seq);
CREATE INDEX IF NOT EXISTS ht_agents_parent_idx ON ht_agents (parent_agent_id, seq);
CREATE INDEX IF NOT EXISTS ht_agents_work_item_idx ON ht_agents (work_item_id, seq);
`,
  },
  {
    id: 'runtime/003-epochs',
    sql: `
CREATE TABLE IF NOT EXISTS ht_epochs (
  epoch_id                          text PRIMARY KEY,
  run_id                            text NOT NULL,
  agent_id                          text NOT NULL,
  session_id                        text NOT NULL REFERENCES ht_sessions (session_id),
  previous_epoch_id                 text,
  route_id                          text NOT NULL,
  provider                          text NOT NULL,
  model                             text NOT NULL,
  capability_profile_revision       text NOT NULL,
  continuation_compatibility_class  text NOT NULL,
  context_snapshot_id               text NOT NULL,
  switch_reason                     text NOT NULL CHECK (switch_reason IN ('initial', 'policy', 'quality', 'rate_limit', 'unavailable', 'cost', 'manual')),
  started_at_turn                   integer NOT NULL CHECK (started_at_turn >= 0),
  started_at                        timestamptz NOT NULL,
  decision                          jsonb,
  excluded_routes                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  seq                               bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_epochs_session_idx ON ht_epochs (session_id, seq);
CREATE INDEX IF NOT EXISTS ht_epochs_run_idx ON ht_epochs (run_id, agent_id);

CREATE TABLE IF NOT EXISTS ht_pending_fallbacks (
  session_id      text PRIMARY KEY REFERENCES ht_sessions (session_id),
  decision        jsonb NOT NULL,
  reason          text NOT NULL,
  from_route_id   text NOT NULL,
  from_epoch_id   text,
  error           jsonb NOT NULL,
  excluded_routes jsonb NOT NULL,
  created_at      timestamptz NOT NULL
);
`,
  },
  {
    // ht_turns.outcome: the engine's decision recorded with the turn completion (recovers an unsettled terminal agent).
    // ht_agents.capability / max_depth: the grant recorded at spawn; a child's capability (I2) and depth cap (I12) are
    // checked against its parent's recorded grant, never only against what the spawn request claims.
    id: 'runtime/004-turn-outcome-agent-grant',
    sql: `
ALTER TABLE ht_turns ADD COLUMN IF NOT EXISTS outcome jsonb;
ALTER TABLE ht_agents ADD COLUMN IF NOT EXISTS capability jsonb;
ALTER TABLE ht_agents ADD COLUMN IF NOT EXISTS max_depth integer CHECK (max_depth >= 0);
`,
  },
  RELEASE_MIGRATION,
  {
    // A[0] fallback end state PAUSE: a session whose model routes are transiently unavailable waits until resume_at.
    // A[3] manual model switches: operator requests (append-only) and each target agent's outcome (once per agent).
    id: 'runtime/006-model-pauses-switches',
    sql: `
ALTER TABLE ht_epochs ADD COLUMN IF NOT EXISTS route_profile jsonb;
ALTER TABLE ht_agents ADD COLUMN IF NOT EXISTS resume_pending boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ht_model_pauses (
  session_id   text PRIMARY KEY REFERENCES ht_sessions (session_id),
  run_id       text NOT NULL,
  agent_id     text NOT NULL,
  turn         integer NOT NULL CHECK (turn >= 0),
  reason       text NOT NULL,
  resume_at    timestamptz NOT NULL,
  routes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  consecutive  integer NOT NULL CHECK (consecutive >= 1),
  created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_model_pauses_run_idx ON ht_model_pauses (run_id);

CREATE TABLE IF NOT EXISTS ht_model_switches (
  switch_id     text PRIMARY KEY,
  run_id        text NOT NULL,
  target_kind   text NOT NULL CHECK (target_kind IN ('agent', 'role')),
  target        text NOT NULL,
  route_id      text NOT NULL,
  reason        text,
  requested_by  text NOT NULL,
  created_at    timestamptz NOT NULL,
  seq           bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_model_switches_run_idx ON ht_model_switches (run_id, seq);

CREATE TABLE IF NOT EXISTS ht_model_switch_outcomes (
  switch_id  text NOT NULL REFERENCES ht_model_switches (switch_id),
  agent_id   text NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN ('applied', 'refused')),
  epoch_id   text,
  detail     text NOT NULL,
  at         timestamptz NOT NULL,
  PRIMARY KEY (switch_id, agent_id)
);
`,
  },
  {
    // A[4] crash window of an engine-driven resume: the turn the resume was requested after (see resumeState)
    id: 'runtime/007-resume-after-turn',
    sql: `ALTER TABLE ht_agents ADD COLUMN IF NOT EXISTS resume_after_turn integer CHECK (resume_after_turn IS NULL OR resume_after_turn >= 0);`,
  },
];
