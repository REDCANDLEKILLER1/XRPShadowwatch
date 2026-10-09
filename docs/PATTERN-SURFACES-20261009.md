# Pattern surfaces and optional lookups — October 9, 2026

LIVE, MAP and GRAPH share one bounded `/api/forensic-report` read on page load,
on return to the page, on manual refresh, and every five minutes while visible.
This is the existing daily forensic analysis, not a continuous classifier.
The observation window and partial-market scope are displayed. Stale/unavailable
summaries remove wallet flags. No XRPL writes, roster additions or trading occur.

The sealed summary retains its v1 schema and accepts historical summaries without
wallet detail. New summaries add up to 24 findings, ordered by event count, each
with up to three transaction hashes. `pattern_details_total` discloses truncation.
These are public ledger addresses/hashes only; no credentials, private object
locations, or local notes are included. Existing 16 KiB and validation gates apply.
An older summary explicitly says wallet details await the next forensic analysis.

LIVE badges and MAP/GRAPH rings match full raw wallet addresses, not display
labels. GRAPH's pattern view draws only regular-transfer sender/recipient routes;
repeated quotes or cancellations never create inferred ownership edges. The
existing Trace action remains a separate exploratory read. Filters affect displayed
findings, not the live acquisition or canonical evidence. Transaction links open
the supporting public ledger records.

Targeted news queries now use the same-origin allowlisted proxy and the existing
RSS parser. GDELT errors or empty results fall through to a labeled Google News
query within the same 10-second lane deadline. GDELT suppression skips GDELT only,
not all targeted news. Results and source limitations attach to the in-flight
report pack. Late headers/bodies cannot mutate a sealed report or the cache.
The broader news lane retains its independent RSS feeds and source health status;
external outages are not converted into successful coverage.

Escrow history reuses already verified report-window transactions for watched
registry wallets instead of requesting their `account_tx` again. Optional reads
for other registry wallets stay anchored and bounded by the existing enrichment
budget. A quota failure stops further futile reads. Successful pages, stored
wallet coverage, and unavailable wallets are counted separately. Cached history
is trimmed to 30 days; future rows are rejected. One page is explicitly a sample,
not a complete history. The isolated current-position sweep remains separate.
`escrow_history_coverage` is included in the report pack and canonical diagnostics.

Validation: dedicated browser surface tests (including CI WebKit), sealed summary
references, real RSS parsing and failure fallback, escrow source/coverage tests,
existing deadline and report suites, and the repository regression gate.
# Morning report loading correction

The October 9 morning report exposed a boot race: an unrelated market-price
timeout discarded an already completed forensic summary. The report now captures
that result independently within the existing 15-second boot ceiling. The shared
analysis request allows 12 seconds, and timeout/network/HTTP outcomes are recorded
without including upstream error text. Results arriving after boot cannot change
the report, and each new run starts without the prior result.

New reports identify the section as **XRP/RLUSD market activity watch**. Unavailable
analysis explicitly differs from zero trading; previously sealed text stays intact.
The full RUN regression combines a seven-second analysis response with a stalled
price fill, then checks an unavailable rerun does not inherit earlier figures.

Validation: all 71 local regression suites pass. Serving the previous core
against the same slow-price fixture fails with `UNAVAILABLE` instead of
`AVAILABLE`; the corrected core preserves the XRP/RLUSD figures. The canonical,
shortened, Lady K display, clipboard, and download checks also pass.
