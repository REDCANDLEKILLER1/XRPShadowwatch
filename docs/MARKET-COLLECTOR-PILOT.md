# Bounded XRP/RLUSD acquisition pilot

Baseline: main `61d9f3c6c6432f1b924517cbc3e0104a9f029479`, verified against remote main and production alias on 2026-10-10 UTC. Original handoff: `docs/savepoint-20261010-market-collector:docs/PROJECT_SAVEPOINT.md` at `19c1879586abcf3a7eff8ffc3454b2053ccc42d7`.

This implements the first acquisition pilot, not continuous collection or a new market-volume classifier. Existing watched-wallet evidence, reports, production settings and schedules are untouched. No deletion, roster admission, signing, submission, paid provisioning or public raw evidence output is introduced.

## Operator entry point after review and merge

Manually dispatch **Private forensic evidence** on **main**, select `pilot`, and supply `pilot_start` / `pilot_end`. Initial known interval: `107530078`–`107530079`. No dispatch or live R2 write was performed during implementation. The pilot is never selected by scheduled or push triggers, or by `both`. A branch dispatch cannot run the pilot writer. CLI execution also requires the exact repository, workflow, main ref, manual event, and `SHADOWWATCH_AUTOROSTER_ENABLED=false`.

The job shares `shadowwatch-private-r2-backup` concurrency with existing storage writers. All writers must honor this lane: storage inventory/reservation is not a cross-service distributed lock. R2 conditional checkpoint writes independently reject a stale ETag. No artifact-upload step exists. The production admission environment was not read or changed; the handoff's user-reported disabled value remains distinct from independent verification.

## Evidence and recovery

- Explicit interval, at most 32 ledgers. Pins a validated predecessor and target hash. Fetches full transactions and metadata by ledger index, then corroborates the complete transaction-hash list by exact ledger hash.
- Requires closed and validated headers, matching outer/inner indices and hashes, linked parents, unique hashes and contiguous transaction indexes. Refuses malformed or partial results. This trusts one RPC provider's validated header/list; it does not independently reconstruct the transaction Merkle root.
- Retains full responses plus derived exact-amount wallet-leg facts. Each gzip object is SHA256 addressed in private `market-pilot/v1/objects/`. An immutable upload is downloaded and hash checked before advancing the range checkpoint.
- `market-pilot/v1/ranges/<start>-<end>.json` is a bounded source manifest/cursor; each receipt binds ledger/parent hashes, object SHA256, bytes and transaction counts. Conditional ETag update and exact readback prevent stale-writer advancement.
- Re-running the **same range** verifies every referenced object, resumes the first uncollected ledger and never skips it. A failed read records the remaining gap and stops. A persistent missing ledger remains unresolved rather than being silently skipped or called zero activity. If storage itself fails, the prior cursor still identifies the uncollected range, even if the gap annotation cannot be saved.
- Interrupted writes may leave immutable orphan objects; replay reuses matching bytes after readback. No pruning. Completed replay does no new RPC calls/writes. Separate overlapping ranges may reference the same object; do not add their receipts or wallet legs together as unique market volume.
- Bounded full-ledger acquisition is independent of the 423-wallet roster. No new wallet is admitted.

## Limits and measurements

| Bound | Value |
| --- | --- |
| Requested interval | 1–32 ledgers |
| New ledgers per invocation | At most 4 |
| Compressed evidence per ledger | 2 MiB |
| Compressed evidence per invocation | 8 MiB |
| RPC response | Existing 16 MiB streamed response limit / 20-second request timeout |
| Acquisition request admission | 120 seconds / 66 requests maximum (one in-flight request can finish afterward) |
| Workflow pilot step | 5-minute timeout |
| Pilot daily reservation budget | 32 MiB, UTC day of invocation |
| Total R2 capacity | Existing 8,000,000,000-byte hard stop |

Before data writes, reserve the worst-case bytes for up to four ledger objects plus 128 KiB control overhead. Reservations are small immutable JSON objects whose keys encode the charged amount; failed attempts remain charged. This is deliberately conservative: actual smaller data does not refund the daily reservation. They survive date rollover without deletion. Bucket capacity includes existing evidence and reservations. The daily pilot budget is separate from the old market snapshot budget. A UTC-midnight-crossing run remains charged to its start day. Long storage operations are bounded by the workflow timeout, not the acquisition request timer.

CLI output contains aggregate counters only. Private manifests retain participant evidence. `unique_market_volume:null`, `classification_complete:false`, `history_complete:false`, `continuous:false` remain explicit, even after `interval_complete:true`. Existing narrow classification is for selected wallet legs; placements/cancels/AMM/routed fills are not claimed to be fully reconciled. No summary is published into LIVE/MAP/GRAPH or sealed reports in this phase.

## Verification performed

- New deterministic suite: boundaries, read-only RPC, header/parent/hash/index checks, duplicate rejection, restart/gap recovery, no-write repeated replay, readback corruption, failed object/checkpoint writes, stale ETags, corrupt restore, daily/bucket limits, time/run limits and existing real transaction fixture integration. Pass on Node 22.23.3 and Node 24.19.0.
- Existing market-evidence, forensic-patterns, forensic-report, R2 backup and master-backup suites passed locally. Syntax check passed; no browser/application surface changed.
- Read-only real RPC acquisition of complete ledgers `107530078` and `107530079` (plus predecessor/target headers and hash-list corroboration) replayed through the collector with an **in-memory storage adapter**: 55 + 75 = 130 transactions; 462,509 raw serialized response bytes; 102,865 compressed evidence bytes; 6 reads. Rerun: 2 reused ledgers, 0 RPC calls, 0 writes. Replay compute was 19 ms, excluding network acquisition and real storage; this is not a live compute/cost estimate.
- Existing classifier recognized 2 + 3 exchange transactions and 4 + 7 wallet legs. The legs are not independent fills; no market-volume sum is published.
- Raw replay input is transient private local test material, not committed to source, Actions artifacts, Library or a new durable backup. Existing R2/evidence repository data was not touched.

## Remaining gates

Independent review and exact-head CI, then separate merge authorization. After merge, manually run the two-ledger interval in private R2 and verify readback, restart and budget behavior there. Live R2 conditional operations and the new worker have not been integration-tested against the bucket. This phase does not enable a 24-hour trial. Real AMM/routed/partial-fill reconciliation, reliable runner selection, independent summary publication and product surfaces remain subsequent milestones from the original handoff. Do not extrapolate two ledgers into a daily storage cost or whole-market coverage claim.

Protocol reference: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger (checked 2026-10-10).
