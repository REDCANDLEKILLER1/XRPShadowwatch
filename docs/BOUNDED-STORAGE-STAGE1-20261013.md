# Bounded storage, stage 1 (draft, 2026-10-13 UTC)

## Status and scope

This is executable, disabled-by-default storage infrastructure, **not completed production stabilization**. It integrates immutable incremental acquisition batches and the existing stored-report readers with a separate object-store backend. It makes no production writes, switches no configuration, creates no credentials, deletes no evidence, changes no Git history, and enables no wallet admission. PR #114 remains the separate offline archive-catalog proof; this implementation does not replace or activate that experiment.

Production runtime currently refuses `BOUNDED_PRODUCTION_CUTOVER_NOT_QUALIFIED` even when the mode and provider capability attestation are set. Removing that gate is a separate reviewed implementation/cutover decision after the prerequisites below. Existing Git behavior remains the default. Preview/development R2 writes are structurally refused, independently of inherited credentials.

## Implemented

- `github-store` dispatches its dependency-bearing APIs through an explicit bounded backend; absence of mode preserves the existing implementation. Enabled-backend failures never fall back to Git writes.
- `buildDays` in bounded mode reads only newly acquired/journalled rows and emits immutable, full-SHA-256-named event, participant and payload batches. It does not fetch/recompress/rewrite the already committed day. Legacy behavior is unchanged.
- A separate R2 bucket stores content-addressed objects and a root manifest. It is not a branch in the existing evidence repository.
- A first conditional root PUT reserves the entire transition's byte budget durably, without advancing evidence/checkpoint/journal ownership. A second conditional PUT publishes everything atomically after immutable objects and snapshot have been verified. Failed publication retains the charge and prior readable snapshot. Only the same operation can recover a pending reservation; different work fails closed. Ambiguous writes are not blindly retried.
- The active date index retains **seven complete UTC dates plus the current partial date**. An incomplete journal holds older detail; a byte cap still refuses excess capacity before any upload. Old owned days become immutable frozen manifests; older-day revisions are explicitly rejected.
- Daily observed transaction totals deduplicate by transaction hash; participant counts deduplicate by `(hash, wallet, role)`. Summaries are replacement snapshots, not additive counters, so replay cannot double count. Divergent new duplicate hashes are rejected. An explicit expected-old-digest correction can replace a current-day event or payload.
- Flagged records retain canonical event, full raw payload, all observed participant roles, reason, checkpoint provenance, and `ParentBatchID`. Ordinary later sightings preserve the reason. An unresolved requested flag is refused, never silently omitted. The backend does not synthesize events from Batch `RawTransactions`; separately stored inner hashes remain individual observations counted once.
- State hashes, wallet balances, acquisition `last_proven_ledger + 1`, historical baseline resolution, whole-run proof gates, and resume journals keep their existing contracts. Journals remain invisible to report assembly.
- Bootstrap independently reads the legacy checkpoint at an exact Git SHA before importing its entire canonical cutover date. It supports a midday checkpoint and preserves transactions in an exact-midnight anchor ledger. It imports all three record kinds and derives that date's initial rollup. No empty-day assumption is made from the clock alone.
- Pre-cutover dates route through the frozen legacy Git SHA. New active/frozen dates use verified object references. Multi-date responses return only after the final segment verifies. Original bounded snapshots remain readable after rollover.
- Legacy `evidence/backup/latest.json` is never exposed as a bounded-backend receipt. The existing storage-health path refuses to combine old Git inventory/backup claims with the new checkpoint. Automatic admission therefore cannot borrow the old restore receipt.

## What is and is not bounded

Defaults are explicit planning limits, not provider quotas:

| Budget | Default |
|---|---:|
| Logical active compressed detail + live journal | 536,870,912 bytes (512 MiB) |
| Conservatively reserved lifetime allocation | 2,147,483,648 bytes (2 GiB) |
| Root manifest | 16,777,216 bytes (16 MiB) |
| One provider object | 16,777,216 bytes; configurable downward |

Budgets are persisted at bootstrap. Every transition is checked before the reservation and immutable puts. Reservation accounting includes planned objects and root/snapshot overhead; identical object reuse may be overcharged intentionally. It is **not a live bucket inventory**, does not include preexisting foreign objects, and cannot control an external writer. A new dedicated empty namespace, exclusive writer access, and independent inventory reconciliation are required. Partial bootstrap publication can leave a reserved namespace blocked; no automatic destructive reset exists.

The active index is bounded in days/bytes. Frozen raw detail, old immutable snapshots, flags, proof history, and rollups are retained in this stage. **Physical immutable objects therefore still accumulate until the total allocation gate is reached. There is no deletion or garbage-collection implementation here.** This draft alone neither shrinks existing Git storage nor provides indefinite capacity relief. It does remove repeated whole-day object versions from the proposed new write path, and would stop new Git accumulation only after an approved cutover.

Runtime conflict validation scans prior payload digests one compressed shard at a time; it does not retain a full-day raw-payload map. Event/provenance maps and shard decompression still require representative volume/memory qualification. A compressed-byte budget is not a heap guarantee. Bootstrap is an offline import operation and may read a full canonical day through the existing reader.

## Measurement used for initial sizing

Metadata-only measurement of evidence commit `b582be8227dd426530f6d151608dea22a2b9d191` (state v306; anchor 2026-10-13 20:49:51 UTC):

- Oct 7–13 authoritative daily shards: 328,091,520 compressed bytes, with Oct 13 partial.
- Oct 6–12 complete dates: 331,400,786 bytes.
- Largest sampled complete date: 54,862,602 bytes; seven such dates: 384,038,214 bytes, **before the current day, proof, flags, journal, and headroom**.
- Existing proof history: 60,407,464 bytes across 306 snapshots, plus latest checkpoint 200,067 bytes and run manifests 435,667 bytes.
- Current tree: 2,015,215,815 bytes. Repository metadata: 8,424,423 KB, a distinct historical-Git measure. Current-tree deletion would not reclaim it.
- Flag retention, actual R2 bucket versions/objects, and database/index overhead were not measured. Zero flagged bytes must not be assumed.

The observed 512 MiB logical-active default is a provisional guardrail, not a demonstrated worst-case capacity promise.

## R2 CAS contract and qualification

Official documentation lists PutObject `If-Match` and `If-None-Match` support:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html

The provider uses the direct R2 S3 endpoint, strong quoted ETags, conditional PUTs, SHA-256 metadata/readback, and SDK `maxAttempts: 1`. Missing objects are distinguished from missing buckets, denial, and provider failure. Only `root.json` is mutable. A documented header is not a successful live concurrency test; Cloudflare documentation clarification issue https://github.com/cloudflare/cloudflare-docs/issues/32793 also remains relevant.

Configuration names (values are not supplied or changed):

- `SHADOWWATCH_BOUNDED_STORAGE_MODE=r2`
- `SHADOWWATCH_BOUNDED_R2_BUCKET` (separate from existing backup bucket)
- `SHADOWWATCH_BOUNDED_R2_ENDPOINT` (direct account R2 endpoint)
- dedicated `SHADOWWATCH_BOUNDED_R2_ACCESS_KEY_ID` and `SHADOWWATCH_BOUNDED_R2_SECRET_ACCESS_KEY`
- optional `SHADOWWATCH_BOUNDED_MAX_OBJECT_BYTES` (may only lower the cap)
- `SHADOWWATCH_BOUNDED_CAS_VERIFIED=true` is an operator attestation after independent testing, not automatic proof and not sufficient to bypass the production runtime gate.

## Minimum next deliverable before activation

1. Qualify concurrent create/update, stale ETags, provider outage, and lost-response recovery in an explicitly authorized isolated namespace. Record exact provider/account/bucket/prefix and observed results. No production evidence namespace is a test fixture.
2. Add bounded-source sealed-report receipt/archive support and a source-specific independent backup/restore receipt. Complete storage-health output for both old Git and new object storage without combining their coverage. Prove candidate qualification and admission remain off until the correct receipt exists.
3. Exercise this bootstrap importer against a pinned, verified real snapshot and matching independent recovery copy. Verify all 24/48/60/72-hour report outputs and balance baselines across the actual boundary, including flagged payload/provenance. Connect the production classifier's exact flag decisions; the backend currently accepts explicit flags but does not invoke the classifier itself.
4. Implement and test a reviewed physical retention/GC plan. It must account for old snapshots, frozen detail, permanent flags/proofs/rollups, pending reservations, concurrent readers, incomplete runs, independent recoverability, and intentional 30-day forensic policy. No same-Git-history branch rotation solves historical Git growth. No evidence deletion is authorized by this draft.
5. Measure high-volume run memory, daily batch count, current-day + seven-day working size, flag growth, proof growth, and restore duration. Tune budgets from evidence, including headroom; do not hide overflow by widening them without a capacity decision.
6. Prepare an explicit cutover/rollback rehearsal: immutable legacy SHA, source/hash ownership boundary, existing journal treatment, sole writer switch, resume at `last_proven_ledger + 1`, backup-qualified receipt, monitoring, and rollback behavior after the first new committed run. Only then propose removing the code gate and request production-switch approval. Reverting mode after new data exists cannot silently send writes back to an older checkpoint.

## Validation and publication safety

Local focused tests cover provider contracts, atomic reservation/failure recovery, stale or lost CAS responses, read/report parity, source import, dedup/corrections, flags, multiwallet roles, Batch handling, 35-day retention, incomplete holds, budget preflight, pinned snapshots, and late-segment rejection. The explicit aggregate runner includes all three new suites.

No production API calls, credentials, preview configuration, workflow secrets, R2 objects or Git evidence files were changed. CI's regression workflow contains no evidence secrets and executes local fixtures. Preview metadata inspection was attempted through the Vercel connector and denied (403); no alternate access route was attempted. Safety therefore also rests on default-off dispatch, unconditional production qualification refusal, and provider-level preview/development write refusal.

Builder: dot, 2026-10-13 UTC. Source base: `720780141a12352758ea48316315d6a9944f9bef`. Final CI/head status is recorded in the draft PR rather than asserted here in advance.
