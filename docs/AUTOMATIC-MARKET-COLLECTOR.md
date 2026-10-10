# Bounded automatic market collection

This extends the read-only collector merged in PR #110. It collects complete,
validated ledger responses rather than only transactions involving watched
wallets. It does not add wallets, sign or submit transactions, change public R2
access, or delete evidence.

## Activation and limits

The workflow is staged behind the repository variable
`SHADOWWATCH_MARKET_AUTOCOLLECT_ENABLED=true`. Until the reviewed changes are on
`main` and that variable is enabled, no new automatic collection runs. The workflow
also requires this repository, the main branch, schedule/manual dispatch, and
`SHADOWWATCH_AUTOROSTER_ENABLED=false`. A preview cannot publish evidence.

| Limit | Enforcement |
| --- | --- |
| Target schedule | Minutes 11, 26, 41, 56 each hour; GitHub may delay or drop runs |
| New ledgers per invocation | At most 4, strictly in ledger order |
| Raw object size | At most 2 MiB compressed per ledger |
| New raw objects per invocation | At most 8 MiB, plus reserved checkpoint overhead |
| Automatic collector daily budget | 32 MiB charged per UTC day |
| Shared R2 bucket ceiling | 8,000,000,000 bytes, including other stored evidence |
| RPC budget | At most 11 read-only ledger calls; no new calls after 120 seconds |
| Response limits | 16 MiB per RPC response; 32 MiB combined record before compression |
| Workflow time | 5-minute collector step; 10-minute job |
| Supervisor state / derived summary | Each at most 24 KiB; at most 12 execution examples |
| Summary freshness | Stale after 45 minutes; stale execution totals/cards withheld |

All R2 writers share `shadowwatch-private-r2-backup` concurrency. This is necessary
for the capacity check/reservation guarantee. The new collector's daily budget is
separate from the existing market sampler and manual pilot budgets; the bucket
ceiling is shared. Daily charged bytes are conservative accounting, not a billing
estimate. Each invocation first reserves 64 KiB for supervisor control writes.
The collector reserves its worst-case raw/checkpoint allocation before writing.
Only a normally returned, readback-verified storage operation can settle its own
reservation to attempted object/checkpoint bodies plus 4 KiB accounting overhead.
Storage failures retain the full reservation. Retries and abandoned objects
cannot silently release that allowance. Inventory includes all bucket objects.

Four ledgers per scheduled run cannot keep pace with the live XRP Ledger. A
growing backlog is expected with these pilot limits. This release makes that
shortfall explicit; it does not claim continuous or whole-market coverage.
Increasing throughput requires measured storage/RPC costs and a separate reviewed
change. No automatic limit increases or pruning are implemented.

## Checkpoints, gaps and recovery

On first activation, collection begins at the observed latest validated ledger.
Earlier history is outside its scope. The supervisor plans ranges of at most 16
ledgers and persists the plan before acquisition. Every range is bound to the
preceding verified ledger hash. It reuses the pilot's expanded/hash-list checks,
transaction-index reconciliation, immutable compressed objects, SHA-256 readback
and conditional checkpoints. Corroboration uses the same XRPL provider; it is not
independent transaction-root reconstruction.

The cursor moves only across an uninterrupted prefix with verified stored bytes.
A failed ledger is retried at the same index. No range is skipped. The last receipt
is checked on restart; newly adopted receipts are reclassified from their verified
raw responses. A crash between the pilot and supervisor commits is recovered from
receipts beyond the durable supervisor cursor, so totals are not added twice.
Recovery may adopt earlier saved receipts plus up to four newly collected ledgers.

The summary exposes activation ledger, next ledger, count verified, latest
observed validated ledger, missing ranges, delay since the last verified close,
and excess time beyond the 15-minute target since the prior saved run. That last
measurement is an observed run gap, not GitHub's internal queue latency. Storage
includes total bucket usage and the collector's charged allowance for the UTC day
shown. A run crossing midnight reports the new day's measured budget.

Raw records remain in private R2 under `market-pilot/v1/`. Supervisor state and
automatic budget records use `market-auto/v1/`. Only a sealed compact derived
summary is committed to the pinned private evidence repository at
`forensics/market/latest.json`. The public GET API returns validated summary fields,
never raw records, credentials or private object keys. Summary writes reject an
older cursor, older publication time, or changed activation origin. API or storage
failure is unknown/stale, never proof of zero activity.

## XRP/RLUSD execution classification

Only successful validated `OfferCreate` and `Payment` metadata can produce fills.
RLUSD must match both the canonical currency and issuer already pinned in
`forensic-patterns.js`. Requested payment amounts and order placements are not
trade amounts.

* **Order-book fill:** both XRP and RLUSD remaining-offer quantities decrease.
  Count one component per affected Offer node, with exact decimal arithmetic.
* **Partial fill:** a modified offer retains a remainder. A deleted offer with
  positive final amounts is marked `PARTIAL_REMOVED`; only its proven reduction
  counts. A deleted offer with both final quantities zero is `FULL`.
* **Ambiguous removal:** deletion without both execution deltas is excluded.
  It can be expiration, cancellation or an unfunded offer.
* **AMM pool movement:** a canonical RLUSD AMM trustline identifies the pool,
  its AccountRoot has AMMID, and its XRP/RLUSD balance changes have opposite signs.
  Report net pool changes, including pool fees. These are transaction-level pool
  components, not independently enumerated internal swaps or taker amounts.
* **Liquidity operations:** AMM transaction types are counted separately and
  excluded from swap totals. Missing or contradictory execution metadata is
  reported as unreconciled, with no invented amounts.

Order-book and AMM amounts stay separate. A routed payment can contain both;
their sum is not a unique economic-trade volume. Opposing wallet legs are not
double counted. Neither these components nor repeated price patterns establish
wallet ownership or price control.

Protocol references:

* https://xrpl.org/docs/references/protocol/transactions/metadata
* https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/accountroot
* https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/ripplestate

## Product surfaces and verification

LIVE, MAP and GRAPH share one coverage fetch, display gaps/storage/delay, and show
up to twelve verified execution components with transaction links and wallet
tracing. These cards do not add wallets to the roster or infer ownership edges.
Coverage remains available when the older wallet-pattern summary is unavailable.
The existing report data bundle includes this same summary, and the canonical
report rendering includes its coverage and execution totals. Previously sealed
report text is never rewritten by the injector.

Focused tests cover caps, corrupt receipts, wrong parents, restart/CAS failures,
no double counts, midnight budgets, private publication, preview refusal,
captured partial-fill metadata and synthetic full-fill/AMM cases. Browser tests
exercise desktop/phone layouts, stale withholding and independent evidence
availability. AMM tests are synthetic protocol fixtures; this version has not
been independently reconciled against a captured live AMM swap.

The earlier two-ledger R2 pilot verified the base storage path. It does not verify
this new supervisor's live workflow. After review/merge, enable the variable and
dispatch one controlled invocation. Inspect the bounded range, R2 readback,
published summary, run limits and admission-off setting before leaving the
schedule enabled. To pause, set the variable to `false`; keep all stored state
and evidence so the next approved run resumes the same cursor.
