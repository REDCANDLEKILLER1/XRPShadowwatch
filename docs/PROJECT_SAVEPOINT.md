# ShadowWatch verified savepoint — market collector handoff

Verified at **2026-10-10 00:40–00:43 UTC** (October 9, evening CDT).
Owner: REDCANDLEKILLER / XRPMan. Production: https://shadowwatch.xyz.

**Classification: verified stable checkpoint of the existing deployed application, with the collection limitations below.** The broader market collector is proposed work, not implemented or running. This handoff preserves an exact, durable application revision and evidence pointers; it is not a new full evidence backup or proof that every feature is complete.

## 1. Restore identity and locked baseline

| Item | Verified identity |
| --- | --- |
| Application repository | `REDCANDLEKILLER1/XRPShadowwatch` |
| Main, local HEAD before this handoff, and production revision | `61d9f3c6c6432f1b924517cbc3e0104a9f029479` |
| Application tree | `65274cba9b64522538ffb52f659715ef6170dd0a` |
| Production deployment | `dpl_3M965ziduhV3mGZ5AM3AYt9muKf9`, READY, target production, alias `shadowwatch.xyz` |
| Vercel project | `prj_P0GZodZHNdgPblDOrACIza9MF1rf`, `xrpshadowwatch` |
| Vercel team | `team_HPAp4YU75rTBpGSIv35u0R8y`, `xrpmans-projects` |
| Handoff branch | `docs/savepoint-20261010-market-collector` |
| Handoff path | `docs/PROJECT_SAVEPOINT.md` |

The working tree was clean on main before this documentation-only change. No market collector changes, experiments, untracked application work, or unsaved assets existed. The subsequent documentation commit is separate from the application revision above. Main and production must not be moved merely to publish this handoff.

The uploaded historical source ZIPs are not the production baseline. Resume from GitHub and inspect newer main before making changes; do not reset it automatically to this checkpoint.

## 2. Completed fixes and verification

| Change | Exact revision / evidence |
| --- | --- |
| Pattern displays on LIVE, MAP, GRAPH; optional news fallback and bounded escrow lookup coverage | Already in baseline preceding PR #107; implementation described in `docs/PATTERN-SURFACES-20261009.md` |
| PR #107: retain XRP/RLUSD analysis despite unrelated market-price timeout | Merged `f239b81c75e088136fb5a6b75faa52f3c1ffc945`; final head `3adbe828508cc2f0c932c19f867e49673066ad1d` |
| PR #108: independent analysis load, joined before report sealing | Merged `0b594bef7f4a44cfa79d4802aee3c7c442284337`; head `cfb8ad7b3f841974b444d8e852ea1257ab9fc864`; CI [37937764465](https://github.com/REDCANDLEKILLER1/XRPShadowwatch/actions/runs/37937764465) completed SUCCESS |
| PR #109: publish proof after actual R2 download and isolated restore | Main revision above; head `374c5c2771773f664c6dd91d85383a8fd2b7658d`; CI [37944566805](https://github.com/REDCANDLEKILLER1/XRPShadowwatch/actions/runs/37944566805) completed SUCCESS |

Main regression run [37950110743](https://github.com/REDCANDLEKILLER1/XRPShadowwatch/actions/runs/37950110743) completed SUCCESS on the exact deployed revision `61d9f3c6c6432f1b924517cbc3e0104a9f029479`. PR #109 regression job `113867399463` passed the regression suites, WebKit pattern surfaces, and WebKit mobile completion/saved-report steps. Final main and PR #108/#109 CI status was freshly checked for this savepoint; older notes saying those runs were pending are superseded. No expensive application suite was rerun just to write documentation.

Source inspection at the main revision confirms:

- `src/shared/market-watch.js` has a 20-second bounded analysis request.
- `src/brief/02-core.js` starts `forensicPromise` independently of the 15-second market boot, resets prior market state, and awaits the result before `buildPack`.
- `scripts/forensic-backup.js` publishes the restore receipt after `roundTrip`; the other R2 worker is included in the PR #109 repair. Restore proof is not fabricated from log text.
- `src/db/auto-roster.js` still requires the explicit enabled flag, restore proof, noncritical capacity, and qualified evidence.

Runtime verification is separate from deployment readiness: `/api/storage-health` and `/api/forensic-report` returned the values below at 00:40 UTC. The user's completed report `SW-20261010-MC8WC` also contains “XRP/RLUSD market activity watch” and logs analysis AVAILABLE after the price-boot timeout. The missing-section loading bug is fixed; inadequate market coverage is a different problem.

## 3. Evidence and backup state at verification

Private evidence repository:
`REDCANDLEKILLER1/SHADOWWATCH_EVIDENCE_REPO-REDCANDLEKILLER1-XRPShadowwatch-evidence`.

| Evidence state | Value |
| --- | --- |
| Production health checked at | `2026-10-10T00:40:31.439Z` |
| Current evidence commit | `243295aa3464b464649e26e31a1120099fc7f3d6` |
| Current evidence tree | `8a1eef5ee564d09d5e1078caf9782b8b7a992fbe` |
| Verified checkpoint | State 259, 423 wallets, ledger 107548329 |
| Evidence anchor | `2026-10-09T22:39:32.000Z` = October 9, 5:39:32 PM CDT |
| Sealed checkpoint report | `SW-20261009-EA2FE`, 423/423 complete, `admitted_wallets: []` |
| Accumulated Git storage estimate | 7,552,518,144 bytes; WARNING |
| Current tracked evidence files | 827 files, 1,776,643,635 bytes |
| Backup status | VERIFIED_RECENT; independent restore verified; age about 9.10 hours |
| Deletion / automatic rollover | Both false |

Capacity warning/critical thresholds are 5 GiB / 8 GiB operational thresholds, not provider quotas. Current-file size, accumulated Git history, and R2 occupancy are different measurements. Deleting current files does not erase Git history. **Current R2 total occupancy was not freshly inventoried for this savepoint.**

The committed receipt `evidence/backup/latest.json`, read at the current evidence commit, reports:

- Verified at `2026-10-09T15:34:23.551Z`.
- Backed-up source commit `d1bb6024effc6e3a5bac5606d01fa1d17ed2bb8b`.
- Source tree `6f8efa974fe0053511ebf6c57c9defaaa0cf1ada`.
- Source evidence anchor `2026-10-09T14:12:00.000Z`.
- Manifest SHA256 `01a75b6578c2dcd40011ba5f558742ed77bc4161691700dbfa7b0ec26b41f288`.
- 817 files, 1,757,555,340 bytes; `restore_verified: true`, `independent_readback_verified: true`.
- Method `R2_DOWNLOADED_AND_ISOLATED_RESTORE`; private bucket `shadowwatch-backups`.

This verifies the receipt and current production consumer result. This savepoint did **not** perform another complete download/restore. Backup coverage ends at the receipt's source anchor, not at the newest evidence anchor. The existing gate expires based on both receipt and anchor freshness within 24 hours; recheck before any later admission work.

## 4. Why the reported XRP/RLUSD totals are tiny

The published summary is derived from watched-wallet evidence, with narrow recognized exchange routes. It is not a market-wide trading tape.

Fresh read of `/api/forensic-report`:

| Field | Value |
| --- | --- |
| API status | AVAILABLE (current code allows up to 36 hours of age) |
| Generated | `2026-10-09T05:38:46.618Z` |
| Observation window | `2026-10-08T04:40:02.000Z` through `2026-10-09T04:40:02.000Z` |
| Window end in user timezone | October 8, 11:40:02 PM CDT |
| Source evidence commit | `2742e66bb3ec0ff78516c9c9fb8b5af46c1ff68d` |
| Source manifest SHA256 | `9009cc25076d75f68ca292e1199063a4df89d24a75fa0df7f94069318fe6b3cf` |
| Summary SHA256 | `2f4d3efb1fa169ee782b41285b26a801e37496a841406a64cd0a1a2a0a59a8c9` |
| Observed records | 78,362; classified 77,942; excluded unsuccessful 420 |
| Recognized exchange transactions / wallets | 29 / 7 |
| XRP sold for RLUSD / bought with RLUSD | 5.902183 / 4.855545 |
| Repeated quote / cancellation wallets | 0 / 0 |
| Regular transfer interval wallets | 6 |
| Scope | OBSERVED_WALLETS_AND_COUNTERPARTIES |

These amounts count recognized **wallet exchange legs**. They cannot be added together and called unique whole-market volume or a measure of global buying/selling pressure. `ANALYZED` means the record was processed under current rules, not that every possible trading route was classified.

The newer MC8WC report successfully scanned 145,391 transactions across 423 wallets, but reused this older market summary. This is why fresh wallet evidence and a successful report do not imply fresh market analysis.

## 5. Known collection and publication gaps

1. **Discontinuous acquisition:** `scripts/market-evidence.js` reads one current validated ledger, two XRP/RLUSD books capped at 200 offers each, and one Coinbase XRP-USD ticker. Its scope correctly says `continuous:false`, `history_complete:false`, and incomplete books. It has no durable consecutive-ledger cursor or gap recovery.
2. **Schedule differs from actual execution:** `.github/workflows/forensic-evidence.yml` configures samples at `7,22,37,52 * * * *` and export at `43 6 * * *`. Recent successful market runs began at 11:32, 17:32, and 21:52 UTC October 9, hours apart. Do not describe this as verified continuous or reliable 15-minute collection.
3. **Failed analysis refresh:** run [37938729950](https://github.com/REDCANDLEKILLER1/XRPShadowwatch/actions/runs/37938729950), job `113847327816`, failed at `2026-10-09T13:46:50Z`: `GITHUB_ARCHIVE_HTTP_500: Internal Server Error`. The backup/export failed before a new summary published. A later verified backup receipt did not refresh this separate analysis.
4. **Collected market evidence is not feeding displayed totals:** `scripts/market-history.js` writes sampled price history and quote-size comparisons into the private forensic archive. `scripts/forensic-backup.js` still publishes `analysis.report_summary` built from watched-wallet shards, after appending market files separately.
5. **Classifier scope is narrow:** `src/db/forensic-patterns.js` requires exactly two nonzero account asset changes (XRP and the exact RLUSD asset), plus recognized OfferCreate-owner, self-Payment, or consumed-offer-owner evidence. Complex routes and some AMM activity are omitted. Build and reconcile route-specific classification before claiming broad coverage.
6. **Freshness is too coarse for this investigation:** AVAILABLE permits 36-hour-old analysis. Show observation time, gaps, source coverage, and stalled refresh separately from endpoint availability.
7. **Market boundaries:** public XRPL reads do not expose private institutional ledgers or customer trades internal to centralized exchanges. The user's private-ledger assertion and $1.41 price-control hypothesis are not established findings. USD venue prices and RLUSD execution prices are distinct observations.

The existing Vercel watched-wallet schedule is separate: fresh collection every even UTC hour at :05; recovery every odd hour at :05. Those cron definitions remain in `vercel.json`; a configured schedule is not proof every run succeeds. No cadence settings were changed during this handoff.

## 6. Safety settings and protected behavior

- **Read-only XRPL mainnet observation only.** No signing, submit calls, trading, payouts, wallet secrets, or transaction authorization is introduced by this project work.
- **Keep automatic admission disabled.** The user reported setting production `SHADOWWATCH_AUTOROSTER_ENABLED=false` during PR #109 release. The environment value was **not independently read**: environment access was denied earlier, and must not be retried or bypassed. No settings were changed for this savepoint.
- Browser debug flags `auto_add:false` / `no_auto_add:true` and the 423-wallet checkpoint do not prove the scheduler's environment value. Preserve this distinction.
- Automatic admission is separate from market discovery. Existing `src/db/auto-roster.js` qualifies unknown counterparties of large directly observed XRP Payments: a single >=10M XRP payment, or >=2 transactions on >=2 ledgers totaling >=5M XRP, with each qualifying payment >=1M; 72-hour window; at most 5 additions per run. It does not enroll every DEX participant.
- Before enabling admission, perform a fresh read-only qualification preview, recheck backup/capacity/history gates, then obtain the separately authorized bounded admission test required by the release handoff. Do not enable admission as a side effect of the new collector.
- Keep R2 private. No public evidence bucket or raw private evidence in Actions artifacts. Credential names only: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SHADOWWATCH_EVIDENCE_TOKEN`; no secret values in this handoff.
- Current R2 worker hard stop: 8,000,000,000 bytes. Market sampling limits: 2 MiB compressed per sample and 32 MiB/day. These are existing application limits, not a new storage-cost estimate.
- Preserve strict validated-ledger anchoring, source hashes, exact decimal amounts, deduplication, fail-closed history completeness, and sealed report immutability. A timeout or missing data must not become a numeric zero.
- No source deletion, retention pruning, Git-history rewrite, automatic rollover, or public access change is authorized by the savepoint. The proposed month of raw data plus historical summaries is not a deployed retention policy.
- Preserve existing LIVE/MAP/GRAPH pattern surfaces, optional news fallback, bounded escrow lookup coverage, and all report copy/download formats. Partial optional news/escrow results must remain labeled partial.

## 7. Next build: scoped milestones and acceptance gates

**Objective:** investigate repeated XRP/stablecoin trading and order behavior around the user's proposed $1.41 USD pivot, with traceable supporting evidence and honest coverage. Do not start by merely raising wallet counts or hiding all small trades.

**First concrete action:** refresh remote main, inspect the paths below, and create a separate implementation branch for a bounded XRP/RLUSD collector pilot. Begin with a replayable known ledger interval and measurement harness. No collector code has been written in this phase.

1. **Reliable acquisition:** consume validated market activity independently of the 423-wallet roster. Persist ledger/hash checkpoints only after durable writes; recover missed ranges; record unrecoverable gaps; handle reconnects, duplicates, and overlapping runs. Preserve enough raw transaction metadata to reproduce each finding.
2. **Correct trade classification:** reconcile direct DEX fills, partial fills, AMM swaps, and routed payments using real fixtures. Separate placements, cancellations, replacements, executed exchanges, and liquidity deposits/withdrawals. Validate exact RLUSD currency and issuer. Do not count the same economic fill twice through participant legs or multiple data sources.
3. **Independent summary publication:** decouple the market summary's refresh from a full evidence backup/export while preserving verifiable source manifests, readback, size bounds, and atomic/nonregressing publication. Watched-wallet totals and market-collector results must carry separate scope and freshness.
4. **Wallet patterns and price comparisons:** aggregate meaningful cumulative activity, repeated order prices, execution followed by replenishment, timing, and counterparties. Compare observations near and away from the proposed band and across independent time periods. Rank small repeated trades by aggregate significance. Label patterns as leads; no unsupported ownership, bot-control, short-position, or manipulation verdict.
5. **Shared product output:** feed reviewed summaries into LIVE, MAP, GRAPH, and Lady K's report, with supporting hashes, participant details, coverage intervals, gaps, and observation age. Extend existing surfaces rather than duplicating them. Market findings can list new participants without permanent roster admission.
6. **24-hour trial and storage sizing:** after deterministic replay/reconnect tests, run a bounded read-only trial with measured processed/missed ledgers, reconciled trades, bytes/day, RPC load, and compute cost. R2 is storage, not the process runner. Reliable hosting/scheduling remains unselected; do not promise continuous operation or free capacity from the existing GitHub cron. Concrete new charges need an explicit decision before provisioning.
7. **Retention later:** design compressed recent raw records, durable daily summaries, per-wallet indexes, and retained flagged evidence. Verify reconstruction/restore before proposing deletion. Do not discard proof merely because spreadsheet totals exist.

Acceptance before release: known-window reconciliation; restart/gap recovery; no double counting; unsupported routes disclosed; exact asset identity; source-to-summary traceability; stale/missing-data behavior; browser/mobile report consistency; bounded storage use; read-only/admission safeguards; relevant regression CI at the exact head; reviewed preview before a separate merge/deployment action.

Relevant paths: `scripts/market-evidence.js`, `scripts/market-history.js`, `scripts/forensic-export.js`, `scripts/forensic-backup.js`, `scripts/publish-restore-receipt.js`, `scripts/r2-master-backup.js`, `src/db/forensic-patterns.js`, `src/db/forensic-report.js`, `src/db/backup-receipt.js`, `src/db/auto-roster.js`, `src/shared/market-watch.js`, `src/brief/02-core.js`, `.github/workflows/forensic-evidence.yml`, `vercel.json`.

Relevant tests: `scripts/forensic-patterns.test.js`, `scripts/forensic-report.test.js`, `scripts/market-evidence.test.js`, `scripts/r2-master-backup.test.js`, `scripts/storage-master-backup.test.js`, `scripts/pattern-surfaces.test.js`, `scripts/stored-run-completion.test.js`. Use Node 22 and the repository's existing npm/Playwright setup; do not assume a lockfile or use `npm ci` blindly.

Official protocol references for implementation:
- https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/subscription-methods/subscribe
- https://xrpl.org/docs/concepts/networks-and-servers/ledger-history
- https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/book_changes

## 8. Resume without losing work

Application code is durably available at the main SHA above. This documentation branch adds only this handoff. Private evidence remains in its existing private repository and R2; neither data nor credentials are copied into the public handoff. All proposed market-collector work remains future work, so there is no unpublished implementation to recover.

Read the saved handoff first, then inspect remote state:

```bash
git clone https://github.com/REDCANDLEKILLER1/XRPShadowwatch.git
cd XRPShadowwatch
git fetch origin main docs/savepoint-20261010-market-collector
git show origin/docs/savepoint-20261010-market-collector:docs/PROJECT_SAVEPOINT.md
git status --short --branch
git rev-parse origin/main
```

If a checkout already exists, inspect its changes before switching branches. The exact saved application can be checked out in a separate worktree at `61d9f3c6c6432f1b924517cbc3e0104a9f029479`; do not reset an active checkout or production.

Copy-ready next-chat instruction:

> Resume ShadowWatch from `REDCANDLEKILLER1/XRPShadowwatch`, branch `docs/savepoint-20261010-market-collector`, file `docs/PROJECT_SAVEPOINT.md`. Read the handoff and verify current main/production before continuing. The saved application baseline is `61d9f3c6c6432f1b924517cbc3e0104a9f029479`. Build the bounded XRP/RLUSD collector pilot and reconcile coverage before a 24-hour trial. Keep XRPL observation read-only, automatic wallet admission disabled, and raw evidence private. Do not delete evidence or enable new paid hosting as part of resuming.
