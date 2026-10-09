# Forensic collection and retention, first pass

Branch: `agent/forensic-patterns-20261009`, stacked on storage/automatic-roster PR #104.
Read-only XRPL mainnet observations. No transaction submission, signing, automatic
roster changes, deletion, or ownership attribution. The existing acquisition path
is unchanged; Lady K's report receives the optional summary described below.

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
- `wallets/<address>/index.json`: every watched wallet and every classified
  counterparty, including watched wallets with no classified activity in the export.
- `days/<UTC-day>/`: daily summaries, flags, recent derived facts, and flagged
  facts **plus their complete original payloads** regardless of age.
- `retention-preview.json`: 30-day working-detail policy, 5 GB review threshold,
  older archive candidates and pinned file hashes. It never deletes files.
- `market/`: observed-prices CSV, sample references/checksums and descriptive
  history comparisons, plus recent raw sample files (whole UTC days covering at
  least the last 24 hours). Older originals remain in R2.
- `report-summary.json`: sealed aggregate for the latest 24 hours ending at the
  verified evidence anchor, available only after an independent R2 restore.

## Lady K's report

After the export is uploaded and independently read back, the workflow publishes
only the compact summary to `forensics/report/latest.json` and an immutable history
file in the private evidence repository. The existing evidence token needs Contents
write access for this step. A conflict retries against the new repository head;
an older evidence anchor cannot replace a newer one. Original shards and checkpoint
files are never modified by summary publication.

`GET /api/forensic-report` reads the summary at one pinned repository commit and
checks its seal, counts, amounts and observation period. It returns aggregate
figures without wallet addresses, raw payloads or private R2 locations. The browser
captures the response in the report pack before final rendering. The canonical
report gains a short **Market activity watch** section, so Lady K's displayed,
copied, downloaded and locally saved report contain the same text. Historical
packs without this field are unchanged.

The section identifies observed XRP sold for RLUSD and bought with RLUSD, repeated
same-price orders, repeated confirmed cancellations and regular transfer timing.
It names the observation window and states that observed wallet legs are not
whole-market volume or proof of common ownership or price control. It does not
yet narrate the separate market-snapshot timeline or the untested $1.41 hypothesis.
Data older than 36 hours is marked stale; a missing/failed response is unavailable,
never zero activity. Loading runs alongside startup with a six-second ceiling and
cannot edit an already saved report. With the current schedule the analysis updates
daily, not on every report scan. Missing credentials or a failed publication leave
the previous summary available with its original timestamp.

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
- Only the newest verified checkpoint manifest for each day selects its shards.
  Superseded files left in Git are listed as excluded and remain in the backup;
  they are not silently mixed into the current day or counted twice.
- Missing or unsupported payloads are counted and left unclassified; they cannot
  create trade totals. Daily summaries expose these counts.
- Branch push performs an initial sample and verified export. After merge to the
  default branch: snapshots every 15 minutes; daily export at 06:43 UTC. The daily
  export regenerates deterministic facts from the pinned source; it does not add
  yesterday's totals onto today's and double-count them.
- Rollback: disable `Private forensic evidence` in Actions. Original evidence,
  collector, checkpoint and watchlist remain intact; the report summary ages into
  an explicit stale notice.

Local operator use (no network access for the analyzer):

```sh
node scripts/forensic-export.js VERIFIED_MASTER_BACKUP NEW_OUTPUT_DIRECTORY
node scripts/forensic-patterns.test.js
node scripts/forensic-report.test.js
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
