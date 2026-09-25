# @hypertest/collab

The canonical collaboration/domain database of Hypertest: the L0 event store, the transactional outbox and
inbox, the event buses (in-process and NATS JetStream) and the Blackboard (records, work items, plans), plus
the revisioned stores for runs, specs (system models, oracles, oracle change proposals, experiments, test
artifacts) and quality decisions. Owns invariants **I5** (at-least-once delivery never duplicates side
effects or work) and the storage half of **I10** (every state change emits an L0 event in the same
transaction).

PostgreSQL is the truth; the bus is only a notification channel.

```
state row + ht_events + ht_outbox   (one transaction, per-run lock row ht_run_counters)
        │  OutboxRelay (publish, then mark sent ⇒ at-least-once)
        ▼
EventBus (InProcessEventBus | NATS JetStream)   duplicates possible
        │
        ▼
consumer tx: Inbox.tryConsume(consumer, eventId, tx) + side effect   ⇒ exactly one effect
```

## Public API (`src/index.ts`)

| Export | Notes |
|---|---|
| `collabMigrations` | `collab/001-events`, `002-blackboard`, `003-specs`, `004-work-fencing` (all tables `ht_*`, PGlite + PostgreSQL 16). |
| `createEventStore(deps)` → `EventStore` | `append(events, tx?)`, `emit` (DomainEventSink), `read`, `get`, `lastSeq`, `causalChain`. |
| `createInbox(deps)` → `Inbox` | `tryConsume(consumer, eventId, tx?)` (`INSERT … ON CONFLICT DO NOTHING`), `consumed`. |
| `createOutboxRelay({...deps, bus, pollMs?, batchSize?})` → `OutboxRelay` | `flush`, `start`/`stop` (unref'd timer), `pending`. |
| `new InProcessEventBus(options?)` | JetStream-like semantics + fault injection (see below). |
| `connectNatsEventBus(options)` → `EventBus` | `@nats-io/transport-node` + `@nats-io/jetstream`, durable pull consumers, explicit acks. |
| `createBlackboard({...deps, events})` → `Blackboard` | records, work items, plans, `revision(runId)`. |
| `createRunRepository`, `createSpecRepository`, `createDecisionRepository` | each takes `{...deps, events}`. |
| `workEventType`, `runEventType`, `sanitizeDurableName`, `toWireSubject` | pure helpers (exported for reuse/tests). |

All writers accept an optional `tx`; without it (or when the database itself is passed as `tx`) they open
their own transaction. Every writer takes the per-run lock row **first**, so writers of one run serialize in
one lock order (no deadlocks, gap-free `seq` and blackboard `revision`). Spec writers then take a per-spec-id
advisory lock (two-int4 key space, disjoint from other packages' locks). Malformed input is rejected with
`invalid_argument` before anything is written (never an `internal` SQL error).

### Semantics worth knowing

- **Event store.** `seq` is per run and gap-free (rolled-back appends leave no hole). `eventId` defaults to
  `ids.next('evt')`; re-appending an explicit `eventId` returns the stored event (idempotent retry), reusing it
  for a different event is `conflict`. `occurredAt` is normalized to `toISOString()`. The outbox envelope is
  `{eventId, subject: ht.<runId>.<eventType>, eventType, runId, data: DomainEvent, publishedAt}`.
  `causalChain(id)` returns root → … → id (stops at a non-event causation id; cycle-safe). Payloads may be any
  JSON value: they are read as `jsonb::text`, so a string payload round-trips (the drivers pre-decode jsonb).
- **Records.** Immutable; `supersedes` must name the current head of the lineage (`conflict` otherwise, with
  `details.head`); new version = old + 1, same `lineageId` (the first record's id). Events: `finding.created|
  updated` (+ `finding.confirmed|rejected` when the status newly becomes that), `hypothesis.created`
  (+ `supported|refuted` on the status change), `coverage.gap_detected` / `risk.identified` on creation,
  `review.completed`, else `record.posted`. Payload: `{recordId, lineageId, recordType, version, revision,
  status, previousStatus, severity, category, title, …}` — small, reactor-oriented. The event's `workItemId` is
  the context's, else the record's.
- **Work items.** `createWorkItem` defaults to `ready`; duplicates by `(runId, fingerprint)` return the
  existing item with `created: false`, no event and no revision bump. Store-owned fields (`claim`, `agentId`,
  `result`, `failure`, `attempts`, `waitingOn`, timestamps) passed at runtime are ignored. `transitionWorkItem`
  checks, in order, the fencing token (`stale_fence`), `expectedFrom` (`conflict`) and `canTransitionWorkItem`
  (`precondition_failed`); `claimed` requires a claim; `claim: null` clears it. **Entering `ready`, `blocked` or
  `proposed` always drops the claim** (a holderless item cannot be given one), so a worker whose lease was
  revoked is refused even if the requeue did not pass `claim: null`. **Fencing is monotonic per item**
  (`fence_high_water`): a claim with a token below the highest ever granted, or equal to it from a different
  lease, is `stale_fence`. A same-state call is a patch: a pure lease renewal (only `expiresAt` changes) emits
  nothing; a change of claim owner/lease/token, `agentId`, `attempts`, `priority`, `result`, `failure` or
  `waitingOn` emits `work.updated {…, changed}` (I10). Terminal items are immutable. Event mapping: claimed→`work.claimed`,
  running→`work.started`, waiting→`work.waiting`, completed/failed/cancelled→`work.*`, ready from
  claimed/running/waiting/failed→`work.requeued`, ready from proposed/blocked→`work.ready`,
  blocked→`work.blocked`. `causationEventId` defaults to `ctx.causationId`.
- **Plans.** `proposePlan` assigns `max(revision)+1`; `decidePlan('accepted')` supersedes previously accepted
  revisions (does not touch `run.currentPlanRevision`); accepting a revision **older** than the accepted one is
  `precondition_failed` (reject it instead); a repeated identical decision is idempotent; re-deciding
  differently is `precondition_failed`.
- **Runs.** `create` requires `status: 'created'` and a `runtimeManifestId`. `update` enforces
  `canTransitionRun` and emits `run.started|resumed|paused|converging|gating|completed|failed|cancelled`;
  non-status changes emit `run.updated {changed}`; a no-op emits nothing. The runtime manifest is pinned at
  creation and can never change, in any status (I11 defence in depth: a paused run is still live). Terminal
  runs only accept `decisionId`/`labels` changes.
- **Specs.** Append-only revisions per id; `supersedes` = previous revision. `saveOracle`/`saveTestArtifact`
  honour an explicit `revision` only if it is the next one (`conflict` otherwise — optimistic concurrency for
  governance). `listOracles`/`listExperiments`/`listTestArtifacts` return the latest revision per id.
  Oracle change proposals are created `pending`, their content is immutable and they are decided exactly once;
  an approval must name `decidedBy`, and the proposer can never approve its own proposal (`permission_denied`,
  I8 defence in depth; the proposer may still withdraw it by rejecting). Concurrent saves of one id — also from
  different run contexts — get consecutive revisions; an explicit `revision` still gives exactly one winner.
- **Decisions.** Append-only: the store assigns `revision = latest+1` and `supersedes = latest decisionId`; a
  signed decision must already carry those values (signed content is never rewritten). `findByOracleRevision`
  uses jsonb containment; `markNeedsReassessment` flags once and records `decision.recorded
  {needsReassessment: true, reason}` in the decision's own run.
- **InProcessEventBus.** The stream retains every message; a new durable starts at the beginning (deliver
  policy all); subscribers of one durable share deliveries round robin; one delivery per subscriber at a time,
  first deliveries in stream order; throw ⇒ redelivery after `ackWaitMs`; no ack within `ackWaitMs` ⇒
  immediate redelivery; `maxDeliver` (default 5) ⇒ `onDeadLetter`. Fault injection: `duplicateDelivery`
  (predicate, or probability 0..1 drawn from the injectable `random`) ⇒ a second delivery of the same envelope
  with `deliveryCount: 2`; `delayedAck(e)` ⇒ the ack of a handled delivery is delayed, and past `ackWaitMs` the
  already-handled message is redelivered. Publishes are not deduplicated. `drain(ms)` rejects with `timeout`
  instead of resolving early. `unsubscribe()`/`close()` wait (at most `closeGraceMs`, default 5 s) for handlers
  still running, so the caller can release the database right after.
- **NATS.** Stream `HYPERTEST` (configurable) on `<subjectPrefix>.>` (default `ht`), file storage, 2 min
  duplicate window, `msgID = eventId`. Durable pull consumers (ack explicit, deliver all, `ack_wait`,
  `max_deliver`, filter subjects; an existing durable is updated). Ack on success, `nak(ackWaitMs)` on throw,
  `term` + `onDeadLetter` at `maxDeliver` (ack/nak/term failures on a closing connection are logged, never
  allowed to end the consume loop). `drain` polls `num_pending + num_ack_pending` (nak'd messages awaiting
  redelivery count as pending). Durable names that need sanitizing get a hash of the original appended, so two
  distinct durables never collapse into one consumer.

## Invariants and where they are proven

| Invariant | Failure injected | Test |
|---|---|---|
| Gap-free per-run seq | 30 concurrent appends over 2 runs; rolled-back append | `test/event-store.test.ts`, `test/postgres.int.test.ts` |
| State + event + outbox atomic (I10) | tx throws after a blackboard write / append | `test/event-store.test.ts` (rollback tests), `test/work-items.test.ts` (tx rollback) |
| I5: duplicates never duplicate side effects | `duplicateDelivery: always`, relay crash between publish and mark, concurrent duplicate handlers on PG; negative control without inbox | `test/i5-duplicate-delivery.test.ts`, `test/postgres.int.test.ts`, `test/inbox-outbox.test.ts` |
| I5: duplicates never duplicate work items | 10 concurrent `createWorkItem` with one fingerprint | `test/work-items.test.ts`, `test/postgres.int.test.ts` |
| Stale workers refused (fencing, I4) | old token after requeue + re-claim; requeue without `claim: null`; older/re-used token after requeue; concurrent claims | `test/work-items.test.ts`, `test/postgres.int.test.ts` |
| Every work change audited (I10) | same-state claim takeover / attempts / priority patch | `test/work-items.test.ts` (`work.updated`) |
| Atomic writes even with `tx = db` | event append fails after the record insert | `test/event-store.test.ts` |
| L0 readable for any payload | string / JSON-looking string / null / array payloads | `test/event-store.test.ts` |
| Manifest pinned (I11) | manifest change while created, running, paused (+ resume) | `test/runs.test.ts` |
| No self-approved oracle change (I8) | proposer approves its own proposal | `test/specs.test.ts` |
| Plans never roll back | accept an older revision after a newer one | `test/plans.test.ts` |
| Work/run state machines | illegal transitions, terminal patches, expectedFrom races | `test/work-items.test.ts`, `test/runs.test.ts` |
| One head per lineage | supersede a non-head; 6 concurrent supersedes on PG | `test/blackboard-records.test.ts`, `test/postgres.int.test.ts` |
| Append-only specs/decisions | stale explicit revision, rewritten proposal/decision, double decision, 5 concurrent writers of one oracle from 5 runs | `test/specs.test.ts`, `test/decisions.test.ts`, `test/postgres.int.test.ts` |
| At-least-once relay, ordered | publish failure mid-batch, crash after publish, stop()+start() during an in-flight flush | `test/inbox-outbox.test.ts` |
| Bus redelivery / dead letter / queue semantics | throwing and hanging handlers, poison messages, delayed ack, close/unsubscribe with running handlers, colliding durable names | `test/inprocess-bus.test.ts`, `test/i5-duplicate-delivery.test.ts`, `test/nats.int.test.ts` |

## Testing

```bash
npx tsc -p packages/collab --noEmit
node scripts/run-tests.mjs --package collab                          # PGlite + local NATS/PostgreSQL
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package collab  # every DB test on PostgreSQL 16
```

`*.int.test.ts` need `HYPERTEST_TEST_NATS_URL` / `HYPERTEST_TEST_PG_URL` (from `.infra/env`, `npm run
infra:up`) and skip with an explicit reason otherwise. The NATS suite uses a private stream and subject root
per run and deletes the stream afterwards.

## Contract changes (additive, backward compatible)

- `OutboxRelay.pending(): Promise<number>`; named `OutboxRelayDeps` type for `createOutboxRelay`.
- `InProcessBusOptions.logger?`; `duplicateDelivery` also accepts a probability (the documented but untyped
  form); `delayedAck?`, `random?`, `closeGraceMs?`.
- `NatsBusOptions.subjectPrefix?` (default `ht`), `prefetch?` (default 16), `logger?`.
- `DecisionRepository.reassessment(decisionId)` → `{ needsReassessment, reason? } | undefined`.

Event types emitted that are not (yet) in `@hypertest/domain` `EVENT_TYPES`: `run.gating`, `run.updated`,
`work.blocked`, `work.updated`.
