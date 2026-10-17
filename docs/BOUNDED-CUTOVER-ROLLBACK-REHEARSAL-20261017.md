# Bounded storage cutover / rollback rehearsal — DRAFT, NOT AUTHORIZED
Date: 2026-10-17. Base: PR #117 head 8a7e297be69b59533646731172d39751c922cef7.
Scope: operator checklist for a future **isolated** rehearsal. This is NOT an implemented restore command or approval to enable production. Existing unconditional production gate remains.

## Mandatory preflight / hard stops
- [ ] Record operator, independent reviewer, UTC start, source account/bucket/prefix, separate recovery account/bucket/prefix, repository and immutable legacy evidence commit SHA. STOP if any identifier is missing or overlaps a production namespace.
- [ ] Record sole-writer identity and confirm all other writers disabled; pin source checkpoint/state hash, last_proven_ledger, journal status and hash ownership boundary. STOP if checkpoint cannot be independently read and verified.
- [ ] Confirm latest **source-typed bounded** manifest, independently materialized recovery copy, complete verifyRestore pass and matching root/checkpoint hashes. Legacy VERIFIED_RECENT is not sufficient. STOP if recovery copy is only in-memory, same failure domain, pending, or unverified.
- [ ] Verify live R2 CAS, stale ETag, concurrent writer, lost-response and outage tests; real-volume 24/48/60/72h parity, classifier/flag coverage, memory and restore duration. STOP on any unqualified gate.
- [ ] Confirm admission OFF, read-only XRPL method allowlist intact, no report pipeline changes without owner review, capacity owner and operational rollback operator assigned. STOP if any item is unknown.
- [ ] Confirm an **implemented, separately tested, write-capable restore into a NEW empty isolated namespace**, including mid-copy failure injection, checksum verification and atomic publication. Existing verifyRestore is read-only and DOES NOT satisfy this condition. STOP until implementation and independent test exist.

## Isolated cutover rehearsal (future; no production execution)
1. Quiesce the sole writer. SUCCESS: no in-flight commit, source root unchanged across two reads; otherwise STOP and keep writer quiesced.
2. Snapshot and independently seal legacy source at immutable SHA, checkpoint, journal status and ownership boundary. SUCCESS: manifest and receipt hashes agree on independent readback; otherwise STOP.
3. If journal is incomplete, resolve by approved replay/discard contract without advancing coverage; never import unproven rows. SUCCESS: pinned last_proven_ledger and source evidence agree; otherwise STOP.
4. Bootstrap into NEW empty bounded namespace; do not reuse recovery namespace. SUCCESS: root references verify and date boundary, state hash, flagged payloads, ParentBatchID, balances and report parity pass; otherwise STOP.
5. Confirm sole-writer switch only after exclusive-writer lease/fence and source-typed recovery receipt; resume strictly at last_proven_ledger + 1. SUCCESS: exactly one writer, no Git fallback, checkpoint monotonic and proven; otherwise STOP and leave writes disabled.
6. Commit one controlled bounded run in isolated namespace; record pre/post root SHA, checkpoint and transaction evidence. SUCCESS: no missing evidence, repeat idempotent, parity and health green; otherwise STOP, freeze writes and preserve both namespaces.

## Rollback BEFORE first bounded commit
Keep writers disabled. Repoint **isolated** reader to pinned legacy SHA only after proving no bounded checkpoint advancement. Validate legacy root, journal and reports; only then resume legacy writer if its checkpoint matches last proven coverage. Any ambiguity: STOP, read-only incident mode.

## Rollback AFTER first bounded commit — REQUIRED IMPLEMENTATION NOT PRESENT
**Never toggle bounded mode off to resume legacy writes at the old checkpoint.**
1. Fence and stop ALL writers; freeze immutable bounded root, source receipts, pending reservation and journal. SUCCESS: no writes and bounded checkpoint proven; otherwise STOP.
2. Choose one of two separately implemented and independently audited recovery paths:
   A. Restore the latest bounded checkpoint + all owned evidence to a NEW empty bounded namespace in a separate failure domain; verify full graph and atomically promote the verified root under an exclusive writer fence. Resume at restored last_proven_ledger + 1.
   B. Build an explicit, verified forward bridge of all bounded-committed ledgers into a NEW legacy destination (never overwrite the pinned legacy SHA); verify hashes, journal/flag/proof provenance and full parity, then atomically switch ownership to that destination. Resume at its proven last_proven_ledger + 1.
3. If neither path has been implemented, tested with post-first-commit and injected mid-restore failures, and independently approved: **NO ROLLBACK WRITES. Remain read-only.**
4. On mid-copy failure: quarantine partial destination, preserve source and recovery copy, do not publish root or resume any writer; retry only into a fresh empty namespace after cause review. Never treat verifyRestore as a copying tool.
5. After successful isolated recovery: compare 24/48/60/72h reports, balances, flags, checkpoint, source typed receipts, storage-health and writer exclusivity; retain old namespace for investigation. Any mismatch: STOP, read-only.

## Evidence to record for each step
UTC time, operator, environment and namespace IDs (no secrets), command/implementation version, input/output root and manifest SHA-256, checkpoint, expected result, observed result, pass/fail, logs, independent reviewer. An unexecuted checkbox is NOT a pass.

## Release decision
Status: **BLOCKED / PROCEDURE DRAFT ONLY**. This document identifies concrete stop conditions; it does not supply the missing restore implementation, a tested post-first-commit mechanism, live CAS results or capacity relief. No production gate removal, merge, mode switch, wallet admission, evidence deletion, or report generator deployment is authorized.