# Restore receipt handoff audit — October 9, 2026

Base: `0b594bef7f4a44cfa79d4802aee3c7c442284337`.

## Verdict

HOLD automatic wallet admission. An actual R2 restoration succeeded, but no
production-consumable receipt was published. `NOT_VERIFIED` is the correct
fail-closed outcome for the current handoff; it is not evidence that R2 lost data.

At 14:23 UTC, production storage health reported checkpoint 255, 423 wallets,
approximately 7.38 GB accumulated Git storage (WARNING), 1.758 GB current files,
and an unverified backup. Deletion and automatic rollover were disabled.
No admission flag, source checkpoint, source shard, or production code was changed
by this audit.

## Evidence and cause

Actions run `37888552233`, job `113684002928`, independently downloaded and
restored source `2742e66bb3ec0ff78516c9c9fb8b5af46c1ff68d`, manifest SHA256
`9009cc25076d75f68ca292e1199063a4df89d24a75fa0df7f94069318fe6b3cf`.
The subsequent derived export was independently read back and the compact summary
published. These are different operations from publishing backup-gate proof.

Both R2 workers omit `evidence/backup/latest.json` publication. The only existing
publisher is the manual `evidence-master-backup.js attest-restore` command.
The status checker recognizes only `OPERATOR_DOWNLOADED_AND_RESTORED`.
An automated worker must not claim that an operator downloaded the copy.

## Scoped repair

Both workers pass the actual isolated restored directory to a worker-only receipt
publisher after R2 readback. It repeats file/tree/checkpoint/shard verification,
compares the source tree against the pinned original Git commit, enforces the
existing 24-hour receipt and evidence-anchor freshness gates, and publishes only
receipt metadata. Ref conflicts retry without force; a newer evidence-anchor
receipt is preserved. Exact committed receipt readback is mandatory.

The checker recognizes `R2_DOWNLOADED_AND_ISOLATED_RESTORE` with explicit readback,
source tree and file-count fields. Manual receipts remain valid. No log-derived
or fabricated receipt is created, and no automatic admission flag is enabled.

## Validation and release gate

The new R2 handoff regression fails with the base status checker
(`BACKUP_RECEIPT_NOT_RECENT`) and passes with the repair. It covers real fixture
download/restoration, canonical-tree mismatch, corrupt restored bytes, preview
write refusal, expired proof, omitted readback proof, non-regressing publication,
ref-conflict retry and bad receipt readback. Adjacent storage/admission/forensic
and market safeguards also pass locally. Full suite results belong in the PR.

Before enabling admission:

1. Independently review the exact repair commit and its regression results.
2. Confirm the production automatic-admission flag remains disabled before
   deploying the receipt consumer or running the repaired worker. Existing
   configuration has not been assumed or changed by this audit.
3. Deploy the consumer repair and run a fresh private R2 backup/restore worker.
   Existing main workflows have manual dispatch; do not synthesize proof from logs.
4. Check the receipt commit and production `/api/storage-health` independently:
   `VERIFIED_RECENT`, matching source/manifest hashes, and noncritical capacity.
5. Evaluate admission separately with a read-only qualification preview, then
   an explicitly authorized bounded production admission test.

The worker requires Contents write access to the existing private evidence repo;
missing permission fails receipt publication rather than reporting success.
Collection cadence, retention, capacity limits, XRPL read-only behavior and report
history completeness requirements remain unchanged.
