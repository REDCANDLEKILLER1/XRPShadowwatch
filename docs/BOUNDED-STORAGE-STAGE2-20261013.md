# Bounded storage stage two: read-only backup and retirement review

This draft stacks on stage one (PR #116, `e3bf5e33722002782780659c739a013864b526ae`). It does not enable the bounded runtime, create or configure storage, write recovery objects, delete evidence, merge, or switch production. Stage one's unconditional production runtime block remains in place.

## Implemented contract

- The R2 provider adds current-key ListObjectsV2 inventory, with explicit prefix/bucket scoping, continuation-token validation, duplicate rejection, bounded pages/object count, malformed/truncated-response rejection, and no delete method.
- `bounded-backup.capture(provider, {sourceIdentity})` reads the complete bounded namespace and all bytes, validates content-addressed keys, root/checkpoint/state history, schema-owned references, snapshots, frozen detail, journal rows, flags and rollups, then rechecks listing and root stability. Pending reservations fail closed. It produces a source-typed SHA-256-sealed manifest.
- `verifyRestore(manifest, recoveryProvider, {recoveryIdentity})` reads an already materialized independent copy. It requires a distinct account/failure-domain identity, matching current-key contents and a valid graph. It performs no restore writes. Provider ETags and modification dates are observations, not portable content identities.
- `verifyManifest` and `verifyReceipt` check record structure/seals only. They explicitly do not prove current provider contents. SHA-256 seals are integrity checks, not signatures or authentication. Provider identity is configured context, not proof of cloud-account ownership; offline memory results are not live R2 qualification.
- `bounded-retention.planRetention(source, recovery, {sourceIdentity, recoveryIdentity, now})` freshly captures both sides. It protects all current/historical snapshots, archive read routes, permanent evidence, incomplete journals, pending operations and the seven-complete-UTC-day window. Only old, independently backed-up, unreferenced staging objects can become `REVIEW_CANDIDATE`. Missing timestamps hold. A final source rescan invalidates a stale plan.

Every plan states `gc_enabled:false`, `deletion_authorized:false` and `capacity_relief_applied:false`. Candidate bytes are current-key bytes only, never reclaimed storage or billable savings. Historical versions, provider overhead and existing legacy Git history are excluded and require separate inventories/backups. Normal canonical detail remains reachable through immutable snapshots and archive routes; becoming older than seven days does not make it freeable.

## Offline use

Import the modules in an operator-controlled offline harness and supply providers with matching explicit identities. Memory-provider fixture copies exercise verification without credentials or network writes. No production CLI, runtime hook, automated scheduled task or health/admission integration is installed by this stage. The included tests show fixture creation and independent copy verification.

A caller must treat any failure as no verified result. Retention plans are point-in-time review artifacts, never deletion capabilities; concurrent changes after the last observation require a new plan and future version-aware deletion design.

## External gates still open

1. Authorized isolated live R2 concurrent CAS and lost-response qualification, with exact account/bucket/namespace evidence. Documentation and mocks are insufficient.
2. Materialize and independently restore a real bounded-store backup in a separate failure domain; this verifier does not perform that copy. Existing legacy Git backup coverage remains separate.
3. Run representative real-volume bootstrap, memory, report parity, flag/proof growth and restore-duration rehearsals. Add source-typed report receipts and storage-health/admission integration before activation.
4. Decide archival lifetime and read routing for all pinned/historical snapshots before any physical retention implementation. This draft cannot stop permanent/historical growth and cannot promise indefinite capacity relief.
5. Review a concrete cutover/rollback rehearsal and request explicit production-switch approval before changing the unconditional runtime gate. No merge or production switch is authorized by these drafts.

Validation: new backup, retention and provider inventory cases are in the explicit aggregate test runner. Exact final local/CI results and independent review are reported with the PR, rather than preclaimed here.
