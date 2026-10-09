# Storage and shared automatic admission — October 8, 2026

Built forward from production `b264f5d92c3ccbd6bbbf4d8897be9dbdcb514cba`.
The original application/report branding and permanent 423-wallet source roster are preserved.

## What is testable now

Open `/storage-status.html`. Check shared storage, then preview qualified wallets.
Both GET endpoints are read-only. A preview cannot change production evidence.
The page reports current-file bytes separately from GitHub's approximate repository size,
which includes accumulated Git storage. Operational warnings are 5 GiB and 8 GiB;
these are not provider hard quotas. Nothing deletes files or rewrites Git history.

Automatic admission is disabled unless `SHADOWWATCH_AUTOROSTER_ENABLED=true`.
Even then it requires production write authorization, a recent offsite restore receipt,
and capacity below CRITICAL. Any optional qualification failure pauses additions while
continuing the existing roster. The dry-run endpoint never uses account_tx or writes.

## Qualification policy, version 1

Within the last 72 hours of verified stored evidence, qualify either one payment of at least 10M XRP, or at least two distinct,
successful, validated XRP Payment hashes, each at least 1M XRP, on at least two ledgers,
with a combined value of at least 5M XRP. One endpoint must already be watched and appear in the surviving observation
provenance. The unknown counterparty, sender or recipient, must be a checksum-valid
classic XRPL account. The reason states whether one very large payment or a
repeat route earned the nomination. Reject dust, small incoming spam, IOUs, offers, escrow
submissions, self-payments, failed payments, conflicting hashes and incomplete or
reconstructed evidence windows. Replaying the same snapshot earns no recurrence.

At most five qualified wallets enter an acquisition attempt. No ownership or exchange
identity is inferred. Labels are `AUTO_<full address>`. Remaining candidates are
recomputed from stored evidence on the next scheduled pass; they are not discarded by
an arbitrary browser queue limit. Eligibility does not promise admission: a new wallet
must still pass the existing cold-history, anchored balance and complete-run gates.
Automatic additions request a 100,000-ledger initial history range. Reports independently
check that an admitted wallet's proven history floor reaches the requested window start;
proving only its latest anchor cannot claim a complete earlier 24/48/72h window.
If the floor or baseline is unknown, that wallet remains unproved for that report.

Qualified receipts are stored in the resumable journal, sealed checkpoint and run
manifest so resuming uses the original nomination evidence. Existing journal digests
are unchanged when no auto-admission metadata exists. Failed or incomplete runs do
not add permanent wallets. Fully proved shared checkpoint wallets synchronize into
each device's runtime watchlist before its scan enumerates targets.

## Master backup and restoration

`node scripts/evidence-master-backup.js backup --out NEW_DIRECTORY`

Use a destination whose parent already exists and has room for the current-file tree.
The source is the pinned private evidence repository, read at one immutable commit.
Copy every tracked file, including ledger payloads, participants, checkpoint history,
run manifests and resume records. Bound memory to a file at a time. Verify Git blob
identities, rebuild the complete source Git tree identity, verify SHA256 checksums,
walk the checkpoint chain, and verify the newest manifest per ledger day. A failed
copy has no verified completion manifest. Existing destination directories are refused.

`node scripts/evidence-master-backup.js verify --in DIRECTORY --commit SOURCE_SHA --manifest-sha MANIFEST_SHA`

`node scripts/evidence-master-backup.js restore --in DIRECTORY --out NEW_ISOLATED_DIRECTORY --commit SOURCE_SHA --manifest-sha MANIFEST_SHA`

The restore must pass the same complete checks. It never overwrites the live repository,
application, or an existing directory. Symlinks, path traversal, omitted files, truncated
trees, altered bytes, missing state history and wrong source commits fail closed.
Keep the source SHA and manifest SHA outside the backup as independent comparison values.
Offline verification detects edits against those values; a self-hashed manifest alone
is not an independent signature. Restore attestation also compares its source tree
against the pinned source commit fetched from the original private repository.

## Offsite configuration still required

The code does not provision a paid store or claim an offsite copy exists. Choose a
private object-storage destination or a separate privately controlled backup system.
Upload the verified directory, download it into a fresh directory, then run isolated
restoration. Protect destination credentials separately from the source GitHub token.
Do not publish private evidence as public workflow artifacts or public Blob objects.

After the independently downloaded copy passes restoration:

`node scripts/evidence-master-backup.js attest-restore --in DOWNLOADED_DIRECTORY --downloaded-from https://PRIVATE_DESTINATION/PREFIX --commit SOURCE_SHA --manifest-sha MANIFEST_SHA`

This command repeats isolated restoration and writes a small receipt to the evidence
repository using its existing operator credential. The destination field is explicitly
an operator attestation; the CLI cannot prove where a manually downloaded directory
came from. GitHub URLs and credential-bearing URLs are refused as offsite destinations.
The receipt and the evidence anchor must both be less than 24 hours old for automatic
admission. Scheduler writes are blocked in previews. Source evidence is never pruned.

There is **no active automated offsite backup or rollover** in this release.
The tools are ready for a private backup worker, but its destination and cadence must
be connected and exercised before automatic admission is enabled in production.

## Capacity and rollover plan

### R2 transport (initial operator run)

`scripts/r2-master-backup.js NEW_WORK_DIRECTORY` now connects the verified backup
to the private `shadowwatch-backups` R2 bucket. The account endpoint is pinned in
the worker; credentials remain server-side in GitHub Actions repository secrets:
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `SHADOWWATCH_EVIDENCE_TOKEN`.
The last credential reads the existing pinned private evidence repository; the
application repository's default `GITHUB_TOKEN` cannot replace it. Read-only
Contents access to the evidence repository is sufficient for this initial run.

The `Private R2 backup and restore` workflow runs on worker changes on the builder
branch or by manual dispatch after the workflow reaches the default branch.
There is intentionally no recurring schedule yet. It inventories the entire
bucket, refuses a projected total above 8,000,000,000 bytes before uploads, stores
SHA256-addressed objects once, and uploads the snapshot manifest last. Nothing
is deleted or overwritten. This is a worker guard, not a Cloudflare billing cap;
other clients and other buckets can consume additional storage or operations.

Every referenced object and the manifest are downloaded from R2 to a new local
directory, including previously uploaded objects. Hashes and the isolated restore
are checked against the independently retained source commit/manifest seal. The
Actions summary retains these hashes but no evidence is uploaded as an Actions
artifact. A failed run cannot publish a restore receipt or enable admission.
The first successful run still needs its live result reviewed, receipt publication
and cadence connected before automatic admission is enabled. PR #104 remains a
staged change until merged. Existing production acquisition is unchanged.

1. Monitor current bytes, repository bytes, checkpoint verification and restore age.
2. Preserve daily compressed evidence as immutable, content-addressed objects offsite.
3. Maintain a signed/externally retained inventory plus source and manifest hashes.
4. Exercise full isolated restoration regularly, not only an upload-success check.
5. Before the CRITICAL threshold, provision the next active storage segment. Freeze the
   old segment as a readable archive; carry forward the checkpoint and explicit routing
   manifest. Readers must verify both the segment mapping and referenced file hashes.
6. Test 24/48/72h windows crossing the boundary, checkpoint chains and rerun/resume.
7. Only after those tests and an independently verified copy may old storage be retired.

Rollover routing and archive retirement are separate future work. They are deliberately
not enabled by changing this branch's storage thresholds. No automatic deletion exists.
