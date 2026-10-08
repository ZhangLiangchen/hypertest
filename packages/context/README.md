# @hypertest/context

The layered **Context Engine** (L0–L5). The model never owns canonical state: it sees projections that point at
an immutable, content-addressed `ContextSnapshot`. **A snapshot is a projection, never truth.** Truth stays in
collab (events, blackboard), evidence (ledger), operation (ledger/leases) and the spec stores. Mutating actions
re-check the snapshot's read set against those stores (`FreshnessGuard`).

| Layer | Component | Module |
|---|---|---|
| L0 event store | collab `EventStore` (immutable); (B[8]) every agent transcript entry and compaction is recorded on it, and an agent's working context is rebuilt from it alone: `recordTranscriptOnL0`, `rebuildWorkingContext` | `transcript-l0.ts` |
| Snapshots | `SnapshotStore`, `SnapshotBuilder`, `FreshnessGuard`, `ResolverRegistry` + built-in resolvers | `snapshots.ts`, `freshness.ts`, `resolvers.ts` |
| Observed read set | `ObservationLog` (SQL), `observationsOf` (tool results → read-set entries), `observeToolRuntime` (the per-turn collector fed by every tool execution) | `observations.ts` |
| L1 prompt assembly | `PromptAssembler` | `assembler.ts` |
| L2 working context | `WorkingContextManager`, `deterministicSummarizer`, `offloadToolResult` | `working.ts` |
| L3 retrieval | `ExactSearch`, `SymbolIndex` (+ symbol graph: usages, writers, callers, import edges) over syntax trees (`parseTsJs`, `parsePythonFiles`, `parseGoFiles`), `HashEmbedder`, `OpenAICompatibleEmbedder`, `InMemoryVectorIndex`, `createPgVectorIndex`, `WorkspaceVectorRetriever` (chunked workspace corpus per root + commit), `HybridRetriever`, `createCodeToolRetrieval` (the code tools' port) | `retrieval/*` |
| L4 durable memory | `createExperienceStore` (SQL), `PowerContextClient` (HTTP), (B[4]) the memory service `createMemoryServiceHandler` / `listenMemoryService`, `withExperienceEvents` | `experience.ts`, `powercontext.ts`, `memory-service.ts` |
| Skills (learning) | (B[7]) `createSkillRegistry` (store-enforced: candidate → eval-validated → published → retired), `withTrialSkills`, `skillDigest`, `skillArmId`, `renderSkillMarkdown` | `skills.ts` |
| L5 provenance | `createProvenanceService` | `provenance.ts` |

Depends on `core`, `domain`, `collab`, `evidence` and one third-party package, `typescript` (5.9.3, Apache-2.0: the
compiler API parses TS/JS for the symbol graph; confined to this package by `scripts/check-boundaries.mjs`). External
binaries are optional: ripgrep (exact search), python3 (`ast`) and Go (`go/ast`) for the symbol graph — without them the
regex extractor is the per-file fallback.

## API (`src/contracts.ts` is the ABI)

### Snapshots and freshness

- `contextMigrations`: `context/001-snapshots` (`ht_context_snapshots(snapshot_id pk, run_id, content jsonb,
  created_at, ord bigserial)`, index `(run_id, created_at)`; `ord` breaks same-millisecond ties for `latest`),
  `context/002-experience` (`ht_experience`) and `context/003-observations` (`ht_context_observations`, append-only:
  UPDATE/DELETE/TRUNCATE refused by triggers, SQLSTATE 42501 — deleting an agent's latest observation would roll its
  pin back or drop it). `ht_vectors` is never created by migrations (see pgvector).
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
  observed before the snapshot's own event, so the next build sees `eventSeq + 1`. (additive) With `input.observer`
  (`{agentId}`, empty id ⇒ `invalid_argument`) and `deps.observations`, the agent's latest observation of every resource
  joins the read set — what it read or wrote through its tool calls up to this build: the NEXT turn's snapshot includes the
  current turn's observations. (B[0]) Nothing is dropped: there is no cap by default; an explicit `maxObservedEntries`
  that the agent's observations exceed fails closed (`precondition_failed`) instead of silently unpinning the oldest.
- `createResolverRegistry(resolvers?)` (Map; re-registering a type replaces it) and built-in resolvers over structural
  ports: `environmentResolver(getEnv)` (`"<generation>:<buildDigest ?? ''>"`), `oracleResolver(getOracle)` and
  `experimentResolver(getExperiment)` (`String(revision)`), `recordResolver(head, {resourceType?})` (version = head
  `recordId` of a lineage; register as `finding` to catch withdrawn findings), `leaseResolver(current)`
  (`"<owner>:<fencingToken>"`), `fileResolver(root)` (sha256 of the content; `..`/absolute ⇒ `invalid_argument`,
  symlink escape ⇒ `permission_denied`, missing ⇒ undefined), `functionResolver(type, fn)`, (additive)
  `workspaceFileResolver(getRoot)`: `file` ids `workspace/<workspaceId>/<path>` (the tools' resource keys) resolved in
  that workspace's root with fileResolver semantics; an unknown workspace is `not_found` (⇒ `resolver_error`, fail
  closed); another id form is `invalid_argument`.
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
  - (additive) with `deps.observations` and an acting agent (`ctx.agentId`), the agent's observations made under this
    snapshot (`snapshotId`: during the turn it fixes) refine the read set: each REPLACES the snapshot's entries of the same
    `(resourceType, resourceId)` — its own write or re-read is its current knowledge, so its own `fs.write` followed by
    `test.run` is not a "concurrent change", while a change by anyone else after it still is — and resources first
    observed in the turn are added (selected by the same rules). A log that cannot be read throws (the ToolRuntime turns
    it into `stale_context`). An entry observed as `ABSENT_VERSION` is fresh while the resource is still missing and
    `version_changed` once it exists;
  - **fail closed**: no resolver ⇒ `no_resolver`; resolver throws ⇒ `resolver_error`; unknown snapshot id ⇒
    `{resourceType: 'context_snapshot', reason: 'missing'}`; a snapshot *object* whose content no longer hashes to
    its id is not trusted (the stored snapshot decides; none stored ⇒ `missing`); stale results emit
    `context.stale_rejected` `{snapshotId, tool, resources, checked, stale}`.

### Observed read set (tool results → read-set entries)

- `createObservationLog({db, …})` → `ObservationLog`: `record(source, entries)` appends `ObservedEntry`s (a
  `ReadSetEntry` + `kind: 'read'|'write'`, validated; `source` = run, agent, work item, the turn snapshot the call ran
  against, tool id, invocation id); `latest({runId, agentId, snapshotId?, limit?})` = the latest observation per
  `(resourceType, resourceId)`, newest first. Durable (a resumed or re-claimed agent keeps what it observed).
- `observationsOf(call, result, ports)` — what a SUCCESSFUL tool call observed (every other status observes nothing):
  `fs.read` ⇒ `file` `workspace/<id>/<path>` at the sha256 the tool read; `git.show` with a path ⇒ `file` at the
  working-tree sha256 ONLY when the content it showed (at `rev`) is exactly the current file — the whole output reached
  the model (`modelText` is `structured.bytes` long) and hashes to it; a committed version that differs, a truncated or
  offloaded output, or a path the tree no longer has claims nothing (a `git.show HEAD` never launders another agent's
  uncommitted change into the agent's knowledge); `fs.write` / applied `fs.apply_patch` ⇒ own WRITE of the resulting
  sha256 (ABSENT for a deleted file); `blackboard.read` ⇒ `finding` (findings) / `record` lineages at the record id
  read; `blackboard.post_*` ⇒ own WRITE of the posted head; `metrics.query` / `metrics.scrape` ⇒ `metric_window`
  `<env/<id>|url/<host>>/metrics` — ONE window per target, the agent's latest metric data of it — with `max_age` = the
  query window (range end − start, at least `DEFAULT_METRIC_WINDOW_MS` = 60 s; instant queries and scrapes: 60 s): an
  action on that target (`env/<id>`, `url/<host>`) is refused once that data is older than its window, and any fresh
  metric observation of the target refreshes it (a per-query key could never be refreshed — the next window is another
  range — and would block the target for good); any call with `environmentId` ⇒ `environment` at its current
  `generation:buildDigest` (`ports.environmentVersion`; `env.*` tools: own WRITE — only while the environment is still
  at the generation the action's verified result names, so another agent's deploy landing right after it is never
  recorded as this agent's own knowledge).
- (B[0]) Further observing tools: `fs.search` and `code.symbols` / `code.references` pin the files of the lines they showed
  (content-verified: a line that no longer reads the same pins `unverified:<invocation>` for `fs.search` — a later action
  on the file is refused until it is re-read — and nothing for the index-based code tools; a symbol-graph row's
  `⟦usage in Owner.method⟧ ` annotation is stripped before the comparison); `git.blame` pins the current lines;
  `git.diff` of the working tree pins its files at their current version (ABSENT when deleted); `evidence.get` /
  `evidence.query` pin the evidence they returned (immutable); `plan.read` / `plan.propose_revision` the `plan`
  `run/<runId>/plan` at its accepted revision (`planResourceId`; `planResolver`); `experiment.define` the experiment
  revision; `oracle.get` / `oracle.list` the oracle revisions (`oracle.get` of an explicitly requested revision the run does
  not use is history and pins nothing — review: `oracle` is always checked, so such a pin would refuse every later action
  for good). Every finding the agent saw (a `blackboard.read` row, a
  post) also pins `finding_withdrawal` `<lineage>` = `active` | `withdrawn:<rejected|duplicate>`
  (`findingWithdrawalResolver`; always checked): a finding withdrawn after the agent saw it blocks its next mutating
  action until it re-reads it. The control plane also records what each PROMPT delivered (`context.assemble`
  observations: plan, blackboard records, code lines, skills, environments), so knowledge that only reached the agent
  through its prompt is pinned too. A finding merely LISTED among the open records is pinned as `record` (checked for the
  actions that name its lineage) plus `finding_withdrawal` (always checked); the always-checked `finding` version is
  pinned only for a finding the agent acts on (a work-item input, one it read in full or posted) — review: a confirmation
  or new evidence on any of up to 60 listed findings would otherwise refuse every mutating action of every agent.
- (B[1]) `createFreshnessPassLog({db, …})` (`ht_context_freshness_passes`, append-only): the durable record that a
  record-effect domain tool passed the guard for an invocation, so a resumed or replayed call is not re-judged against
  a later state.
- `observeToolRuntime(runtime, {log, logger, now?, environmentVersion?})` wraps a ToolRuntime-shaped object: every
  execution records its observations BEFORE the result is returned (the next call of the turn is validated against
  them). A recording (or mapping) failure fails closed for the read-only observing tools (`fs.read`, `git.show`,
  `blackboard.read`, `metrics.query`, `metrics.scrape`): the result becomes `failed` / `unavailable` with the output
  withheld (no `structured`, no artifacts) — content the read set does not pin would let a later mutation go unchecked.
  Any other tool's result (an effect that already happened) is returned unchanged and the failure logged: hiding it
  would invite a duplicate, and its missing observation only makes later checks stricter. `@hypertest/app` wraps its
  ToolRuntime with it, so every call the dispatcher makes feeds the log; the control plane's context provider builds
  each turn's snapshot with `observer: {agentId}`.

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
- (additive) `manager.options`: the resolved, frozen options. `softCondensationDue({transcript, compactions},
  keepRecentTurns)`: SOFT condensation is due only with ≥ `keepRecentTurns + 2` turns beyond the last compaction's cut
  (it then condenses ≥ 2 turns and keeps `keepRecentTurns` verbatim; the control plane condenses on soft pressure only
  then, with the LLM condenser only, deferring on any failure; HARD stays mandatory).
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
- `new SymbolIndex({root, languages?, goHelperDir?})`: `build()`, `findDefinitions(name)`, `findReferences(name)`, `search(q)`
  (`q.symbol ?? identifiers in q.text`; exact definition 1.0, case-insensitive prefix 0.7, word-boundary reference 0.3).
  (B[6]) Definitions and usages come from real syntax trees: the TypeScript compiler API for TS/JS/TSX/JSX
  (`parseTsJs`, in process), python3 `ast` (`parsePythonFiles`: one `python3 -I` subprocess per build, all changed files
  batched) and Go `go/ast` (`parseGoFiles(files, {helperDir})`: a helper program built once per `goHelperDir`). The helper
  runs in the Hypertest process, OUTSIDE every sandbox, so it is built only into the PRIVATE directory the caller names —
  `@hypertest/app` passes `<dataDir>/state/parsers`, which the local sandbox hides from every agent command — and never at a
  shared temp path (review: a sandboxed command running as the same user could replace a helper under `/tmp` and have the
  host execute it). Without `goHelperDir`, Go files use the regex fallback; a directory or binary that is not this user's
  private (not group/other-writable) file is never used; the build sees no host credentials, a private GOCACHE/GOPATH,
  `GOENV=off`, `GOPROXY=off`, `GOTOOLCHAIN=local`. python3 runs isolated (`-I`) with a minimal environment. Each definition carries its syntax-tree span
  (`endLine`): the enclosing definition of a reference is the innermost function / method / class / struct containing
  it. Usages are classified from the tree (assignment / `++` / `--` target ⇒ write, callee or `new` ⇒ call, import
  specifier ⇒ import, else read): a name inside a string or comment is never a write. A file a parser cannot handle (no
  python3 / go, a syntax error) falls back to the regex extractor below; `parserEngines()` says which engine parsed each
  file (`typescript`, `python-ast`, `go-ast`, `regex-fallback`). `build()` is incremental: every file is re-read, only a
  changed file is parsed again. `definitionsMatching(query, limit)`: definitions whose name contains the query.
  Regex fallback: TS/JS `function`, `class`, `interface`, `type`, `enum`, `const X = {…}` (`const_object`), top-level
  `const/let/var`, arrow functions, class methods and arrow properties (brace-depth class scope, strings/comments
  stripped); Python `class`, `def`, `async def` (methods by indentation scope, docstrings skipped); Go `func`,
  receiver methods (container = receiver type), `type X struct|interface`, other `type`, `type (…)` blocks,
  `var/const`. The index is built lazily on first use; call `build()` again to refresh (when builds overlap, the
  latest `build()` call wins even if an older one finishes later). `query.root` may name a directory or a file.
- (additive) Symbol graph: every reference carries `usage` (`import` > `write` > `call` > `read`; from the syntax tree, or
  for a regex-fallback file `classifyUsage` — `=`, compound assignment, `:=`, `++`/`--`; comparisons and arrows are not
  writes) and its `enclosing` definition (`Container.name`); `findReferences(name, limit,
  {usage?})`; `writers(target)` — "who writes X?", `Type.member` narrows to writes inside `Type`'s definitions or in files
  referencing `Type`; `callers(name)` (call edges enclosing → name); `imports(path?)` / `importers(path)` — import edges
  (`extractImports`: TS/JS `import … from`, `export … from`, bare `import`, `require()`/`import()`; Python `import` /
  `from … import` incl. relative modules; Go `import` lines/blocks) resolved to repository files by `resolveImport`
  (relative TS/JS incl. `.js`→`.ts` and `index.*`, Python modules/packages, Go module paths by directory suffix; never
  outside the repository). `search()` answers "who writes|assigns|sets|mutates|modifies|updates X" (writers, 0.9) and
  "who calls|invokes|uses X" (calls / all non-import references, 0.8) above plain references.
- `new HashEmbedder({dims=256})`: lowercase alphanumeric tokens with camelCase/snake splitting, FNV-1a feature hashing
  with a sign hash, L2-normalized (`modelId = hash-v1-<dims>`). The default embedder.
- (B[6]) `new OpenAICompatibleEmbedder({baseUrl, model, dimensions, apiKey?, headers?, timeoutMs=30 s, batchSize=64,
  fetch?})`: semantic embeddings over an OpenAI-compatible `POST <baseUrl>/embeddings` (`{model, input}` →
  `{data: [{index, embedding}]}`), batched; every answer is verified (one vector per text, ordered by `index`, exactly
  `dimensions` finite numbers; an empty text is sent as one space) — anything else, an HTTP error or a timeout is
  `provider_error`, and the API key never appears in an error. `modelId = openai-compatible:<model>:<dimensions>` (its
  pgvector rows never mix with the hashing embedder's). `@hypertest/app` uses it for `retrieval.embedder`.
- (B[6]) `createCodeToolRetrieval({logger?, maxRoots=16, goHelperDir?})`: the retrieval port of the agent code tools
  (`BuiltinToolOptions.retrieval`): `code.symbols` → `definitionsMatching` rows labelled `⟦definition <kind>
  <Container.name>⟧ <signature>`; `code.references` (`name` or `Owner.member`) → the definitions, then every reference
  classified from the syntax tree — writes, calls, reads, imports — labelled `⟦<usage> in <enclosing>⟧ <line>`, the
  writes of `Owner.member` narrowed like `writers()` ("who writes AccountState.version?"). One index per workspace root
  (LRU), rebuilt incrementally before every query so an agent sees its own edits. `stripSymbolAnnotation`.
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
- (additive) `chunkText(path, text, {maxLines=80, maxChars=4000})`: chunks at symbol definitions (TS/JS/Python/Go) or
  markdown headings, windows of ≤ `maxLines` otherwise, text capped at `maxChars`, blank chunks dropped.
  `gitHeadCommit(root)`: the checked-out commit read from git metadata files only (`.git` dir or `gitdir:` file, HEAD,
  worktree + common-dir loose refs, packed-refs), undefined outside a repository.
- (additive) `new WorkspaceVectorRetriever({root, embedder, sharedIndex?, cache?, version?, maxFiles=2000, maxFileBytes=256 KiB,
  maxChunks=5000, maxLines, maxChars, defaultLimit=10, logger?})` (`name: 'vector'`): the workspace files (ExactSearch's
  walk rules: hidden/vendored/.gitignore'd/binary skipped) are chunked and embedded LAZILY on the first search into a
  corpus keyed by root + `version(root)` (default `gitHeadCommit`; undefined ⇒ one corpus for the root's lifetime) — a
  new commit populates another corpus. Corpora live in a `VectorCorpusCache({maxCorpora=8})` (LRU; default a private
  cache of one): shared by the retrievers of a process it bounds memory whatever the number of parallel worktrees; an
  evicted corpus' documents leave a shared index and it is populated again on demand. Two workspaces never share a
  corpus (a worktree's own files, uncommitted edits included, never leak into another agent's retrieval). `sharedIndex()` (e.g. a memoized
  `createPgVectorIndex`) is used when it resolves to an index, else an `InMemoryVectorIndex` per corpus; documents are
  namespaced `<corpus>:<kind>` so workspaces sharing `ht_vectors` never see each other; non-file kinds match nothing.
  A failed population is retried by the next search. Uncommitted edits are not re-embedded until the commit changes
  (exact search and the symbol index cover live text).
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

- (B[4]) The memory SERVICE: `createMemoryServiceHandler({memory, apiKey?, logger?, maxBodyBytes=1 MiB})` /
  `listenMemoryService({…, host='127.0.0.1', port=0})` serve exactly the API `PowerContextClient` speaks (`GET
  /v1/health` without auth; the rest behind `Authorization: Bearer <apiKey>`, constant-time compared), over any
  `DurableMemory` — the process hosting it owns its storage (`@hypertest/app` `serveMemory` / `hypertest memory serve`:
  its own PGlite directory; `memory.kind: service`: a child process Hypertest starts and stops). The store's invariants
  hold server side, including reviewer ≠ creator against the calling actor the client names (`x-hypertest-actor-id` /
  `x-hypertest-agent-id`, URI-encoded); errors are `{error: {code, message}}` with the status the client maps back to
  the same code (400, 401/403, 404, 409, 412, 413, 429, 5xx). `withExperienceEvents(memory, {events})`: the decisions a
  remote memory accepted are also appended to this deployment's L0 (`experience.proposed` / `experience.reviewed`,
  deterministic ids: a retried call never appends twice).

### Skills (B[7], learning pipeline)

- `createSkillRegistry({db, events?, experiences, …})` (`ht_skills`, `ht_skill_validations`): approved experience →
  candidate SKILL → eval validation bound to the revision → published (the active registry) → retired.
  `propose({name, description, body, scope?, sourceExperienceIds, createdBy, skillId?})`: every source experience must be
  approved or published (else `precondition_failed`); the revision is content-addressed (`skillDigest` of name,
  description, body, scope). `recordValidation(skillId, revision, evalResult, {recordedBy, minPassRate=1, minTrials=1,
  baselineArmId?})`: counts only the trials of the arm bound to that revision (`skillArmId` =
  `skill-<id>-r<rev>-<digest12>`); passed ⇔ enough trials, pass rate ≥ minPassRate and not below the baseline (cold
  track) arm; a pass makes it `validated`. `minPassRate` must be in (0, 1] (review: a zero threshold let a skill whose
  every trial failed pass); migration `context/006-skill-validation-consistency` makes the database refuse a validation
  row whose `passed` contradicts its own numbers (no passing trial, too few trials, pass rate ≠ passes / trials or below
  the threshold or the baseline). A validation judges the SuiteResult it is given: `hypertest skill validate --suite`
  runs the eval itself; `--result <file>` trusts the operator-supplied file (its arm id must still be the revision's). `publish` (publisher ≠ creator; retires the previously published revision),
  `retire`, `reject`, `get`, `list`, `validations`; `forPrompt({role, text})`: PUBLISHED revisions only, scope-matched.
  Enforced in the DATABASE, not only here: a skill row is inserted as `candidate`; its content never changes;
  transitions are `candidate → validated | rejected`, `validated → published | candidate | rejected`, `published →
  retired`; `validated` and `published` require that the LATEST validation of that exact digest passed; one published
  revision per skill; no DELETE/TRUNCATE; validations are append-only. Events `skill.proposed|validated|
  validation_failed|published|retired|rejected` on L0.
- `withTrialSkills(registry, trial)`: an eval arm's `skills.trial` revisions (digest-checked, marked as candidates under
  evaluation) join `forPrompt` for that instance only; they never enter the registry. `skills.trial` is an ordinary
  configuration key: an instance configured with it shows those UNPUBLISHED revisions to its agents (marked), so
  `@hypertest/app` logs a warning at every start of such an instance.

### L0 as the root of context reconstruction (B[8])

- `recordTranscriptOnL0(sessions, {db, events, logger})` wraps the runtime SessionStore: every transcript entry a
  session commits (task input, model responses, tool results, drained inputs) is appended to L0 as
  `context.transcript_recorded` (per-session ordinal, deterministic id `transcriptEventId`) IN THE SAME TRANSACTION as
  the session write — a failed append rolls the write back, so the mutable session tables never hold history L0 lacks.
  Compactions are on L0 as `context.compacted` with their summary.
- `rebuildWorkingContext(events, runId, sessionId)` reconstructs the transcript and compactions from L0 alone; a gap, a
  duplicate ordinal or a compaction without its summary is `integrity_violation`.

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
  agent, `agentId` ≠ `producer.agentId`. An **observation** is lineage, not an inconsistency: when another invocation
  started the operation and the evidence's own invocation OBSERVED it — its own L0 tool events name the operation
  (e.g. `load.observe` recording a load job's results in the metrics analyst's work item) — the trace is evidence
  `-produced_by->` observing invocation `-observed->` operation `-started_by->` starting invocation (whose tool events
  must exist). An invocation whose events never touched the operation cannot claim it: still a gap.
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
| ReadSet from what agents observed: stale after a concurrent change | a file read in turn N and rewritten by another agent ⇒ the turn N+1 write is `stale_context` (`version_changed`); deleted ⇒ `missing`; a whole-workspace action too | `test/observations.test.ts`, control `test/context-readset.test.ts` (through the dispatcher) |
| An unrelated change does not block; own writes/re-reads are not concurrent changes | other files/workspaces changed; the agent's own fs.write then test.run; another agent validating the same snapshot still sees the change; re-read refreshes; first observation in the turn validated; own deletion ABSENT | `test/observations.test.ts` |
| Metric windows and environments observed | `max_age` expiry for an action on the queried target only; a re-query over the NEXT window (another range), a scrape or another expression refreshes the target's window (one per target); another agent's redeploy after an observation; own env action in the turn; another agent's deploy between the own action and its observation is not recorded as own | `test/observations.test.ts` |
| `git.show` never launders a concurrent change | another agent rewrites a read file, the agent views `HEAD` (committed version) ⇒ nothing observed, its write stays `stale_context`; truncated output ⇒ nothing; content equal to the working tree ⇒ observed | `test/observations.test.ts`, control `test/context-readset.test.ts` (through the dispatcher and the real ToolRuntime) |
| Observations fail closed | unknown workspace ⇒ `resolver_error`; unreadable log ⇒ validation throws; a read whose observation cannot be recorded ⇒ `failed`/`unavailable`, output withheld; an effect's result unchanged; UPDATE/DELETE/TRUNCATE of an observation ⇒ 42501 | `test/observations.test.ts` |
| SOFT condensation only when due | fewer than keepRecentTurns + 2 turns beyond the cut; a 200k-entry transcript (no stack overflow) | `test/working.test.ts`; control `test/context-readset.test.ts` (LLM condenser ⇒ soft compaction; failing condenser ⇒ deferred, no deterministic fallback, back-off of keepRecentTurns + 2 turns recorded on L0; hard still mandatory) |
| Symbol graph | assignments vs comparisons/arrows, qualified `Type.member` writers, callers with enclosing definitions, import edges (TS `.js`→`.ts`, index, dynamic import, Python relative, Go module path, never outside the repo) | `test/symbol-graph.test.ts` |
| Vector corpus lazy, per workspace + commit, bounded, isolated | embed counts; commit change re-populates and retires the old corpus; bounds truncate; failed population retried; pgvector shared by two workspaces without cross-talk; hybrid reaches a README section no identifier names | `test/workspace-vector.test.ts` |
| L5 gaps are explicit | missing tool events, operation events, work item, agent, env/commit; inconsistent invocation id, tool id, agent, operation/tool work item; record citing evidence of another run; unknown evidence/record; record citing nothing | `test/provenance.test.ts` |
| (B[0]) The read set never drops an observation | 300 distinct observations: every one is pinned, a write to the first one observed is still checked; an explicit cap exceeded ⇒ `precondition_failed` | `test/observations.test.ts` |
| (B[0]) What every observing tool showed is pinned | fs.search / code.symbols / code.references / git.blame / git.diff / evidence / plan / experiment / oracle results ⇒ exact pins; a line that no longer matches ⇒ unverified (fs.search) or nothing (index-based); annotated symbol-graph rows verified | `test/observations.test.ts` |
| (B[2]) Every state the design lists is re-checked before a side effect | build digest, environment generation, oracle upgrade, withdrawn finding (rejected / duplicate), lease owner, metric window — one at a time; plan revision for plan CAS | `test/freshness.test.ts` |
| (B[6]) Syntax-tree symbols with a per-file fallback | TS compiler API kinds and containers; a name in a string / comment is not a write (the regex classifier was fooled); python3 `ast` and `go/ast` usages; a syntax error / missing python3 ⇒ regex fallback recorded per file | `test/parsers.test.ts` |
| (B[6]) The code tools answer from the symbol graph | "who writes AccountState.version" ⇒ writes first with enclosing definitions, owner-narrowed; an edit is seen by the next query | `test/code-port.test.ts` |
| (B[6]) Semantic embeddings verified, never padded | reordered answers, wrong dimensions, missing / duplicate / out-of-range index, non-finite numbers, HTTP 401, bad JSON, network error; the key never in an error | `test/embedder.test.ts` |
| (B[4]) The memory service keeps the store's invariants over HTTP | bad JSON, oversized body, missing fields, unknown status, unknown route, wrong token; self-review via the calling actor; non-ASCII actors; remote decisions appended to L0 once | `test/memory-service.test.ts`; app `test/memory-service.e2e.test.ts` (a real child process, restart keeps the data) |
| (B[7]) Only eval-validated skills are published; only published skills reach prompts | candidate / rejected / unknown source experience; publish without a validation, after a failing one, by the creator; direct SQL INSERT as published, UPDATE of content or status, DELETE of a skill or a validation ⇒ refused by triggers; a later failing validation sends a validated revision back to candidate | `test/skills.test.ts` |
| L5 observation lineage (eval PoC C: SLO numbers of a load job observed in another work item trace completely); a forged operation link is still a gap | `test/provenance.test.ts` › an observation is lineage |

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
- (eval integration) `ProvenanceTrace.edges[].relation` adds `'observed'` and `'started_by'` (observation lineage).
- `createFreshnessGuard` accepts `resolvers?`; `createPgVectorIndex(db, embedder)` is async (the header comment said
  `(db, dims)`; the embedder is needed to embed and to tag rows with its `modelId`).
- Extra exports: resolver factories, `snapshotIdFor`, `offloadToolResult`, id extractors, helper constants,
  `pinnedEntries`, `sameActor`, `creatorActing`, `resolveLimit`.
- Behavioural clarifications from the v0.3 review (see the header of `src/contracts.ts`): malformed freshness actions
  are `invalid_argument`; pinned snapshot versions are always validated; `type:parent` resources match; the acting
  `ctx.actorId`/`agentId` counts for reviewer ≠ creator; vector indexes honour `query.root`; `ht_vectors` is keyed
  by `(model_id, id)`.
- (hardening) `finding` joins the always-checked resource types of the freshness guard (conformance-3: a mutating
  call is refused when a finding it was based on has been superseded).

- (context engine completion) Observed read set: `ObservedEntry`, `ObservationSource`, `Observation`, `ObservationLog`
  (contracts); `createObservationLog`, `observationsOf` (`ObservedToolResult.modelText?`: `git.show` is observed only
  from its whole shown content), `observeToolRuntime` (fails closed for reads it cannot pin), `observationEntry`, `workspaceFileId`,
  `metricWindowMs`, `ABSENT_VERSION`, `DEFAULT_METRIC_WINDOW_MS`, types `ObservedToolCall`, `ObservedToolResult`,
  `ObservationPorts`, `ObserveToolRuntimeOptions`; migration `context/003-observations`. `SnapshotBuilderDeps.observations?`,
  `.maxObservedEntries?`, `BuildSnapshotInput.observer?`, `DEFAULT_MAX_OBSERVED_ENTRIES`; `FreshnessGuardDeps.observations?`
  (intra-turn refinement) and the `ABSENT_VERSION` rule; `workspaceFileResolver`.
- (context engine completion) `WorkingContextManager.options?` (readonly, optional in the interface), `softCondensationDue`.
- (context engine completion) Symbol graph: `SymbolUsage`, `ImportEdge`, `SymbolReference.usage?` / `.enclosing?`;
  `SymbolIndex.findReferences(name, limit?, options?)`, `.writers()`, `.callers()`, `.imports()`, `.importers()`;
  `classifyUsage`, `extractImports`, `resolveImport`. Vectors: `WorkspaceVectorRetriever`, `VectorCorpusCache`,
  `chunkText`, `gitHeadCommit`, `CodeChunk`, `WorkspaceVectorOptions`.

- (context-learning, additive) `DEFAULT_MAX_OBSERVED_ENTRIES` is `undefined` (no cap; an explicit cap exceeded fails
  closed); `FreshnessPass` / `FreshnessPassLog` + `createFreshnessPassLog` (migration `context/004-freshness-passes`);
  `findingWithdrawalResolver`, `planResolver`, `planResourceId`, `FINDING_WITHDRAWN_STATUSES`,
  `findingWithdrawalVersion`, `UNVERIFIED_VERSION_PREFIX`, `shownLineEntries`; `finding_withdrawal` is always checked.
- (context-learning) Skills: `SkillStatus`, `SkillRevision`, `SkillEvalResult`, `SkillValidation`,
  `SkillValidationOptions`, `SkillRegistry`; `createSkillRegistry`, `withTrialSkills`, `skillDigest`, `skillArmId`,
  `renderSkillMarkdown`, `SKILL_EVENTS`, `SKILL_STATUSES`, `SKILL_NAME_RE`; migration `context/005-skills`.
- (context-learning) L0: `recordTranscriptOnL0`, `rebuildWorkingContext`, `transcriptEventId`,
  `TRANSCRIPT_RECORDED_EVENT`, `COMPACTED_EVENT`.
- (context-learning) L3: `SymbolDefinition.endLine?`; `SymbolIndexOptions.goHelperDir?`; `parseTsJs`, `parsePythonFiles`,
  `parseGoFiles(files, {helperDir?})`, `goAstHelper(helperDir)` (review: no shared temp-path default),
  `ParsedFile`, `ParserEngine`; `SymbolIndex.parserEngines()`, `.definitionsMatching()`; `OpenAICompatibleEmbedder`;
  `createCodeToolRetrieval`, `stripSymbolAnnotation`. Dependency `typescript` 5.9.3.
- (context-learning) L4: `createMemoryServiceHandler`, `listenMemoryService`, `withExperienceEvents`; the client sends
  `x-hypertest-actor-id` / `x-hypertest-agent-id`.

Events emitted that are not in the domain `EVENT_TYPES` catalog: `experience.reviewed` (aggregate `context`).
