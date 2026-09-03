# Shadow Watch evidence database — architecture

**Status:** foundation. This PR adds the schema, the migration, and the
decision logic. Nothing is wired to a live database yet, and the existing
Report is untouched and keeps working exactly as it does today.

---

## 1. The problem, in numbers

A cold Report takes 15–20 minutes. Two things cause that, and both are
deliberate:

| Where | What it does |
|---|---|
| `17-report-scan-tuning-20260816.js:332` | writes `'{}'` into `shadowwatch_snapshot_v30`, so every wallet looks like a first scan and all 251 enter Phase 2 |
| `02-core.js:1067` | every `account_tx` goes out with `ledger_index_min: -1`, so the window boundary is found **by reading past it** |

Neither is a bug. Together they are what *buys* the claim the Report makes on
air — **"251/251 proved the transaction window"** — and that claim is worth
paying for. A wallet whose XRP balance is unchanged has *not* been shown to be
quiet: `balanceChanged` (`02-core.js:1150`) reads **XRP only**, so IOU and
RLUSD movement, `OfferCreate`, `TrustSet` and signer changes all net to zero.
The 22 `next_hop_splitter` wallets hold nothing by definition — they receive
and forward, so start and end balance can match while millions pass through.
They are the exact class the watchlist exists to catch.

So the answer is **not** to check fewer wallets. It is to stop re-reading
history we have already read.

Measured volume: **153,826 rows in one 72-hour window.** A week approaches a
million. Within months, millions.

---

## 2. What goes in git, and what does not

```
GITHUB                                  NEON POSTGRES
code                                    transactions
schema + migrations                     transaction_accounts
small reference data                    wallet_coverage
  (labels, config, bootstrap display)   coverage_advances
                                        scan_runs
```

Three reasons the evidence is not in the repository, in increasing order of
importance:

1. **Size.** A million rows a week is not a repository. There is no query
   planner, no index, and a 100 MB per-file ceiling.
2. **Concurrency.** Every Report run would produce a merge conflict against
   every other run.
3. **Truth.** This is the one that actually settles it:

> **No value committed to this repository may ever advance a forensic coverage
> floor.**

That is not a style preference. It was a real defect — **SW-20260813-WS4WU**.
A cursor committed to git becomes a floor that outranks the ledger under a
`max` merge (`02-core.js:2939-2952`), so a wallet claims coverage it never
proved and the Report says so on air. Coverage lives in exactly one place: the
server.

Repository data stays useful for labels, configuration and bootstrap display.
It is never authority for what was proven.

---

## 3. Three facts that must never be conflated

```
WHAT HAPPENED            transaction evidence     transactions
                                                  transaction_accounts

WHAT WE HAVE PROVEN      wallet ledger coverage   wallet_coverage
                                                  coverage_advances

WHAT THE REPORT MAY      one window, proven       scan_runs
CLAIM                    end to end               + the canonical model
```

Keeping them separate is the whole trick. It is what lets the scan get faster
without the Report getting looser.

---

## 4. A morning, before and after

**Today**

```
251 wallets × walk history backwards until a transaction predates the window
            ≈ 15–20 minutes
```

**With the index**

```
fetch ONE validated-ledger anchor                       1 request
for each of 251 wallets:
    proven through ledger X?  →  query [X+1 .. anchor]   1 page, usually empty
    never scanned?            →  full date-bounded walk  (first run only)
```

A quiet wallet costs one page that comes back **empty** — and an exhausted
empty range **proves** nothing happened. That is a *stronger* statement than
skipping the wallet because its balance looked unchanged. A busy wallet pays
only for its edge.

Nothing is skipped. **The index narrows the range; it never drops a wallet.**

---

## 5. Coverage: proof and evidence are different columns

A checkpoint records proven **coverage**, not the last transaction seen. A
quiet wallet may have no transactions for thousands of ledgers; having
exhausted `[100,001 … 105,000]` and found nothing, coverage through `105,000`
is proven. Anchoring the checkpoint to the last transaction instead would make
quiet wallets rescan proven-empty history forever — the exact cost this exists
to remove. (`last_observed_tx_ledger` is kept, as a diagnostic only.)

```
scan_coverage_from / _through           what was PROVEN
evidence_retained_from / _through       what is still STORED
last_observed_tx_ledger                diagnostic only
```

**A window is servable from the index only when BOTH ranges cover it.**

Retention pruning narrows the evidence range but not the proof range. Without
the split, a pruned window returns zero rows and reads as *"nothing happened"*.
`windowServability()` returns `EVIDENCE_PRUNED` for that case and refuses to
serve it — we fall back to XRPL, or we say the window is incomplete. **Silence
is never rendered as a zero.**

The evidence test is the retained **close time** against the window start, and
nothing else. Whether pruning has moved past the proof's lower bound is
irrelevant: retention prunes the old end, and what matters is only whether the
rows the window needs are still here. A separate check refuses a **hole**
between the retained evidence and the proof edge.

Five outcomes, each named so a log line and a test can say which happened:

| Reason | Meaning | Served? |
|---|---|---|
| `NO_COVERAGE` | never scanned | no — date-bounded walk |
| `PROOF_GAP_AT_START` | window predates proven history | no — date-bounded walk |
| `EVIDENCE_PRUNED` | proven, but the rows are gone | no — date-bounded walk |
| `EDGE_ONLY` | the normal morning | history yes, edge fetched |
| `FULLY_SERVABLE` | a catch-up already passed our anchor | yes, nothing fetched |

`FULLY_SERVABLE` is the "second report takes seconds" case.

### Why close times are stored next to the ledger bounds

The Report's window arrives in **time** (`[startMs, endMs]`); the fetch has to
go out in **ledgers** (an explicit numeric `ledger_index_min` — the entire
point). XRPL has no *"which ledger was closing at this instant"* lookup, and
interpolating one from an average close interval would be **inventing a ledger
value**. So each coverage bound stores the close time of the ledger it names,
and the decision is made against a value that was actually read.

---

## 6. One immutable anchor per Report

Every Report fetches one validated-ledger anchor at scan start and passes it as
an explicit numeric `ledger_index_max` on every request. A concurrent
server-side catch-up may advance the shared index mid-run; the running Report
still queries only `<= its anchor`, so all 251 wallets and every derived metric
describe **one ledger state**.

Today everything uses `-1`, resolved per request. That is why no index can
currently mean *"I scanned up to here"*, and it is a prerequisite for
everything above.

`transactions.ledger_index` is `NOT NULL` for the same reason. The in-memory
row (`02-core.js:1218-1229`) carries **no ledger index at all** — two consumers
already read for one and always get null. A row admitted without it could never
take part in a range proof, and admitting it anyway would let coverage claim
ledgers nobody read.

---

## 7. Rules the schema and the logic enforce

**Advance only on full proof.** `TRUNCATED` and `FAILED` never move a
checkpoint. A safety ceiling is not a proof: `TX_SAFETY_MAX_PAGES`
(`17-…:21`) stopping the walk yields `TRUNCATED`, which must read as *"we do
not know"*, never as *"we looked and it was quiet"*.

**Advance only over a contiguous range.** A gap between the checkpoint and the
proven range would claim coverage of ledgers this run never read. An *overlap*
is fine — re-reading is harmless, skipping is not.

**Never advance past the run's own anchor.** A checkpoint at `anchor + N` would
let tomorrow's run skip ledgers nobody ever read.

**Monotonic, twice.** The application writes with a compare-and-set conditional
on the expected prior value, and a `BEFORE UPDATE` trigger refuses any decrease
or clearing. Two report runs (`index.html:572` iframes the console) and a
server catch-up race each other by design, and a rule that lives only in
application code is a convention, not a guarantee.

**Three separate atomicity rules.**

```
TRANSACTION EVIDENCE   stored incrementally and idempotently by hash
WALLET CHECKPOINT      advances only after THAT wallet's range is proven
REPORT SEAL            only when ALL required coverage satisfies the window
```

A run dying at wallet 120 of 251:

```
1–119    proven through anchor  → checkpoints KEPT
120      failed midway          → checkpoint does NOT move
121–251  not attempted          → unchanged
scan_run = PARTIAL             → Report NOT sealed as complete
```

Partial evidence from the failed wallet may stay in Neon. It is harmless: its
checkpoint did not advance, and the retry deduplicates by hash. Rolling those
119 back would force Shadow Watch to pay for the same work tomorrow, which is
the exact behaviour this project exists to remove.

**One transaction, counted once.** A watched→watched transfer is returned by
*both* wallets' walks and produces **two** `transaction_accounts` rows. Every
report query across watched wallets must collapse to a **distinct hash set**
before summing, or the index inflates volume and transaction count — the
opposite of the problem it was built to solve. The current in-memory scan
dedupes by keeping one sighting and **destroying the second wallet's
provenance**; the `observed_via` role keeps both.

**Failed transactions are stored, not dropped.** `meta.TransactionResult` is
checked only in escrow parsing today (`02-core.js:3201`), so failed `tec*`
transactions count as real movement in `tx_24h_count`, in volume sums and in
cluster scores. Storing the result keeps the evidence complete and lets the
Report filter on read.

**Escrow ownership comes off the ledger node.** On an `EscrowFinish` the
submitting account is whoever triggered the release, not the source of funds.
Conflating them is the defect PR #50 closed — Ripple's scheduled unlock
printing as *"500M XRP moved from a large private holder"*, three mornings
running. When the node cannot be read, `escrow_owner` stays `NULL`. **Flagged,
not identified; nobody gets a badge for free.**

**Roster labels are views, never columns.** Freezing a label forks an identity:
`saveBlackboxSnapshot` persists `sender_label` verbatim
(`02-core.js:19473-19476`) and `detectCoordination` keys pair-scoring on the
frozen value (`:19545`), so a relabelled wallet splits into two coordination
identities across 30 snapshots. Rows stamp a `roster_version`; labels are
recomputed on read.

**The browser may request. It may never assert.** A browser can ask the server
to catch a wallet up. It can never say *"trust me, wallet X is complete through
ledger 105000"*. The server reads XRPL itself, stores the evidence, proves the
range, and advances the checkpoint transactionally.

**Amounts are exact.** XRP is denominated in drops and the 100,000,000,000 XRP
supply is 1e17 drops — beyond the exact range of an IEEE-754 double
(9.007e15). The app's own `drops()` helper returns a float. Evidence may not be
rounded, so drops stay decimal **strings** into `NUMERIC(21,0)` columns, and
issued-currency values (arbitrary precision by protocol) do too.

**No credentials, seeds or signing material are ever stored.** XRPL access is
read-only. `assertNoSecretMaterial()` refuses a row carrying anything that
looks like key material, and the suite asserts no schema column could hold it.

---

## 8. What this PR does NOT do

Stated plainly so nothing here reads as more finished than it is:

- **Nothing reads or writes a live database.** `getExecutor()` returns `null`
  until `DATABASE_URL` is set *and* the driver is installed.
- **No npm dependency is added.** The Neon driver is required lazily inside a
  `try`; its absence reports as "not configured" rather than throwing, so
  `npm ci` and the Vercel build behave exactly as they do today.
- **The scan is unchanged.** `02-core.js` and the layer chain are not touched.
  The Report produces the same output it produced yesterday.
- **No serverless endpoint exists yet.**
- **`ledger_index` is not yet captured** by the scan. That is the next PR and
  is a hard prerequisite: until the in-memory row carries it, there is nothing
  to store.

Follow-ups, smallest first:

1. capture `ledger_index`; fetch one run anchor; recompute the window at scan
   start
2. the serverless read/write endpoint, plus the Neon dependency
3. bound `account_tx` by the un-proven range (`#41` reworked) with
   `covers_start` and the `-1` retention fallback
4. the server-side shared catch-up workflow
5. retention policy, from measured row size

---

## 9. How this is tested with no database

`scripts/db-foundation.test.js` — **146 checks, no database, no browser, no
network**, registered in `scripts/run-tests.js`.

Every decision that governs what the Report may claim is a **pure function**:
facts in, decision out. That is deliberate. The failure mode this project keeps
hitting is a component asserting something it never verified, and the guard is
a test that can actually run — a decision needing a live Postgres to exercise
would be tested by nobody.

Groups: schema/migration parity · ingest (non-lossy, never fabricating) ·
watched→watched dedupe · servability · checkpoint advancement · the connection
boundary.

Two structural guards worth naming:

- **`db/schema.sql` and `db/migrations/*.sql` cannot drift.** The reference
  carries the reasoning; the migration is what runs. The suite compares tables,
  columns, named constraints and indexes between them, with comments stripped
  first — so a column that exists only inside a comment cannot satisfy the
  check. Drift is a build failure, not a surprise in production.
- **Every guard is sabotage-tested.** Reverting it must turn the suite red
  *naming the right defect*. Fifteen were verified for this PR, including:
  serving a pruned window, letting `TRUNCATED` advance, dropping the
  contiguity requirement, attributing an `EscrowFinish` to its submitter,
  reading the partial-payment sentinel instead of `delivered_amount`, coercing
  drops through a JS number, ignoring `covers_window_start` in the seal gate,
  restoring `Number(null) == 0`, and shifting the ripple epoch by a day.

### Four defects the sabotage pass found in this PR's own code

Recorded because each was a live bug in code that already had a green suite,
and three of the four were hidden by a fixture that made the code correct by
construction.

1. **`NULL` is not zero, and it claimed coverage that did not exist.**
   `Number(null)` is `0`, so every unset column of a never-scanned wallet
   normalized to ledger 0. `hasProof()` then answered TRUE, `proven_start`
   compared `0 <= windowStart` and answered TRUE, and `windowServability()`
   returned `EDGE_ONLY` with `served_from_index` for a wallet nothing had ever
   been read for — a coverage claim with no proof behind it, on the surface
   that gets read aloud. Every "no coverage" fixture used a missing row or
   `undefined` fields; a database returns a **row of NULLs**, the one shape
   nothing tested.
2. **Retention would have disabled the index entirely.** The evidence check
   also required `evidence_retained_from <= scan_coverage_from`, contradicting
   the schema's own `evidence_retained_from >= scan_coverage_from` CHECK. Only
   equality satisfied both, so the day retention first pruned anything, every
   window fell back to a full XRPL walk. The report would still have been
   correct — it would just have stopped being fast, invisibly. The fixture hid
   it by pruning to a boundary *after* the window start, where the correct
   time test and the buggy ledger test agree.
3. **`sealable()` failed open.** It tested only for `FAILED` and `TRUNCATED`
   and let everything else fall through to be counted complete, so `RUNNING`,
   a typo, or a future fourth state would have been certified as proven.
4. **A checkpoint could advance with no close times,** producing a row that
   logs as progress in `coverage_advances` while `proven_start` stays
   permanently false and the wallet silently falls back forever.

And one **vacuous check** the pass caught in the suite itself: the absent-tag
test passed whether the guard existed or not, because `Number(undefined)` is
already `NaN`. Only an explicit `null` becomes `0`, and that case is now
asserted — "no destination tag" and "destination tag 0" are different facts,
and 0 is a tag exchanges really use.

---

## 10. Operations

**Environment.** `DATABASE_URL` (provisioned by the Vercel Neon Marketplace
integration), or `POSTGRES_URL`, or `SHADOWWATCH_DATABASE_URL` to override.
Read at call time, never at module load. The connection string carries a
password and is never logged, returned, or included in an error message —
`redactedTarget()` names the host and database only.

**Applying migrations.** In filename order. Each is wrapped in a transaction,
is idempotent (`IF NOT EXISTS` throughout), and records itself in
`schema_migrations`. **Never edit an applied migration** — add the next one.

**Retention** is configurable and not yet chosen. It must keep at least the
maximum report window plus a generous recovery margin. The number comes from
measured row size and cost, not from a guess. Pruning narrows
`evidence_retained_*` and never touches `scan_coverage_*`; a
`transaction_accounts` row is removed with its transaction by
`ON DELETE CASCADE`.
