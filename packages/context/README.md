# @hypertest/context

The layered **Context Engine** (L0–L5). The model never owns canonical state: it sees projections that point at
an immutable, content-addressed `ContextSnapshot`. **A snapshot is a projection, never truth.** Truth stays in
collab (events, blackboard), evidence (ledger), operation (ledger/leases) and the spec stores. Mutating actions
re-check the snapshot's read set against those stores (`FreshnessGuard`).

| Layer | Component | Module |
|---|---|---|
| L0 event store | read only (collab `EventStore`) for provenance | – |
| Snapshots | `SnapshotStore`, `SnapshotBuilder`, `FreshnessGuard`, `ResolverRegistry` + built-in resolvers | `snapshots.ts`, `freshness.ts`, `resolvers.ts` |
| L1 prompt assembly | `PromptAssembler` | `assembler.ts` |
| L2 working context | `WorkingContextManager`, `deterministicSummarizer`, `offloadToolResult` | `working.ts` |
| L3 retrieval | `ExactSearch`, `SymbolIndex`, `HashEmbedder`, `InMemoryVectorIndex`, `createPgVectorIndex`, `HybridRetriever` | `retrieval/*` |
| L4 durable memory | `createExperienceStore` (SQL), `PowerContextClient` (HTTP) | `experience.ts`, `powercontext.ts` |
| L5 provenance | `createProvenanceService` | `provenance.ts` |

Depends on `core`, `domain`, `collab`, `evidence` only. No third-party dependencies (ripgrep is used as an
external binary when it is on `PATH`).

## API (`src/contracts.ts` is the ABI)

### Snapshots and freshness

- `contextMigrations`: `context/001-snapshots` (`ht_context_snapshots(snapshot_id pk, run_id, content jsonb,
  created_at, ord bigserial)`, index `(run_id, created_at)`; `ord` breaks same-millisecond ties for `latest`)
  and `context/002-experience` (`ht_experience`). `ht_vectors` is never created by migrations (see pgvector).
- `createSnapshotStore({db, ids, clock, logger, events?})`
  - `create(content, ctx)`: `snapshotId = 'cs_' + sha256(canonicalJson(content without snapshotId/createdAt))[0..40]`
    (`snapshotIdFor`). `INSERT … ON CONFLICT DO NOTHING`: identical content returns the **stored** snapshot
    (original `createdAt`) and emits nothing; a new row emits `context.snapshot_created` in the same transaction
    (the snapshot's run). Input is validated (`invalid_argument`); strings are made jsonb-safe (lone surrogates →
    U+FFFD, NUL rejected) before hashing so the stored content always re-hashes to its id.
  - `get(id)` re-hashes the stored content: a row edited behind the store is `integrity_violation`. Returned
    snapshots are deep-frozen. `latest(runId)`.
- `createSnapshotBuilder({…, snapshots, sources, resolvers})` → `build(input, ctx)`: reads `SnapshotSources`
  (structurally: `RunRepository.get`, `EventStore.lastSeq`, `Blackboard.revision`, `EvidenceLedger.rootHash`, an
  experiment-revision map). The read set **always** contains `{oracle, oracleId, String(rev), exact_version}` per run
  oracle and `{environment, id, "<generation>:<buildDigest>", exact_version}` when `input.environment` is given, plus
  the caller's entries; it is sorted and de-duplicated. Unknown run ⇒ `not_found`. `eventSeq` is the L0 position
  observed before the snapshot's own event, so the next build sees `eventSeq + 1`.
- `createResolverRegistry(resolvers?)` (Map; re-registering a type replaces it) and built-in resolvers over structural
  ports: `environmentResolver(getEnv)` (`"<generation>:<buildDigest ?? ''>"`), `oracleResolver(getOracle)` and
  `experimentResolver(getExperiment)` (`String(revision)`), `recordResolver(head, {resourceType?})` (version = head
  `recordId` of a lineage; register as `finding` to catch withdrawn findings), `leaseResolver(current)`
  (`"<owner>:<fencingToken>"`), `fileResolver(root)` (sha256 of the content; `..`/absolute ⇒ `invalid_argument`,
  symlink escape ⇒ `permission_denied`, missing ⇒ undefined), `functionResolver(type, fn)`.
- `createFreshnessGuard({…, snapshots, resolvers?})` → `validate(snapshot | id, action, ctx)`:
  - a malformed action (`mutating` not a boolean, `resources` not a string array, empty `tool`) ⇒
    `invalid_argument` — it is never mistaken for a read-only action;
  - read-only actions ⇒ `{fresh: true, checked: 0}` without loading the snapshot or calling any resolver;
  - mutating actions check every non-immutable entry whose type is `environment|build|oracle|experiment|lease`, plus
    entries named by `action.resources` (equal id or hierarchical `a/b` ⊂ `a` overlap, bare or prefixed with the
    entry type: `file:src` names file `src/a.ts`); `max_age` by the injected clock (`now − observedAt > ms` ⇒
    `expired`), `exact_version` via the resolver (`version_changed` with `currentVersion`, `missing`);
  - the snapshot's **pinned** versions (`environment`, `oracleRevisions`, `experimentRevisions`; `pinnedEntries`) are
    validated as `exact_version` entries as well, even when the read set has no matching entry (a snapshot created
    directly through the store), and an inconsistent read-set entry never shadows them — so compose the guard with
    an `experimentResolver` whenever runs carry experiments;
  - **fail closed**: no resolver ⇒ `no_resolver`; resolver throws ⇒ `resolver_error`; unknown snapshot id ⇒
    `{resourceType: 'context_snapshot', reason: 'missing'}`; a snapshot *object* whose content no longer hashes to
    its id is not trusted (the stored snapshot decides; none stored ⇒ `missing`); stale results emit
    `context.stale_rejected` `{snapshotId, tool, resources, checked, stale}`.

### L1 `PromptAssembler.assemble(input)`

`[system, user "# Context", ...transcript]`. System = `rolePrompt` + `\n\n## Testing methodology protocol (BUGate)\n`
+ protocol context (when given) + `## Policy` notes + `Context snapshot: <id>`. The Context message holds the sections
ordered by priority (lower first; ties keep input order) as `## <title>\n<content>`. Budget for sections =
`budgetTokens − system − transcript − overhead` (domain `estimateTokens`; per-part rounding makes it slightly
conservative). Order of reduction: per-section `maxTokens` (content), then non-required sections dropped from the
least important upward, then required sections truncated least important first with `…[truncated]` (never dropped;
at worst `## Title\n[truncated]`). Transcript messages are never dropped: if they alone exceed the budget the result is
returned over budget and the caller must condense. Returns `droppedSections`, `truncatedSections`, `tokens`.

### L2 working context

- `createWorkingContextManager({keepRecentTurns=4, softRatio=0.7, hardRatio=0.95, summaryRatio=0.2,
  maxToolResultTokens=8000})`.
- `view({transcript, compactions, budgetTokens})`: entries sorted by turn (stable). With compactions, the **last** one
  is used: `Summary of earlier work (turns 0..N): <summary>\nEvidence referenced: …` + entries with `turn > N`. The cut
  moves earlier whenever a kept tool result's call would be summarized (parallel calls, late results), so tool
  results are never orphaned. Tool results over `maxToolResultTokens` are shown truncated (I9 defence in depth).
  `pressure`: `≥ hardRatio` ⇒ `hard`, `≥ softRatio` ⇒ `soft`.
- `condense({…, level})`: `upToTurn = maxTurn − keepRecentTurns` moved to a clean boundary (after all results of
  the calls at or before it). `hard` is mandatory and keeps fewer recent turns until the condensed view fits under the
  soft ratio; `soft` (or `hard` with nothing at all to condense) with nothing new ⇒ `precondition_failed` (callers may
  defer soft). The summarizer gets `[previous summary] + messages in (prevUpTo, upToTurn]` and instructions to
  preserve goals, decisions, tool calls + outcomes, errors, evidence/record ids and open questions.
  `evidenceRefs` = previous refs ∪ every `/\bev_[A-Za-z0-9]+\b/` in the range; any evidence id (and `rec_…`/`wi_…`
  id) the summarizer dropped is re-appended to the summary. The transcript is never modified: L0/SessionStore keep
  everything, so compaction is reversible (a view without compactions is the original transcript).
- `deterministicSummarizer`: extractive (per step: intent sentence, tool calls with argument digest, result status +
  first line, errors, ids), strictly bounded by `maxTokens` (ids first, then errors, then the step log).
- `offloadToolResult(artifacts, message, {thresholdBytes=16 KiB, previewBytes=2 KiB})` (I9): larger results go to the
  `ArtifactStore`; the message keeps a UTF-8-safe preview plus `artifact <uri> sha256:<hex>`.

### L3 retrieval

- `new ExactSearch({root, ripgrep: 'auto'|true|false, maxFileBytes=1 MiB})`: literal smart-case search. With `rg` on
  `PATH`: `execFile(rg, ['--json','-n','-S','-F','-m',limit,'--no-config','--no-require-git','--no-ignore-parent',
  '--no-ignore-global','--no-ignore-dot','--no-ignore-exclude','--max-filesize',…,'-g','!node_modules','-g','!dist',
  '-g','!.hypertest','--', text, '.'])` (no shell). Otherwise a JS walker with the same rules (hidden entries, `.git`,
  `node_modules`, `dist`, `.hypertest`, symlinks and files > 1 MiB skipped; only `.gitignore` files under the root
  apply, nested and with negation, an invalid pattern line is skipped on its own like ripgrep does). A file with a
  NUL byte **anywhere** is binary for both engines (ripgrep only stops at the NUL, so its matches in such files are
  dropped); non-UTF-8 lines/paths (`{bytes}` in rg's JSON) are decoded lossily like the walker does.
  Positive globs would override `.gitignore` in ripgrep, so `query.root`, `pathGlobs` (`*`, `**`, `?`, `[…]`, `!neg`;
  a glob without `/` matches the basename) and `kinds` (`code|test|doc` by path) are applied to parsed results:
  `query.root` is a filter over a walk from the root, so a hidden, vendored or git-ignored root yields nothing on both
  engines, and a file root searches that file. Both engines return identical hits `{source:'exact', ref:{kind:'file',
  id: relPath}, path, line, snippet, score}` with score from line/file match counts and the first-match column.
  `query.root`/globs that are absolute or contain `..`, globs that do not compile, and non-finite limits ⇒
  `invalid_argument`; a subdirectory resolving outside the root ⇒ `permission_denied`.
- `new SymbolIndex({root, languages?})`: `build()`, `findDefinitions(name)`, `findReferences(name)`, `search(q)`
  (`q.symbol ?? identifiers in q.text`; exact definition 1.0, case-insensitive prefix 0.7, word-boundary reference 0.3).
  Extraction: TS/JS `function`, `class`, `interface`, `type`, `enum`, `const X = {…}` (`const_object`), top-level
  `const/let/var`, arrow functions, class methods and arrow properties (brace-depth class scope, strings/comments
  stripped); Python `class`, `def`, `async def` (methods by indentation scope, docstrings skipped); Go `func`,
  receiver methods (container = receiver type), `type X struct|interface`, other `type`, `type (…)` blocks,
  `var/const`. The index is built lazily on first use; call `build()` again to refresh (when builds overlap, the
  latest `build()` call wins even if an older one finishes later). `query.root` may name a directory or a file.
- `new HashEmbedder({dims=256})`: lowercase alphanumeric tokens with camelCase/snake splitting, FNV-1a feature hashing
  with a sign hash, L2-normalized (`modelId = hash-v1-<dims>`).
- `new InMemoryVectorIndex(embedder)`: cosine; `query.kinds` filters by `namespace`; `query.root` keeps documents whose
  `path` lies inside it (documents without a path never match a root).
- `await createPgVectorIndex(db, embedder)`: `CREATE EXTENSION IF NOT EXISTS vector` (failure ⇒ `unsupported`), then
  lazily `ht_vectors(id, namespace, model_id, ref jsonb, path, line, text, embedding vector(dims), PRIMARY KEY
  (model_id, id))` under an advisory lock (a table from the earlier `id`-only primary key is upgraded in place).
  Indexes of different embedders share the table without overwriting or removing each other's rows; rows of another
  `modelId` are never compared. Search orders by `embedding <=> $1::vector` ascending, score = `1 − distance`,
  `query.root` is applied in SQL; an existing table with other dimensions ⇒ `conflict`.
- Both vector indexes check the embedder's answer: one finite vector of `dims` numbers per text, else
  `provider_error` (never a silently zeroed embedding).
- `new HybridRetriever(children, {k=60})`: RRF `Σ 1/(k + rank)`, dedupe by `ref.kind:ref.id(:line)`, first-seen hit
  represents a group, ties keep first-seen order; a failing child is logged and skipped (all failing ⇒ throw).

### L4 durable memory

- `createExperienceStore({…, events?})` (`ht_experience`): `propose` ⇒ `candidate` + `experience.proposed`;
  `review(id, 'review'|'approve'|'publish'|'reject'|'quarantine', reviewer)`: reviewer = creator ⇒
  `permission_denied` — ids compared trimmed and case-insensitively (`sameActor`), and the acting `ctx.actorId` /
  `ctx.agentId` must not be the creator either (`creatorActing`: the creator cannot review "as" someone else); transitions `candidate→reviewed|approved|rejected|quarantined`, `reviewed→approved|rejected|
  quarantined`, `approved→published|quarantined`, `published→quarantined` (else `precondition_failed`; a repeated
  identical decision by the same reviewer is idempotent); row locked `FOR UPDATE`; emits `experience.reviewed`
  and keeps a `history` trail; the row and its event commit in one transaction. `retrieve` returns **only**
  `approved|published` items (filter in SQL and again in code), scope fields the item leaves unset are global,
  relevance = query-term overlap; a non-finite `limit` ⇒ `invalid_argument`. `list(filter)`.
- `new PowerContextClient({baseUrl, apiKey?, timeoutMs, fetchImpl?, paths?, logger?})`: `POST /v1/experiences`,
  `POST /v1/experiences/{id}/review`, `POST /v1/context/prepare` (`{query, scope, limit}` → `{items}`),
  `GET /v1/experiences?status=a,b&sourceRunId=`. Errors: 5xx/network/timeout ⇒ `unavailable` (retryable), 429 ⇒
  `rate_limited`, 401/403 ⇒ `permission_denied`, 404 ⇒ `not_found`, 409 ⇒ `conflict`, 412/422 ⇒
  `precondition_failed`, other 4xx ⇒ `invalid_argument`, bad JSON ⇒ `provider_error`. The `timeoutMs` deadline
  covers the whole exchange: a server that sends headers and then stalls is `unavailable` (timeout), never an empty
  answer. Client-side invariants: known self-reviews (same `creatorActing` rule) are refused without a request; a
  server that accepts a self-review ⇒ `integrity_violation`; a review answer for another id or with another status
  than the decision asked for ⇒ `provider_error`; `propose` must keep `createdBy` (else `provider_error`);
  `retrieve` drops anything not approved/published **or outside the requested scope**, and `list` re-applies its
  status/run filter (a service ignoring a parameter cannot widen results).

### L5 provenance

`createProvenanceService({evidence, events, records, maxDepth=16})` (the real `EvidenceLedger`, `EventStore` and
`Blackboard` satisfy the ports). Node refs are `ProvenanceRef` (domain `Ref` kinds plus `tool_invocation`, `event`,
`agent`, `environment`, `claim`); edges use node keys `"<kind>:<id>"` (`nodeKey`).

- `traceEvidence(id)`: evidence `-produced_by->` tool invocation (tool.* events with `payload.invocationId`)
  `-operation->` operation (`evidence.operationId` or the tool event's `payload.operationId`; operation.* events),
  evidence `-executed_in->` work item (work.* events), tool/evidence `-produced_by->` agent, evidence
  `-executed_in->` environment, evidence `-commit->` commit, evidence `-derived_from->` parent evidence (recursive).
  Gaps (⇒ `complete: false`): unknown evidence, no tool invocation id, no tool events, operation without events, no
  work item, work item without events, no agent, neither environment nor commit, lineage deeper than `maxDepth`, and
  every inconsistent link: `toolInvocationId` ≠ `provenance.toolInvocationId`, tool events of another tool than
  `provenance.toolId`, an operation of another tool invocation or work item, tool events of another work item or
  agent, `agentId` ≠ `producer.agentId`.
- `traceRecord(id)`: record `-cites->` each cited evidence (traced), record `-caused_by->` its creation event
  (`aggregateType 'record'`, `payload.recordId`) and the `causationId` chain (`-caused_by->`); no evidence cited,
  no creation event, and cited evidence of **another run** (outside the run's hash chain / Merkle root) are gaps.
- `traceClaim(claim)`: claim `-cites->` evidence; complete only if every ref traces completely (no refs ⇒ gap).

## Invariants and where they are proven

| Invariant | Failure injected | Test |
|---|---|---|
| Snapshot = content address; idempotent; event only on insert (I10) | re-create with reordered keys + forged id/createdAt; 8 concurrent identical creates | `test/snapshots.test.ts` |
| Snapshot is immutable | mutate returned object; `UPDATE` the jsonb row ⇒ `integrity_violation` | `test/snapshots.test.ts` |
| Row + event atomic | event sink throws ⇒ nothing stored | `test/snapshots.test.ts` |
| I1 freshness before mutation, fail closed | env generation/digest bump, oracle revised, finding superseded, lease taken over, file edited, `max_age` expiry (FixedClock, boundary), missing resolver, throwing resolver, deleted resource, unknown snapshot id | `test/freshness.test.ts` |
| Malformed action never passes as read-only | `mutating` missing / `'yes'`, `resources` a string, empty tool, null snapshot | `test/freshness.test.ts` |
| Pinned snapshot versions are always re-validated | snapshot created directly with env/oracle/experiment fields and an empty read set; each bumped; no experiment resolver; read-set entry contradicting the pinned field | `test/freshness.test.ts` |
| Guard trusts only content-addressed snapshots | observed version "refreshed" in a copied snapshot object; hand-made object never stored | `test/freshness.test.ts` |
| Read-only actions never blocked, no resolver calls | resolver call counter; unknown snapshot id | `test/freshness.test.ts` |
| Resource-scoped checks | changed file not named / named (id, `type:id`, parent dir, `type:parent`); other types' prefixes; immutable entry named | `test/freshness.test.ts` |
| Content address covers every key | `__proto__` key in a revision map (was silently dropped) | `test/snapshots.test.ts` |
| L1 budget order; required never dropped | budgets forcing drops/truncation; tiny budget; transcript over budget | `test/assembler.test.ts` |
| L2 never orphans tool results | parallel calls with late results; every cut −1..7 | `test/working.test.ts` |
| L2 evidence ids survive condensation | summarizer that drops every id; second condensation | `test/working.test.ts` |
| Hard condensation is mandatory | turns too large for the default keep window | `test/working.test.ts` |
| I9 bounded model-visible outputs | 110 KB tool result: offload + view truncation + summarizer input | `test/working.test.ts` |
| L3 root confinement | `..`, absolute root/globs, symlinked dir and file escapes, nested/negated `.gitignore`, binary, > 1 MiB | `test/retrieval.test.ts` |
| rg and JS engines agree | identical hit lists for 6 queries; plus NUL inside/beyond rg's first buffer, invalid `.gitignore` line, `.git/info/exclude`, non-UTF-8 line, hidden/vendored/ignored/file query roots (exact expected paths asserted on the JS walker even without rg) | `test/retrieval.test.ts` |
| Invalid limits/globs are faults, not empty results | NaN/Infinity/string limits on every retriever (rg reported `internal`, others returned `[]`); `[z-a]` globs | `test/retrieval.test.ts` |
| Latest SymbolIndex build wins | tree changed mid-walk (signal hook) and a second build started; the stale first build finishes last | `test/retrieval.test.ts` |
| Vector scope + embedder sanity | `query.root` (incl. `..`/absolute); wrong dims, NaN, missing vectors ⇒ `provider_error` | `test/retrieval.test.ts` |
| pgvector fails closed | PGlite without the extension; PostgreSQL without pgvector; dims conflict; foreign model rows | `test/pgvector.test.ts`, `test/pgvector.int.test.ts` |
| pgvector models never clobber each other | same doc id upserted / removed by a second model; old `id`-only primary key upgraded; root scoping in SQL | `test/pgvector-shared.ts`, `test/pgvector.test.ts` |
| L4 only approved/published retrieved; reviewer ≠ creator | candidate/reviewed/rejected/quarantined items; self-review for every decision; case/whitespace variants; creator acting via `ctx.actorId`/`agentId`; racing reviewers | `test/experience.test.ts` |
| L4 row + event atomic | event sink throws during propose / review ⇒ no row / status unchanged | `test/experience.test.ts` |
| L4 over HTTP keeps the same invariants | server leaks candidates/quarantined items or other projects' items; ignores list filters; accepts a self-review (also via the acting actor); answers another status / id; rewrites `createdBy`; 503; hang; stalls after headers; bad JSON | `test/powercontext.test.ts` |
| L5 gaps are explicit | missing tool events, operation events, work item, agent, env/commit; inconsistent invocation id, tool id, agent, operation/tool work item; record citing evidence of another run; unknown evidence/record; record citing nothing | `test/provenance.test.ts` |

## Testing

```bash
npx tsc -p packages/context --noEmit
node scripts/run-tests.mjs --package context                            # PGlite (+ local PostgreSQL int tests)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package context # every DB test on PostgreSQL 16
```

One database per test file (`createTestDatabase` clones a migrated PGlite template). The provenance, builder and
resolver tests use the real collab `EventStore`/`Blackboard`/`SpecRepository` and evidence `EvidenceLedger`.
`test/pgvector.int.test.ts` needs `HYPERTEST_TEST_PG_URL`; its positive case skips with an explicit reason when the
server has no pgvector (the local infra server does not), and the `unsupported` path is then asserted on PostgreSQL.
The ripgrep-vs-JS test skips with a reason when `rg` is not on `PATH`.

## Contract changes (additive, backward compatible)

- `StaleEntry.reason` adds `'resolver_error'`; `StaleEntry.error?`.
- `WorkingContextOptions` (named options type, adds `summaryRatio`, `maxToolResultTokens`).
- `ExactSearchOptions`, `SymbolIndexOptions`, `SymbolLanguage`, `SymbolKind`, `SymbolDefinition`, `SymbolReference`;
  `SymbolIndex.build()/findDefinitions()/findReferences()`.
- `ExperienceDecision` (named union, adds `'review'` ⇒ status `reviewed`); `PowerContextOptions`.
- `ProvenanceRefKind`/`ProvenanceRef` (supertype of `Ref`) for `ProvenanceNode.ref` and `ProvenanceTrace.root`.
- `createFreshnessGuard` accepts `resolvers?`; `createPgVectorIndex(db, embedder)` is async (the header comment said
  `(db, dims)`; the embedder is needed to embed and to tag rows with its `modelId`).
- Extra exports: resolver factories, `snapshotIdFor`, `offloadToolResult`, id extractors, helper constants,
  `pinnedEntries`, `sameActor`, `creatorActing`, `resolveLimit`.
- Behavioural clarifications from the v0.3 review (see the header of `src/contracts.ts`): malformed freshness actions
  are `invalid_argument`; pinned snapshot versions are always validated; `type:parent` resources match; the acting
  `ctx.actorId`/`agentId` counts for reviewer ≠ creator; vector indexes honour `query.root`; `ht_vectors` is keyed
  by `(model_id, id)`.

Events emitted that are not in the domain `EVENT_TYPES` catalog: `experience.reviewed` (aggregate `context`).
