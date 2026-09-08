# September 4 GRPLD historical replay

This branch exists only to reproduce the exact ShadowWatch runtime that produced successful report `SW-20260904-GRPLD`.

Historical runtime base:

`2e750cd8e6bb236b46294750da4b305c15520ccd`

Observed successful production result from that build:

- 255 watched wallets
- 255/255 transaction-window coverage complete
- 58,765 transaction rows observed in the 24h window
- 73 >=1M XRP transfers
- evidence seal generated at 2026-09-04T04:45:08.303Z

No runtime source, scanner logic, XRPL endpoint selection, concurrency, report code, or watchlist code is changed by this replay branch. This documentation file exists only so GitHub can open an isolated test PR and Vercel can produce a preview without proposing a rollback of current `main`.

Do not merge this test PR into production. Its purpose is A/B diagnosis: run the historical code today and compare XRPL/public-server behavior against the successful September 4 evidence.
