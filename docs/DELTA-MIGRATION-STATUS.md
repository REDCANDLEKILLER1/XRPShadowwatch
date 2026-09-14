# Delta evidence migration — what is PROVEN, what is ASSUMED, what is LEFT

Working log for the move off Neon to the GitHub-backed delta acquisition.
Updated as things change. Read this before touching the delta path.

## Why this file exists

Six defects were found in one day, and every one of them was an assumption
checked against itself:

| assumed | actually |
|---|---|
| the lanes spread load because lanes exist | all four walks took lane zero |
| the test proved spreading | the test did the spreading itself (`inFlight++`) |
| `readReportWindow` was wired because it was written | nothing ever called it |
| the report had an id when the scan started | it was minted at the end, so `begin()` threw every run |
| 12 admissions per run was necessary caution | measured: 1.07 requests, 0.39 s per wallet |
| the 28-minute commit was computation | 33 s of CPU; the rest was serial round trips |
| a manifest naming a shard meant the shard was there | 15 of 19 had been deleted by a discard |
| "408/408 proved" and "0/408 proved" came from different runs | same run, same response, two definitions of proved |

Three of those had passing tests over broken code, because the test was written
from the same wrong idea as the mechanism. A green suite is not evidence that a
thing works — it is evidence that it behaves the way its author expected.

So the rule this file enforces: **nothing moves from ASSUMED to PROVEN without
an observation from outside the thing itself** — a live measurement, a file read
back out of the repository, or a test whose fixture does not do the work being
tested.

## PROVEN — observed, not inferred

| what | how it was proven |
|---|---|
| roster is 408 | `roster.select()` parses 408 unique, well-formed addresses |
| checkpoint is current | `evidence/state/latest.json` read from the repo: state v3, 408 wallets, anchor 106968575, all at that anchor |
| evidence is committed | 10 shards in state v3; six days of event files, Sept 9–14, ~218k events, read back out of git |
| balances are pinned | 408 of 408 in the committed state |
| balance identity holds | 265 reconciled, 0 contradictions, on the run that had prior balances to compare |
| admission works | 141 wallets entered on one run; 153 carry `history_from_ledger` |
| resume works | a run died at 266/267; the next adopted the journal and committed |
| lanes spread | live: xrpl.ws 515, s1 213, s2 207, xrplcluster 67 — after the reservation fix |
| endpoint throughput | 6.49 req/s across four lanes (vs 0.32 on one) |
| cold admission cost | 30 sampled: 18 silent, 9 one page, 3 multi-page; 0.39 s each |
| commit CPU cost | 240k rows: build 3.8 s, merge 2.7 s, shard+gzip 26.6 s, base64 0.1 s |
| the runtime needs no database | `xrpl-reader.js` imports no connection module; asserted in the suite |

## FIXED 2026-09-14 — the wedge, diagnosed from the repository

Two phone runs both returned in 18 s, both said `408/408 proved`, and both
rendered nothing: `0/408 wallets proved; 408 failed`. Three defects, chained:

| # | defect | how it was found |
|---|---|---|
| 1 | journal-recovered wallets were projected `RECOVERED`; the report accepted only `COMPLETE` | run log section 09, then both files side by side |
| 2 | an absent manifest was re-established from the run's in-memory copy, resurrecting pointers to shards a discard had deleted | `git show origin/main:evidence/runs/resume/latest.json` — 19 shards named, 4 present |
| 3 | the discard asked to delete those dead paths, so it could not clear the journal it existed to clear | the journal was still on the branch after two runs that both called it |

Chained, they were permanent: the journal could not be read, could not be
discarded, and every run recovered all 408 wallets from it and refused them all.

Fixed, with the shard-presence check moved to ADOPTION time so a dead journal
costs one re-walk instead of a wasted run. And — the half that is about
claiming rather than committing — when journalled rows fail to verify, the
wallets they backed stop being reported as proved at all, so the gauge can no
longer read 408/408 while every wallet behind it is refused. Six sabotage runs,
six caught; the one that reproduces the live symptom returns
`{"accounts":2,"proved":0,"refused":["WALLET_NOT_PROVEN","WALLET_NOT_PROVEN"]}`.

Independently reached the same first two diagnoses in review on PR #75, and
correctly objected that accepting every `RECOVERED` blindly would be unsafe —
which is why the verification-failure path unproves them rather than the client
trusting the label.

## ASSUMED — believed, not yet observed

Everything here is a claim I have NOT earned. Do not repeat any of it as fact.

- **The morning report produces a report.** It has never rendered one on this
  branch. Three causes have been found and fixed — `begin()` throwing, the
  window never assembling, and now the journal wedge. Each fix is proven in the
  suite and none is proven on the preview.
- **The wedged journal clears itself.** The next run should refuse
  `SW-20260914-6KAMF` at adoption, discard it, and walk all 408. That is what
  the tests do against a fake; the live journal is still on the branch.
- **The commit is fast now.** Parallel reads and uploads are in and tested for
  correctness, not for speed. No run has been timed since.
- **The report window assembles against the real store.** Proven against a
  stub. `readReportWindow` has never run against the live evidence repo.
- **Production works.** `main` is 26 commits behind and still on the Neon path.
  Nothing on this branch has run outside the preview.
- **The Production token exists.** `SHADOWWATCH_EVIDENCE_TOKEN` was set for
  Preview. Production is unchecked.
- **`api/evidence.js` is unreachable.** It still imports the Neon connection.
  Layer 45 should have replaced every caller, but that is reasoning, not a
  measurement.

## LEFT TO DO, in order

1. **Run the report on the preview.** Cheapest thing that converts the biggest
   assumption. Expect it to find something; that is the point of doing it
   before merging rather than after. The first run after this one also has to
   clear the wedged journal — watch for `resume journal refused
   (JOURNAL_SHARDS_MISSING)` followed by a full 408-wallet walk.
2. **Still open, raised in review and not fixed here:** single-flight so a
   retried POST cannot overlap a running invocation; the integrity probe scoped
   per attempt rather than treating the previous attempt's rows as this one's
   peak; TOTAL_DEBUG scoped to one attempt; the proof-lock modal showing the
   real cause; and the exported report id still reading `unknown`.
3. **Check `SHADOWWATCH_EVIDENCE_TOKEN` in the Production environment.**
4. **Time a commit** with the parallel path, on a normal daily delta. The run
   now reports `journal-loaded`, `merged`, `shards-built`, `committed`, each
   with its own duration — read them rather than guessing.
5. **Merge PR #75** — operator decision, not to be taken without it.
6. **Decide what happens to `api/evidence.js`** and the Neon imports behind it.

## Standing constraints (operator, unchanged)

- XRPL stays READ-ONLY. No signing, seeds, submit, trading, payouts, sending.
- Auto-promotion stays off.
- Do not merge to `main` without explicit approval.
- Do not reduce the roster, the window, or forensic correctness to fit a limit.
- Never skip, disable or quarantine a test to get green.
  `scripts/smoke-baseline.txt` is not regenerated.
- The checkpoint advances only on a whole, uncontradicted run.

## How to check a claim in this file

- Checkpoint: `git -C <evidence repo> show origin/main:evidence/state/latest.json`
- Committed days: `git -C <evidence repo> ls-tree -r --name-only origin/main | grep evidence/20`
- Suites: `node scripts/run-tests.js`
- A guard you doubt: revert it and confirm the suite fails naming that defect.
  Several guards here were unverified until exactly that was done to them.
