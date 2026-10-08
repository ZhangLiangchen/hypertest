# @hypertest/evidence

Content-addressed artifact storage and the tamper-evident **Evidence Ledger** that owns invariant
**I6** from the [blueprint](../../docs/architecture/BLUEPRINT.md): evidence is append-only, every artifact
is SHA-256 addressed, each run has a hash chain and a Merkle root, and agents cannot delete or rewrite
evidence. The design goal is *tamper-resistant storage plus cryptographically tamper-evident lineage*.
It does not promise absolute immutability against someone who controls the database, the object
store and the signing key.

Depends on `@hypertest/core` and `@hypertest/domain` only. `@aws-sdk/client-s3` is confined here and is
loaded lazily, so importing the package does not load the SDK unless an S3 store is used.

## Public API (`src/contracts.ts` is the ABI)

| Export | What it does |
|---|---|
| `FsArtifactStore(root, { fsync? })` | Stores objects at `<root>/sha256/<first2>/<hex>` with uri `cas://sha256/<hex>`. Writes go to a temp file under `<root>/.tmp/`, then fsync, `chmod 0444` and an atomic rename. `put` is idempotent and never rewrites an existing object, so a tampered object stays detectable. An existing object whose size no longer matches is `integrity_violation`, not a ref. `putFile` hashes the file while streaming the copy. `get` re-hashes the bytes and throws `integrity_violation` rather than return corrupted data. A directory planted at an object path counts as missing. |
| `MemoryArtifactStore` | The same semantics in memory, for tests. Bytes are copied in and out. |
| `S3ArtifactStore({ client?, endpoint?, region, bucket, prefix?, forcePathStyle?, credentials?, objectLockDays?, clock? })` | Keys are `<prefix>sha256/<hex>` and uris are `s3://<bucket>/<key>`. Dedupes with `HeadObject`. `PutObject` sends `If-None-Match: *` and a server-checked `ChecksumSHA256`, plus `ObjectLockMode=COMPLIANCE` and `ObjectLockRetainUntilDate = now + days` when `objectLockDays` is set. A 412 (concurrent writer) counts as success only after a `HeadObject` confirms the winner's size (`integrity_violation` if it differs, retryable `unavailable` if it is not visible). S3 errors map to `not_found`, `permission_denied`, `invalid_argument` or `unavailable`. `destroy()` releases a client the store created (an injected client is left alone). |
| `createEvidenceLedger({ db, artifacts, events?, signer?, ids, clock, logger })` | The SQL ledger: `append`, `get`, `getMany`, `query`, `count`, `rootHash`, `verify`, `seal`, `latestSeal`. It has no update or delete API. |
| `Ed25519Signer` (`generate`, `fromPem`, `fromSeed`, `privateKeyPem`) · `verifyEd25519` · `ed25519KeyId` | Signing via node:crypto. `keyId = 'ed25519:' + sha256(SPKI DER)[0..16]`. The `Signer` interface is the KMS/HSM port. |
| `merkleRoot(hexLeaves)` | Parent node = `sha256(left + right)` over hex strings. An odd level duplicates its last node, a single leaf is its own root, and an empty list gives `sha256('')`. |
| `recordEvidence(ledger, artifacts, input, tx?, options?)` | Puts the bytes, then appends the record. |
| `resolveClaim(ledger, claim, { runId?, artifacts? })` | Returns supported only when all of these hold: at least one ref; every ref exists; each record's stored metadata and record hashes still recompute; all refs are in one run (or the given run); each record matches `evidenceQuery.evidenceType`, `workItemId` and `field` (a dot path into `structured`, or — with `artifacts` — into the record's JSON artifact when the structured payload lacks it); and (area-C[0]) when the claim states a `value`, the value EVALUATES true: domain `evaluateClaim` reduces the field over the cited records by `evidenceQuery.aggregation` (value — all equal —, count, sum, avg, min, max, first, last, p50, p90, p95, p99) and compares (strings/booleans exactly, numbers within `CLAIM_RELATIVE_TOLERANCE` = 0.5 %). A contradicted value (`claim value contradicts its evidence: …`) or an unevaluable one (`claim cannot be evaluated against its evidence: …`) is unsupported with the exact reason; `evaluation` carries the outcome. Otherwise it lists the problems. |
| `verifyEvidenceRecords(runId, records, seals, { artifacts?, publicKeys? })` | Pure verifier that also works offline, e.g. on exported records. |
| `evidenceMetadata`, `computeMetadataHash`, `computeRecordHash`, `sealMessage`, `parseArtifactLocator`, `casUri`, `EMPTY_ROOT` | Hash and locator helpers. |
| `evidenceMigrations` | `evidence/001-ledger`: creates `ht_evidence` and `ht_evidence_seals`, plus append-only triggers. |

### Ledger rules

- **`append(input, tx?, options?)`**
  - Validates the input and checks the artifact is in the store, using `head` when available (so a
    wrong declared size is also rejected) and `exists` otherwise. A failed check throws
    `integrity_violation`, and so does a missing parent evidence id.
  - A non-empty `artifact.uri` must locate the declared digest: another digest is
    `integrity_violation`; something that is not a `cas://` or `s3://` content address is
    `invalid_argument`. `classification` must be one of the four names.
  - Every string is stored exactly as it will be read back. Lone UTF-16 surrogates, as produced by
    truncating an emoji, become U+FFFD in text fields and JSON payloads. NUL is rejected, because
    PostgreSQL cannot store it. Without this, an untouched record would verify as tampered and the
    run could never be sealed.
  - Inside a transaction it takes `pg_advisory_xact_lock(hashtext(runId))` and sets `seq = last + 1`.
  - `metadataHash = sha256(canonicalJson(metadata))`, where metadata is every stored field except the
    three hashes.
  - `recordHash = sha256(metadataHash + artifact.sha256 + (previousRecordHash ?? ''))`.
  - It emits `evidence.attached` with payload `{evidenceId, evidenceType, seq, summary}` in the same
    transaction: the caller's `tx` when given, otherwise the ledger's own. A sink failure rolls the
    append back.
- **`verify(runId, { checkArtifacts = true, publicKeys })`** recomputes every metadata hash, record
  hash, chain link and seq, and re-hashes each distinct artifact. It then checks every seal's root,
  count and signature. Problems are reported precisely (`seq_gap`, `chain_break`, `metadata_hash`,
  `record_hash`, `artifact_missing`, `artifact_hash`, `seal_root`, `seal_signature`).
  - Trusted keys are `publicKeys` when given, otherwise the ledger signer's own key.
  - A seal signed by an untrusted key is reported as a problem (fail-closed).
- **`seal(runId)`**
  - Requires a signer (`precondition_failed` otherwise).
  - Refuses to certify a chain that fails verification (`integrity_violation`). It also refuses a
    chain that contradicts an earlier seal by the same signer, for example after the tail was
    deleted behind the triggers. Otherwise the new seal would make the truncation look legitimate.
  - Signs `canonicalJson({runId, rootHash, count, lastSeq})`, checks the signature before storing it,
    and emits `evidence.sealed`.
  - It is idempotent: if nothing changed since the latest seal, that seal is returned, but only if
    its signature verifies under the signer's key. The triggers allow `INSERT`, so anyone with table
    access can add a seal row. A forged row is never handed out; a genuine seal is appended on top
    of it. Seals by other keys never block sealing.
  - It signs while holding the per-run lock, so a slow remote (KMS) signer delays that run's appends
    for the duration of the call.
- **`latestSeal(runId)`** returns the newest stored row *unverified*. Trust only `seal()` or `verify()`.

### Threat-model notes

- The database rejects `UPDATE`, `DELETE` and `TRUNCATE` through triggers. If someone bypasses them
  (e.g. a superuser), `verify()` detects the change.
- Someone who controls the database can rewrite a whole chain consistently. Only a seal (or a root
  anchored outside the database, e.g. in a `QualityDecision`) detects that. The test
  `tamper.test.ts › rewrites the whole chain` documents this limit.
- Because odd levels duplicate their last node, `[a,b,c]` and `[a,b,c,c]` have the same Merkle root.
  A root is therefore only meaningful with its `count`, which seals and verifications always carry.
- The seal signature covers `{runId, rootHash, count, lastSeq}` only, as the spec fixes it. A
  seal's `sealedAt` and its row number are not signed.
- `seal()` checks for regressions only against seals made by the *current* signer. After a key
  rotation, only `verify()` with the old keys in `publicKeys` checks the older seals.

## Invariants and where they are tested

| Invariant | Tests |
|---|---|
| I6: gap-free per-run seq and chain under concurrency | `ledger.test.ts` (25 concurrent appends, cross-run), `ledger.int.test.ts` (40 parallel on PostgreSQL, appends racing seals) |
| I6: SQL `UPDATE` of a row is detected | `tamper.test.ts` (metadata_hash, jsonb payload, recomputed metadata ⇒ record_hash, renumbering) |
| I6: deleting rows is detected | `tamper.test.ts` (middle ⇒ seq_gap + chain_break, first row, tail after a seal ⇒ seal_root) |
| I6: artifact bytes changed, removed, replaced by a directory, or digest rewritten to garbage (reported, never a crash) | `tamper.test.ts`, `fs-artifact-store.test.ts`, `s3-*.test.ts` |
| I6: forged, untrusted or tampered seals | `tamper.test.ts` (seal_signature, untrusted key, seal_root) |
| I6: `seal()` never returns a forged row and never re-certifies a truncated chain; bogus seals by other keys cannot block it | `tamper.test.ts` (`seal: …`) |
| I6: no false tamper alarms (lone surrogates, `__proto__` keys, number formats round-trip) | `ledger.test.ts` |
| I6: a caller tx holds the per-run lock until commit or rollback; a rollback leaves no gap | `ledger.int.test.ts` (waiter observed in `pg_locks`) |
| Claims are not supported by evidence rewritten behind the ledger | `claims.test.ts` |
| I6: no update/delete API; DB-level append-only | `ledger.test.ts` |
| Append rejects a missing artifact, size mismatch, a uri naming another digest, unknown parent, inherited classification names or invalid input | `ledger.test.ts` |
| Event is atomic with the append | `ledger.test.ts` (sink failure rolls back; caller tx rollback discards both) |
| Merkle known vectors | `merkle.test.ts` (independently computed with Python hashlib) |
| Ed25519 correctness | `signer.test.ts` (RFC 8032 test 1) |
| Claim resolution | `claims.test.ts` |

## Testing

```bash
npx tsc -p packages/evidence --noEmit
node scripts/run-tests.mjs --package evidence                          # PGlite + local PostgreSQL (int)
HYPERTEST_TEST_DB=postgres node scripts/run-tests.mjs --package evidence # every test on PostgreSQL 16
```

- `s3-wire.test.ts` runs the real AWS SDK against a mock S3 server on localhost (hermetic).
- `s3-artifact-store.int.test.ts` needs `HYPERTEST_TEST_S3_ENDPOINT` (MinIO/S3; optional
  `HYPERTEST_TEST_S3_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY`, `_REGION`). Without it the test is skipped
  and says why.
- `ledger.int.test.ts` needs `HYPERTEST_TEST_PG_URL`.

## Contract changes (additive, backward compatible)

- `ArtifactStore.head?(ref)` is a new optional method, returning the new `ArtifactHead` type.
- `EvidenceLedger.append` takes an optional third parameter `options?: EvidenceEventOptions`
  (`eventContext`).
- `EvidenceLedger.seal` takes an optional second parameter `options?: EvidenceEventOptions`.
- The `verify()` options now have a name, `EvidenceVerifyOptions`; the shape is unchanged.
- `EvidenceVerification` gains optional `sealsChecked?` and `artifactsChecked?`.
- New types: `S3ArtifactStoreOptions`, `S3ClientLike`, `FsArtifactStoreOptions`, `ResolveClaimOptions`.
- `recordEvidence` takes optional `tx` and `options`; `resolveClaim` takes optional `options`.
- `S3ArtifactStore.destroy()` is a new method on the class, not on the interface.
- Documented behaviour, no signature changes:
  - `append` normalizes strings and checks `artifact.uri`.
  - `seal` returns only genuine seals and refuses to contradict earlier ones.
  - `latestSeal` is unverified.
  - `resolveClaim` also checks each record's hashes.
- (gate-governance, additive) `ResolveClaimOptions.artifacts?` (read a field from the record's JSON artifact) and
  `ClaimResolution.evaluation?` (the domain `ClaimEvaluation`); behaviour: a claim with a `value` is evaluated, and a
  contradicted or unevaluable value is unsupported (it used to be accepted when the field merely existed).
