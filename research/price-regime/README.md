# XRP Historical Price-Regime Research

Status: experimental research only.

Production ShadowWatch baseline:
- repository: REDCANDLEKILLER1/XRPShadowwatch
- base SHA: 877b8bf819d401ffea0bc839fabe5befed856a60
- research branch: agent/historical-price-regime-research

## Isolation contract

This research code must not:
- write to the production ShadowWatch evidence store;
- mutate the production checkpoint, journal, day shards, archive, or permanent watchlist;
- alter the production scan/report path;
- sign XRPL transactions or submit transactions.

XRPL use is read-only.

## Predeclared primary hypothesis

During 2026, XRP may exhibit a recurring price regime centered approximately around $1.40. Large/high-value XRPL actors may show measurably different accumulation and distribution behavior below versus above that regime, potentially contributing to mean reversion toward it.

This is a hypothesis to test, not an assumed conclusion.

## Required falsification controls

The research engine must:
1. Test the predeclared ~$1.40 region.
2. Independently search the observed price range for the strongest behavioral regime without privileging $1.40.
3. Compare the candidate regime against neighboring/control price bands.
4. Separate observed behavior from claims of ownership, coordination, manipulation, intent, or private agreements.
5. Report contradictory and null results.

## Phase 1 deliverable

Produce a canonical daily research table:

date | XRP price | cohort balance | net cohort change | exchange inflow | exchange outflow | whale accumulation | whale distribution | >=1M XRP volume | active wallets | evidence coverage

Before historical expansion, reproduce at least one archived ShadowWatch period from the independent research path and reconcile transaction hashes, counts, amounts, and coverage.

## Data policy

Use already-banked canonical ShadowWatch evidence first. Crawl XRPL history only for missing periods. Historical crawling must be resumable and independently checkpointed.

Price data must use a documented provider and a single timestamp convention. The exploratory Jan-Sep baseline prepared separately is not yet the statistical source of record because it mixes daily observations rather than one exact time-of-day series.

## Later phases

Only after Phase 1 reconciliation:
- expand toward January 2026;
- compute price-band accumulation/distribution behavior;
- measure excursions and return times;
- perform blind regime search and control-band comparisons;
- add regime-break monitoring.

No prediction output until the historical dataset and controls pass their gates.
