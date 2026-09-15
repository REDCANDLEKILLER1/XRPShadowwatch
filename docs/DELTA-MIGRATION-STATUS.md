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
| **the morning report produces a report** | SW-20260914-FSO32: state v4 in the repo, 408/408, 140,821 transactions rendered |
| the fix clears the REAL wedged journal | the live `SW-20260914-6KAMF` manifest and the real branch listing, run through the shipped `ownedPaths`/intersection logic: 15 of 19 shards missing → adoption REFUSED, discard removes 5 including the manifest, skips 15 dead, leaves nothing behind |

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

A second review of that fix found the branch it missed, and was right again:
the journal's rows are hash-checked when they are READ BACK, and that read
happens once, at the commit. `RUN_INCOMPLETE` and `RUN_CONTRADICTED` return
before it. A resumed run with 407 recovered wallets and one failure therefore
returned 407 as proven having never verified their bytes this run — and `rows`
carries only what this attempt walked, so the window could not contain their
transactions either. Proven and absent from the window: two claims that cannot
both hold.

Now every path that returns before verification withholds the claim, and the
client fails closed on the legacy shape — a missing `proven` field falls back to
the status string only for `COMPLETE`, never for `RECOVERED`, because that is
exactly the shape the incident arrived in.

## THE REPORT RAN — 2026-09-14, SW-20260914-FSO32

The biggest assumption in this file is now observed. A full morning report
rendered: 408 wallets, 140,821 transactions across 72h, escrow verified 20/20,
news lane populated, verdict scored. Read back out of the evidence repository,
not taken from the report text:

    state_version  3 -> 4          the checkpoint ADVANCED
    anchor_ledger  106982842       close 2026-09-14T15:43:40Z
    wallets        408, all 408 at that anchor
    sealed_run     SW-20260914-FSO32  408/408

The wedge cleared itself exactly as designed, and the re-establish fix earned
itself inside this very run. The commit order shows it:

    segment 4  — 34 wallets    <- a second attempt, still alive server-side
    segment 1  — 22 wallets
    evidence: SW-20260914-FSO32 — state v4 — 408/408
    segment 19 — 402 wallets   <- the attempt that committed

The commit deleted the journal; an attempt still running found no manifest and
re-established a FRESH one (segment 1), rather than resurrecting pointers to
the shards the commit had just removed. Before the fix that second path is what
re-created the wedge. The leftover journal is refused on two independent counts
next run — CHECKPOINT_MOVED_SINCE and ANCHOR_NO_LONGER_AHEAD — and discarded.

It cost three attempts and 9m21s, of which 463 seconds was the evidence walk
with no feedback at all:

    15:43:27  start
    15:48:17  attempt 1 cut at 290s — the client's own flat timeout
    15:50:02  attempt 2 cut — phone backgrounded
    15:51:10  attempt 3: 408/408, 41,782 transactions, checkpoint advanced

Operator's reading: "took forever and looked like nothing happened." Correct,
and the cause was not slowness — it was that the run said nothing while it
worked. Fixed: the report path now streams, the gauges carry an EVIDENCE phase,
and the abort fires on silence rather than on duration.

And the gauge only ever moves forward. The server numbers each wallet by
everything proven so far, journal recoveries included, so its own count climbs
across attempts — but the first version of the client published `done: 0` on
every retry's `start` line, and the five-second ticks report zero until that
attempt's first wallet lands. On this run that would have been a bar falling
for a minute, three times, at exactly the moments work was being RECOVERED.
Caught by reviewing the change rather than by running it.

## The archive could not accept the run that worked

`SW-20260914-FSO32` sealed, rendered and committed — and archived nothing:

    GitHub archive: FAILED
    error: INVALID_EVIDENCE_SCAN_ID

`github-archive.js` required `idx-<uuid>`, a Neon acquisition id, and called
Neon's `archiveFacts` to build the receipt. Every report since the delta
migration identifies its run as `gh-<anchor>`, so every one of them failed the
same way. Found in review of the live run, confirmed on both lines of source.

Both identities are now accepted — separately and exactly, neither loosened to
admit the other — and a `gh-` run derives its receipt from the committed
checkpoint, which `readState()` hash-verifies on the way in. The caller still
supplies nothing but its report text and seal hashes.

Two guards came with it: the state must NAME the report being archived, or a
report could borrow another run's coverage for its receipt; and a run id that
is not the anchor that report sealed is refused outright.

The first version of that read `state/latest.json` — the MOVING pointer — which
made a committed report unarchivable the moment the next one advanced it. That
is not theoretical: archive-retry is an operator action taken later, and
single-flight is still open so two runs can overlap. It now reads the run's own
immutable manifest at `evidence/runs/<report_id>.json`, takes the state version
and hash from there, and checks the `state/history/<version>.json` copy against
that hash before using a single fact from it. Nothing consults latest.json, so
yesterday's report archives exactly as well as this morning's.

It also nulled the scan id. A GitHub-backed run carries `scan_id: null` — the
public `SC-` id is repaired in the browser after acquisition — and the facts
were spread OVER the validated one, writing that null into the receipt and the
day index.

One review suggestion was declined. It asked that an incomplete run be refused;
the archive deliberately preserves an honestly-sealed incomplete run with
`coverage_complete: false` written into the receipt, and refusing would delete
the record of a morning that did not finish. What may be CLAIMED is the seal's
business. A run that never committed is a different matter, and the report-id
check is what catches that.

## The report claimed twice the supply of XRP — 2026-09-15

`SW-20260915-IWBGW` printed **216.41B XRP moved**. Total XRP supply is ~100B.

Read out of the committed evidence, not out of the report: all **216** of the
237 "large transfers" whose sender equals their receiver are `tecPATH_DRY` —
every one FAILED. Each carries `amount_drops` 1000000000000000, which is a
partial payment's CEILING of 1B XRP, and a balance delta of **10 drops**: the
fee. They contributed 216,000,000,000 of the 216,270,288,189 headline — 99.88%.

The true figure for that window is ~270M XRP, the order of magnitude the
pre-migration path reported (236.05M on 2026-09-08).

| | 2026-09-08 (Neon) | 2026-09-15 (delta) |
|---|---|---|
| transactions | 36,494 | 37,425 |
| XRP moved | 236.05M | **216.41B** |
| wallets active | 111 | **4** |

`tx_result` was carried by layer 45 and **dropped by layer 17's mapping**, so
nothing downstream could tell a payment from a rejection. The store was right
to keep failed transactions — "a wallet tried to move a billion and could not"
is a fact worth holding — but the report may not count them as movement.

Measured on the 2026-09-12 shard: 110 failed transactions out of 52,017 carry
23,000,031,350 of the "moved" total against 112,462,205 that actually moved.
Successful partial payments are immaterial: 33 XRP in total.

**Still open from the same run:** `unattributed: 37,420 of 37,425`. Almost no
event in the window carries an observer, which is what makes "wallets active"
read 4 instead of 111. The server reports that number precisely so it can be
noticed, and nothing was reading it. Not yet diagnosed.

## The two Auto Discovery candidates, checked against the evidence

Read out of 255,914 unique transactions across the seven committed days, rather
than out of the candidates' own scores:

| | `rBXAyX…hueQ` (175/200) | `rMVuea…GnSL` (160/200) |
|---|---|---|
| transactions, ever | 2 | 2 |
| the ≥1M receipt | 1,128,785.95 XRP, 09-14, tesSUCCESS | 1,261,100.00 XRP, 09-14, tesSUCCESS |
| other activity | **OUT 1,719,200 XRP on 09-13** | IN 73,100 XRP on 09-10 |
| outbound since | — | none |

Both receipts are real, succeeded, and match the exported amounts exactly. That
part of the evidence holds.

What does NOT hold as stated: both are scored partly on "Recurring across 3
scans", and each has **one** qualifying event in the whole committed history.
Three scans saw the same transaction — it is a repeated OBSERVATION, not
repeated behaviour, which is the distinction that decides whether a wallet has
earned a place on the roster.

And `rBXAyX…hueQ` is labelled RECEIVER_STILL_HOLDING_SIZE while having sent
1.72M XRP out the day before it received 1.13M. It is holding that particular
receipt; it is not a passive accumulator.

`rMVuea…GnSL` has no outbound transaction at all and is holding in the plain
sense.

Neither is an argument for adding them. Both are an argument for watching what
they do next, which is what the review queue is for.

**Fixed:** recurrence is now earned from DISTINCT QUALIFYING TRANSACTIONS, not
from a scan counter. `seen_count >= 3` was worth **+35** of a 175/200 score, and
both candidates collected it on one transaction re-observed three times. A
candidate now records the hashes behind it and the credit is gated on that set;
where scans outnumber transactions the reason line says so in as many words
rather than going quiet:

    Seen in 3 scans, but on 1 distinct transaction — scan persistence,
    not repeated behaviour

Candidates stored before hashes were tracked have none recorded and get no
recurrence credit. They never earned it on distinct events, and grandfathering
it would keep the old claim alive under a new name.

## Each commit overwrites a day's provenance — FIXED, merge-on-write

`readReportWindow` reported `unattributed: 37,420 of 37,425` on
SW-20260915-IWBGW, and the report printed **4 wallets active** where the
pre-migration path printed 111. The join is not broken; it is starved.

`buildShards()` builds a day's files from THIS RUN's rows and `commitRun`
writes them by path, replacing whatever that day already held. Events survive
by accident — a big day spills into `events.001`/`.002`, and a small run that
produces one shard never overwrites the numbered ones. Participants fit in a
single file, so a later run destroys the earlier provenance outright.

From the repository's own history of `evidence/2026/09/14/participants.ndjson.gz`:

    8128749   3,858 rows
    8d927be 138,518 rows      the backfill
    ec0fa6a 102,873 rows
    8ed28e7      17 rows      a small run, and 102,856 rows of provenance gone

Provenance is the link between a transaction and the watched wallet whose walk
saw it. Without it the report cannot attribute movement to any wallet, which is
what every "X absorbed N XRP" line depends on.

A commit now MERGES a day's existing shards rather than replacing them, deduped
on the identity each record type already carries — an event by hash, a
provenance row by (hash, address, role), a payload by hash. Only the days this
run's rows land in are read and rewritten; a reporting window that merely READS
other days does not touch them.

**Measured against the budget, which is what decided it.** On the live
2026-09-14 shape — 41,983 events and 138,518 provenance rows:

| | |
|---|---|
| reading the day back | ~6 s (the window read already pays this, timed live) |
| merge + reshard + gzip | 608 ms |
| ending reserve available | 90 s |

Comfortably inside, so the architecture is settled and immutable per-run shards
are not needed.

One guard was deliberately narrowed: "acquisition itself never loads a stored
shard" now reads "the WALK never loads a stored shard", asserted on the source
before the gate. The principle it protected — the walk is bounded by the
checkpoint, never by the archive's size — is unchanged. The old wording also
forbade the commit reading the day it is about to write, which would have made
this fix untestable rather than catching anything.

**Repair, under an explicit constraint.** `reconstructProvenance()` rebuilds a
provenance row only where a surviving event itself proves a watched wallet was
sender or receiver. Everything it writes is `derived_via`, never
`observed_via` — a separate ROLE rather than a flag, because a flag can be
dropped by any consumer that does not know to look for it, and a reconstructed
row reading as an observation is precisely the false certainty this repair
exists to avoid.

| | |
|---|---|
| derivable | the event names a watched wallet as sender or receiver |
| not derivable | a walk that saw a transaction without being a party to it — gone, and left unattributed |
| never | an observer invented for a transaction that proves none |

A repaired day is marked `PARTIAL_RECONSTRUCTED` and never `COMPLETE`. The
window counts `attributed_derived_only` separately from observed attribution and
carries a `provenance` status through to the browser, where the run log says it
in as many words:

    Evidence: PROVENANCE PARTIALLY RECONSTRUCTED — 2 of 3 events are attributed
    from the surviving transaction rather than from a recorded walk. Wallet
    attribution in this report is weaker than usual.

A fully observed window is not labelled partial, so the warning means something
when it appears. Nothing already committed is altered: reconstruction ADDS
rows.

## ASSUMED — believed, not yet observed

Everything here is a claim I have NOT earned. Do not repeat any of it as fact.

- **The streaming report path works live.** Proven in a real browser against a
  fake server that uses the real done-line builder; never run against the
  preview. This is the change most likely to need another round.
- **The 90-second ending reserve is enough.** A tuning figure from one measured
  overrun, not a measurement of the ending itself.
- **The wedged journal clears itself ON THE PREVIEW.** The decision is now
  proven against the real manifest and the real branch listing (see PROVEN),
  so what is left unobserved is narrow: that the GitHub call behind it
  succeeds. The deletion set contains only paths that exist, so there is no
  dead path left for it to trip on — but that is reasoning, not a run.
- **The commit is fast now.** Parallel reads and uploads are in and tested for
  correctness, not for speed. No run has been timed since.
- **The report window assembles against the real store.** Proven against a
  stub. `readReportWindow` has never run against the live evidence repo.
- **Production works.** `main` is 26 commits behind and still on the Neon path.
  Nothing on this branch has run outside the preview.
- **The Production token exists.** `SHADOWWATCH_EVIDENCE_TOKEN` was set for
  Preview. Production is unchecked. Note the archive now needs it too: a `gh-`
  receipt reads the evidence checkpoint to build its facts.
- **A receipt actually lands.** The archive path is proven against a fake
  GitHub using the real facts derivation; no `gh-` receipt has been written to
  the real archive branch yet.
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
