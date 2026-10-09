# Forensic collection and retention, first pass

Branch: `agent/forensic-patterns-20261009`, stacked on storage/automatic-roster PR #104.
Read-only XRPL mainnet observations. No transaction submission, signing, automatic
roster changes, deletion, or ownership attribution. Existing report and acquisition
paths are unchanged.

## What this adds

The existing account_tx collector already saves complete raw transaction metadata
for the watched roster. The offline analyzer reads a pinned, verified master
snapshot and extracts:

- Executed net XRP/RLUSD exchanges for qualifying OfferCreate owners, consumed
  offer owners, and self-directed cross-currency payments. Both balance legs must
  exist, have opposite signs, and have no third changed asset. Submitter fees are
  removed from XRP expenditure. This is net wallet execution, not a trade tape.
- Successful order instructions, stored-offer creation, replacement requests, and
  cancellation confirmed by the matching deleted offer. A successful no-op cancel
  is not a confirmed cancellation. An order submission is not a fill. Deleted
  offers alone are not fills: they may be expired or unfunded.
- Delivered direct XRP transfers and regular transfer intervals. Cross-currency
  payments to other recipients are retained as payment facts, not attributed as
  the sender's self-exchange.
- Per-wallet daily totals and histories, repeated limit prices, repeated confirmed
  cancellations, and regular transfer timing with all supporting transaction hashes.

Amounts and totals use exact string/BigInt decimal arithmetic. Effective prices
include an exact rational representation; the approximate number is convenience
only. Totals count wallet legs: summing buyer and seller wallets would double-count
market volume. No global-volume figure is calculated.

The initial stablecoin allowlist is **mainnet RLUSD only**, matched by its full
40-hex currency code and issuer. Symbols alone never establish identity. Other
tokens remain in raw evidence and can be added after issuer verification and tests.
No assumption equates a unit of RLUSD with one actual US dollar.

## New market evidence

`scripts/market-evidence.js` reads one validated ledger with its full transaction
metadata, the best available 200 offers in each direction of the public XRP/RLUSD
book at that exact ledger hash, and a Coinbase Exchange XRP-USD ticker. It keeps raw
responses, observation and source timestamps, issuer identity, transaction hashes,
and derived facts. Stale/missing ticker or book responses are explicit gaps; a
missing or stale validated ledger fails the sample.

Snapshots target every 15 minutes once this workflow reaches the default branch.
GitHub scheduling may delay or omit observations; these are **samples**, not
continuous order-book or transaction surveillance. One sampled ledger does not
cover the preceding 15 minutes. Book visibility is capped and excludes private
permissioned books. CEX customer identities, private ledgers, and derivatives
positions cannot be inferred. Rapid trigger/cancellation analysis needs a later
continuous collector. Do not treat an absent observation as an absent event.

The proposed $1.41 pivot and $0.01 band are recorded as an **untested hypothesis**.
All sampled prices are retained, including other levels. No bot, common-owner,
price-control, or causation verdict is produced. The export includes a 30-day
sample timeline, nominal quoted-size increases at the same wallet/side/price,
and sampled execution legs alongside the contemporaneous ticker. A size increase
can reflect changing top-N visibility or partial funding, so it is not called a
proven refill. Comparisons stop across gaps over 30 minutes; repeated ledger
samples do not double-count executions. Control-window comparisons and statistical
causality analysis remain future work.

## Private export and retention

`scripts/forensic-backup.js NEW_DIRECTORY` creates a pinned master backup, uploads
it to private R2, independently downloads every byte, restores and verifies it,
then analyzes the restored source. It publishes one `shadowwatch-forensics.tar.gz`
under `forensics/<source-commit>/<sha256>/` and verifies an independent readback.
The object key and checksum appear in the Actions summary; private evidence is
never uploaded as an Actions artifact. Download that archive from the R2 dashboard
to inspect it or share it for analysis.

Archive contents:

- `index.json`: source commit/manifest seal, assets, coverage limitations, day counts.
- `daily-wallet-totals.csv`: daily direct XRP transfers, order/cancel counts and flags.
- `daily-exchange-totals.csv`: exact daily exchange totals by wallet and asset.
- `wallets/<address>/<UTC-day>.json`: daily wallet totals, recent exchanges/orders,
  flags and available checkpoint coverage. Null coverage is unknown, not complete.
- `days/<UTC-day>/`: daily summaries, flags, recent derived facts, and flagged
  facts **plus their complete original payloads** regardless of age.
- `retention-preview.json`: 30-day working-detail policy, 5 GB review threshold,
  older archive candidates and pinned file hashes. It never deletes files.
- `market/`: observed-prices CSV, sample references/checksums and descriptive
  history comparisons, plus recent raw sample files (whole UTC days covering at
  least the last 24 hours). Older originals remain in R2.

All original source files remain in private R2 content-addressed storage and the
source repository. Historical totals remain in immutable exports. Old unflagged
detail is omitted only from the derived export, not from the source or backup.
The cutoff is relative to the evidence anchor and uses whole UTC days conservatively.

Removing working source shards is blocked until existing readers and checkpoint
references resolve archived data. Git history also retains deleted files, so
removal alone does not reclaim repository storage. The 5 GB threshold measures
current tracked evidence files; Git history size is explicitly unmeasured.

## Bounds and operation

- R2 writers share the master-backup concurrency group; one writer at a time.
- Existing 8 GB bucket stop applies to backups, exports, and market samples. This
  is an operational limit for this bucket, not an account-wide billing guarantee.
- Market data: at most 2 MiB per sample, 32 MiB per UTC day; no automatic deletion.
- Export: at most 250,000 unique events per day, 4 MiB per NDJSON row and 100 MiB
  compressed output. A limit failure stops publication, never silently truncates.
- One day is analyzed at a time; payloads are streamed. Flagged originals are
  reread after the pattern pass. Conflicting events/orphan payloads fail export.
- Missing or unsupported payloads are counted and left unclassified; they cannot
  create trade totals. Daily summaries expose these counts.
- Branch push performs an initial sample and verified export. After merge to the
  default branch: snapshots every 15 minutes; daily export at 06:43 UTC. The daily
  export regenerates deterministic facts from the pinned source; it does not add
  yesterday's totals onto today's and double-count them.
- Rollback: disable `Private forensic evidence` in Actions. Original evidence,
  existing collector, report, checkpoint and watchlist remain intact.

Local operator use (no network access for the analyzer):

```sh
node scripts/forensic-export.js VERIFIED_MASTER_BACKUP NEW_OUTPUT_DIRECTORY
node scripts/forensic-patterns.test.js
node scripts/market-evidence.test.js
```

## Protocol references verified October 9, 2026 UTC

- https://xrpl.org/docs/references/protocol/transactions/metadata
- https://xrpl.org/docs/concepts/transactions/finality-of-results/look-up-transaction-results
- https://xrpl.org/blog/2015/calculating-balance-changes-for-a-transaction
- https://docs.ripple.com/products/stablecoin/overview/token-addresses
- https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
- https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_offers
- https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger
- https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker
