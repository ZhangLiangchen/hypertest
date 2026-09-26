# @hypertest/operation

Authority for **what actually happened in the external world** (I4) and for experiment isolation and
budgets (I12). Every external/destructive side effect goes through the `SideEffectGateway` with a stable
`operationId`; unknown outcomes are reconciled, never blindly retried; stale workers are fenced off.

Depends on `@hypertest/core` and `@hypertest/domain` only. The ABI is `src/contracts.ts`.

## Public API

| Export | Purpose |
|---|---|
| `operationMigrations` | `operation/001-operations` … `007-open-reservations`: `ht_operations` (+ `experiment_id`, 006), `ht_fences`, `ht_leases`, `ht_admission_lock`, `ht_resource_claims`, `ht_budget_scopes`, `ht_budget_reservations` (+ idempotency key 005, open-reservation index 007) (PGlite + PostgreSQL 16). |
| `createOperationLedger(deps)` | `prepare` (idempotent by `idempotencyKey` and by `(toolInvocationId, operationType)`), `get`, `findBy*`, `transition` (domain state machine + optimistic concurrency), `list`, `listUnsettled`. Emits `operation.*` events in the same transaction. |
| `createLeaseService(deps)` | Write leases with monotonic fencing tokens: `acquire`, `renew`, `release`, `current`, `checkFence`. |
| `createSideEffectGateway(deps)` | `run` (retry switch), `observe` (durable polling), `compensate`. |
| `createReconciler(deps)` | `reconcile({ runId? })`: settles unsettled operations by observation on startup/resume; never dispatches. |
| `createResourceAdmission(deps)` | All-or-nothing admission of hierarchical `ResourceClaim`s (`read_shared` / `write_exclusive` / `fault_exclusive`); `compatibleHolders` (an experiment's work items share its claims); `held(holder)`. |
| `createBudgetLedger(deps)` | Budget leases: `open`, `reserve` (keyed, idempotent) → `settle` \| `release`, `charge`, `consume` (spent usage, never refused), `remaining`, `openReservations`, `releaseOpen`, `usage`. |
| `AdapterRegistry` | `register` (validates capabilities, duplicate ⇒ `conflict`), `get` (unknown ⇒ `not_found`), `has`, `list`. |
| helpers | `outcomeForOperation`, `operationEventType`, `operationExperimentId`, `UNSETTLED_OPERATION_STATUSES`, `BUDGET_DIMENSIONS`. |

## Gateway semantics (`run`)

1. Find the operation by `(toolInvocationId, operationType)`. Same id with a different input/run/adapter ⇒
   `conflict`. `verified` ⇒ recorded result; `failed` / `manual_review` / compensation states ⇒ recorded outcome.
2. `request.lease`: reuse (renew) the owner's live lease, else acquire; held by another live owner ⇒
   `failed` / `resource_busy` (no dispatch; a never-dispatched `prepared` operation is recorded `not_applied` with
   `lastError: resource_busy: …` — never an orphaned `prepared`; a retry re-enters through `not_applied → dispatching`).
   Without `request.lease`, a lease recorded on the operation (e.g. by the scheduler at prepare time) is used as the fence.
3. New operation: the id is generated first, `adapter.prepare()` sees it (labels), then `ledger.prepare()`.
4. Before any dispatch — and before a stale worker may drive reconciliation — `checkFence`; stale ⇒ `stale_fence`, status unchanged.
5. `prepared`/`not_applied` ⇒ persist `dispatching` (attempt+1) **before** `adapter.dispatch()`.
   Throw/timeout/abort ⇒ `outcome_unknown` (never `failed`): `pending` when the adapter supports lookup by
   operationId, otherwise `manual_review`. `accepted=false` ⇒ `not_applied`. Receipt ⇒ `acknowledged`, then
   observe + verify within `verifyWithinMs` (default: one observation).
6. `dispatching`/`outcome_unknown`/`reconciling` ⇒ `reconciling` → `observe()`: present ⇒ `acknowledged` →
   verify (attach, never re-create); absent ⇒ `not_applied` and **one** safe re-dispatch per call (unless
   `non_reconcilable` and risk ≥ high ⇒ `manual_review`); uncertain ⇒ `manual_review`. Unknown outcome with no
   lookup capability and risk ≥ high ⇒ `manual_review` without observing.
7. `acknowledged` ⇒ attach (observe + verify). Because the target acknowledged the job, `absent` is treated as
   *not yet observable* (`pending`), never as "not applied" — re-dispatching an acknowledged job could duplicate
   it; `uncertain` ⇒ `manual_review`. (The domain state machine has no `acknowledged → reconciling` edge.)
8. `reconcileOnly: true` (additive; the replay of a call decided on a snapshot that is stale by now): only the
   invocation's EXISTING operation is settled — recorded outcome, attach, reconcile — and nothing is ever dispatched:
   `prepared`/`not_applied` ⇒ `not_applied` (`dispatch_refused: …`), reconciled `absent` ⇒ `not_applied` (no safe
   re-dispatch), no operation ⇒ `not_found` (nothing recorded). A reconcile-only call never joins a normal drive.
   `find(toolInvocationId, operationType, runId)` returns the invocation's operation (run-scoped).
9. Outcome mapping for states without their own outcome: `compensated` ⇒ `not_applied`/`compensated`,
   `compensating` ⇒ `pending`, `prepared` (observe only) ⇒ `not_applied`/`not_dispatched`. The
   authoritative status is always `outcome.operation.status`.

Concurrency: duplicate deliveries in one process share one drive (single-flight). The single-flight map
and in-flight set are shared by **every** gateway and reconciler built over the same ledger instance, so a
second gateway instance never reconciles underneath a dispatch or compensation still running here. Every
transition uses `expectedFrom` + `expectedAttempt`; a concurrent move yields the other actor's recorded
outcome. Adapter `prepare`/`observe`/`verify` calls are bounded by the request's abort signal (an adapter
that ignores the signal cannot hang a drive or the Reconciler). A receipt that arrives after another actor
moved the operation is never dropped:
- same attempt, still `outcome_unknown`/`reconciling` ⇒ the receipt is recorded (`acknowledged`) and
  verified, so the other actor can no longer conclude `not_applied` and re-dispatch;
- already `not_applied` ⇒ recorded terminally (`failed`, outcome `manual_review`), never re-dispatched;
- a later attempt was started ⇒ orphaned duplicate: outcome `manual_review`, an `operation.late_receipt`
  audit event (`disposition: 'orphaned'`) and an error log;
- already `manual_review` ⇒ `operation.late_receipt` (`disposition: 'manual_review'`) keeps the receipt.

`externalJobId`/`externalReceipt` describe the current attempt: a transition to `dispatching` clears them
(the previous values remain in the event history), so reconciliation never observes a previous attempt's job.
The Reconciler, and `observe()` for a `dispatching` operation, skip operations whose recorded lease is still
live (the holder may be mid-dispatch in another process) and operations in flight in this process.

Compensation only from `verified` (an unknown outcome must be reconciled first ⇒ `precondition_failed`);
`compensating → compensated | manual_review`; an interrupted compensation is resumed by lookup; a
compensation still in flight in this process is never run a second time (`pending`).

Lease lifecycle (durability-3): the lease a `run()` drive holds is **released** as soon as the operation settles
(`verified`, `not_applied`, `failed`, `manual_review`, `compensated`) — the next owner is served at once, not refused as
`resource_busy` until the TTL — unless another drive in this process still uses the same lease (reference-counted) or
another unsettled operation of the run is recorded under it (an owner reuses its live lease: a job still running on the
resource keeps its exclusivity). A lease obtained for a call whose prepare fails (or that lost the prepare race to an
already settled operation) is released the same way.
While a drive polls (`verifyWithinMs`) it renews its lease at half its TTL. `observe()` extends (never shortens) the
live lease of an operation whose effect exists but is unsettled (`acknowledged`/`outcome_unknown`/`reconciling`) to
`GatewayDeps.leaseRenewTtlMs` (default 60 s), so a long-running job keeps its exclusivity while it is polled, and
releases it when the observation settles the operation. It never extends the lease of a `dispatching` operation: that
lease going stale is how a crashed dispatcher is detected. A busy refusal racing the lease holder's dispatch never
stops it (the holder dispatches from `not_applied` at the same attempt).

Leases: every grant (free, expired per the injected clock, or same-owner re-acquire) issues `previous + 1`
from `ht_fences.last_token` (never reused, survives release). `acquire` locks the fence row and the current
lease row, so a renewal in progress is never silently overwritten by a regrant. `renew` of an expired or
superseded lease ⇒ `stale_fence`. `checkFence` is true iff the token equals the live lease token and ≥ `highest_accepted`.

Budgets: scopes form an immutable parent chain (`open` is idempotent, also under concurrent opens); a reservation charges the listed scopes and all ancestors
atomically (rows locked in sorted order); the first violation is reported in caller scope order, then
`BUDGET_DIMENSIONS` order; missing limit = unlimited; `settle` records actual usage even above the
reservation/limit; settle-after-settle and release-after-finish are no-ops; `charge` never records an
exceeding amount. A `charge(…, { idempotencyKey })` is recorded once per key (transaction-scoped advisory lock on the
key + unique `idempotency_key` column): a replay returns the recorded reservation id without charging again; the same
key for other scopes/amounts ⇒ `conflict`; a refused charge records nothing (its retry is evaluated afresh).

Budget dimensions (unit B2, conformance-5): `computeMs` (wall time of sandbox processes) and `artifactBytes` (bytes
stored) are CONSUMED — recorded after the fact with `consume` (like `settle`: in full, even past a limit, never refused;
the first exhausted scope/dimension among the recorded ones is reported) — and bounded BEFORE they are spent by the
caller from `remaining(scopes)` (headroom = min over the chain of limit − used − reserved). `externalQps` is a RESERVABLE
rate: a load job reserves its request rate (keyed `reserve`, so a replayed start never reserves twice) and releases it
when the job ends; it is never `used`, so a rate refusal is transient and never exhausts a scope. `openReservations(scope)`
lists the still-open reservations of a scope chain (with their keys) for sweeps.

Experiment isolation (unit B2, conformance-6): `admit({ …, compatibleHolders })` treats the live claims of the named
holders as compatible — a work item that runs for an experiment (holder = experimentId) shares the experiment's claims
instead of being refused by them, while every other holder (another experiment, another run's item) still conflicts. The
holder's own live claims are always extended, never conflicting. `held(holder)` lists a holder's live claims. Operations
record the experiment they ran for (`PrepareOperationInput.experimentId`, `RunSideEffectRequest.experimentId` ⇒
`ht_operations.experiment_id`, returned as `LedgerOperationRecord.experimentId`, in the `operation.*` event payloads, and
filterable with `list({ experimentId })`); a deduplicated prepare keeps the first value.

## Invariants and where they are proven

| Invariant | Tests |
|---|---|
| I4 crash after external success, before ack ⇒ reconcile, exactly one job | `test/gateway.test.ts` (lost response; crash before ack persisted) |
| I4 ack then crash before verify ⇒ attach, not recreate | `test/gateway.test.ts` |
| I4 timeout/abort ⇒ `outcome_unknown`, never `failed` | `test/gateway.test.ts` (timeout, abort mid-dispatch) |
| I4 stale fencing token refused, zero dispatches | `test/gateway.test.ts` (3 stale scenarios), `test/leases.test.ts` |
| I4 absent ⇒ single safe retry; uncertain ⇒ manual_review; non-reconcilable high-risk ⇒ manual_review | `test/gateway.test.ts` |
| I4 duplicate delivery ⇒ one operation, one side effect | `test/gateway.test.ts`, `test/ledger.test.ts` (10 concurrent prepares), `test/postgres.int.test.ts` |
| I4 reconciliation never dispatches | `test/reconciler.test.ts` |
| I4 a reconcile-only replay settles (recorded result, attach, reconcile) and never dispatches (absent / not_applied / no operation) | `test/gateway.test.ts` › reconcileOnly |
| I4 monotonic fencing tokens (5 acquire/expire cycles), never reused | `test/leases.test.ts`, `test/postgres.int.test.ts` |
| I10 every transition emits an `operation.*` event atomically with the state change | `test/ledger.test.ts`, `test/reconciler.test.ts` |
| I12 admission conflicts (ancestor/descendant, read_shared compatibility), all-or-nothing | `test/admission.test.ts`, `test/postgres.int.test.ts` |
| I12 budget exhaustion typed, parent enforcement, settle > reserved, atomic charge | `test/budget.test.ts`, `test/postgres.int.test.ts` |
| I4 no reconcile under an in-flight dispatch (second gateway instance; `observe()` under a live lease) | `test/gateway-races.test.ts` |
| I4 late receipts: attached during reconciliation; orphan after re-dispatch surfaced, never dropped | `test/gateway-races.test.ts`, `test/gateway.test.ts` |
| I4 a re-dispatch never inherits the previous attempt's job id (no blind retry of high-risk no-lookup) | `test/gateway-races.test.ts`, `test/ledger.test.ts` |
| I4 non-cooperative adapters cannot hang `run()`/`reconcile()` after abort; compensation runs once | `test/gateway-races.test.ts` |
| I4 renewal vs regrant race: no lost renewal | `test/postgres.int.test.ts` |
| durability-3: a settled operation releases its lease (verified / not_applied / failed); another owner is served at once; observe extends the lease of a running job and releases it when it settles; never extends a dispatching operation's lease; a lease shared by two in-process drives is released only after both settle; a lease still guarding another unsettled operation is kept; a failed prepare releases its lease; a busy refusal records `not_applied` | `test/gateway.test.ts` › durability-3, › resource busy |
| H5: a keyed charge is recorded once (sequential and 6 concurrent duplicates), the limit still applies, refused charges record nothing, a reused key for other amounts/scopes ⇒ conflict | `test/budget.test.ts` › H5 |
| conformance-5: externalQps reserved across concurrent jobs (typed refusal, released rate fits again, never used); keyed reserve idempotent (6 concurrent duplicates hold the rate once, other amount ⇒ conflict); consume records past the limit and reports the exhaustion; remaining = chain headroom; openReservations | `test/isolation-budget.test.ts` |
| conformance-6: compatibleHolders share an experiment's claims with its work items while any other holder is still refused; held(); operations carry the experimentId (record, events, list filter, replay keeps the first) | `test/isolation-budget.test.ts` |

## Contract changes (additive, backward compatible)

- `PrepareOperationInput.operationId?` — pre-generated id (the gateway needs it before `adapter.prepare`).
- `OperationLedger.findByToolInvocation(toolInvocationId, operationType?)` — optional exact lookup.
- `OperationLedger.transition(..., { expectedAttempt? })` — rules out ABA across a re-dispatch cycle.
- `GatewayDeps.pollIntervalMs?`, `GatewayDeps.dispatchTimeoutMs?`, `RunSideEffectRequest.dispatchTimeoutMs?`.
- `ReconcileReport.failed?` — operations whose verification definitively failed during reconciliation.
- (eval review) `RunSideEffectRequest.reconcileOnly?` and `SideEffectGateway.find?(toolInvocationId, operationType,
  runId)` (optional member; `createSideEffectGateway` implements it) — see Gateway semantics 8.
- Documented outcome mapping for `compensated`/`compensating`/`prepared` (no new outcome statuses).
- (hardening) `BudgetLedger.charge(scopes, amounts, reason, options?: { idempotencyKey? })` (optional 4th argument;
  migration `operation/005-budget-charge-idempotency` adds `ht_budget_reservations.idempotency_key`).
- (hardening) `GatewayDeps.leaseRenewTtlMs?`; exported `DEFAULT_LEASE_RENEW_TTL_MS`. Behaviour: leases are released
  when an operation settles and extended while it is observed (see Lease lifecycle); busy-refused `prepared`
  operations are recorded `not_applied` (the domain state machine gained `prepared → not_applied`).
- (hardening, durability-1) `BudgetLedger.releaseOpen?(scope)` (optional member; `createBudgetLedger` implements it):
  releases every still-open reservation whose scope chain contains `scope` — the control plane's `recover()` calls it
  for the `work:<id>` of every claim it takes from a dead worker, so a crash between reserve and settle never shrinks
  the run's headroom for good. A later settle of a released reservation is `precondition_failed`.
- (unit B2, conformance-5) `BudgetDimension` gains `'externalQps'` (appended to `BUDGET_DIMENSIONS`, existing order unchanged);
  `BudgetLedger.reserve(…, options?: { idempotencyKey? })` (optional 4th argument); optional members `consume?`, `remaining?`,
  `openReservations?`; types `BudgetExhaustion` (the former inline exhaustion shape, unchanged), `ConsumeOutcome`,
  `OpenReservation`. Migration `operation/007-open-reservations` (index).
- (unit B2, conformance-6) `ResourceAdmission.admit` request `compatibleHolders?`; optional `ResourceAdmission.held?`;
  `PrepareOperationInput.experimentId?`, `RunSideEffectRequest.experimentId?`, `OperationLedger.list` filter `experimentId?`;
  type `LedgerOperationRecord` and helper `operationExperimentId(op)` (the domain `OperationRecord` has no such field yet).
  Migration `operation/006-operation-experiment` adds `ht_operations.experiment_id`.
- Documented (no signature change): `transition(→ dispatching)` clears `externalJobId`/`externalReceipt`
  unless the patch supplies them; `prepare` also treats a different `adapterId` as a `conflict`; the
  gateway emits `operation.late_receipt` audit events for receipts the ledger cannot store.

## Testing

```bash
npx tsc -p packages/operation --noEmit
node scripts/run-tests.mjs --package operation                          # PGlite + local Postgres int tests
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package operation # all tests on PostgreSQL 16
```

`test/helpers.ts` provides `FakeTarget`/`FakeAdapter` (scriptable prepare/dispatch/observe/compensate faults
and gates, call counters), `crashingLedger()` (the first transition to a given status throws, modelling a
worker crash at that point), `deferred()` and `waitForStatus()`. A second `createOperationLedger()` instance
over the same database models another process (no shared in-process state).
`test/postgres.int.test.ts` skips with an explicit reason when `HYPERTEST_TEST_PG_URL` is unset.
