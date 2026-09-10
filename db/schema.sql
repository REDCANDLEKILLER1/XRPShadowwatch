-- XRPMAN Shadow Watch — evidence database, current schema.
--
-- This file is the reference: what the database looks like when every migration
-- in db/migrations/ has been applied. It is documentation, not the thing that
-- runs. Apply db/migrations/*.sql in filename order; never edit an applied
-- migration.
--
-- Target: Neon Postgres (Vercel Marketplace integration). Server-owned.
--
-- ============================================================================
-- WHAT THIS DATABASE IS FOR
-- ============================================================================
-- A Report currently re-walks all 251 watched wallet histories every morning,
-- because 17-report-scan-tuning-20260816.js:332 blanks the balance snapshot so
-- every wallet enters Phase 2, and every account_tx goes out with
-- `ledger_index_min: -1` (02-core.js:1067) so the window boundary is found by
-- reading past it. That is what buys the on-air claim "251/251 proved the
-- transaction window", and it is also why a cold run takes 15-20 minutes.
--
-- This index makes the claim cheap rather than making it weaker. A wallet
-- proven through ledger X only has to prove [X+1 .. this run's anchor]. A quiet
-- wallet costs one page that comes back empty, and an exhausted empty range
-- PROVES nothing happened -- a stronger statement than skipping the wallet
-- because its XRP balance looked unchanged.
--
-- ============================================================================
-- THREE FACTS THAT MUST NEVER BE CONFLATED
-- ============================================================================
--   WHAT HAPPENED             transaction evidence      transactions
--                                                       transaction_accounts
--   WHAT WE HAVE PROVEN       wallet ledger coverage     wallet_coverage
--   WHAT THE REPORT MAY       a window proven end to     scan_runs
--   CLAIM                     end by the canonical model
--
-- Proof and evidence are separate columns because pruning old rows must never
-- make an empty query read as "zero transactions in the window". A window is
-- servable from the index only when BOTH the proof range and the retained
-- evidence range cover it. Otherwise: fall back to XRPL, or say the window is
-- incomplete. Silence is never rendered as a zero.
--
-- ============================================================================
-- INVARIANTS THIS SCHEMA ENFORCES ITSELF
-- ============================================================================
--   * A transaction with no ledger_index cannot be stored. Without one it can
--     never participate in a range proof, and admitting it would let coverage
--     claim ledgers nobody read.
--   * A coverage checkpoint can never move backwards (trigger below). The
--     application also uses a compare-and-set, but a convention that only lives
--     in application code is not a guarantee -- two report runs and a server
--     catch-up race each other by design.
--   * Retained evidence is always a subset of proven coverage.
--   * The COMPLETE ledger payload is kept for 48 hours in `transaction_raw`
--     (raw_tx / raw_meta, both NOT NULL there), so a classifier that does not
--     exist yet never forces a rescan of anything recent. It lives in its own
--     table rather than as nullable columns here, because a NULL payload could
--     not tell "never stored" from "expired on schedule" -- and after it
--     expires the slim event, its participants and its coverage proof are all
--     still here (migration 005).
--   * A run cannot claim time its own anchor did not cover
--     (window_end <= anchor_close_time), and the anchor's close time is NOT
--     NULL -- half an anchor is not an anchor.
--   * Every coverage advance is recorded in coverage_advances, so a claim that
--     a wallet "proved the window" has an audit row behind it.
--
-- No credentials, seeds, or signing material are ever stored. XRPL access is
-- read-only; this database holds observed ledger evidence only.

-- ============================================================================
-- transactions -- observed ledger evidence, one row per transaction hash
-- ============================================================================
-- Amounts are NUMERIC, never floating point. XRP is denominated in drops and
-- the 100,000,000,000 XRP supply is 1e17 drops, which exceeds the 9.007e15
-- limit of an IEEE-754 double; the app's own `drops()` helper already returns a
-- float. Issued-currency values are arbitrary precision by protocol. Evidence
-- may not be rounded, so both stay exact here.
CREATE TABLE IF NOT EXISTS transactions (
  hash                TEXT        PRIMARY KEY,
  ledger_index        BIGINT      NOT NULL,
  close_time          TIMESTAMPTZ NOT NULL,
  tx_type             TEXT        NOT NULL,

  -- meta.TransactionResult. Stored, never filtered at ingest. Today this is
  -- read only in escrow parsing (02-core.js:3201), so failed tec* transactions
  -- count as real movement in tx_24h_count, in volume sums and in cluster
  -- scores. Keeping it means the evidence stays complete and the report
  -- filters on read.
  tx_result           TEXT        NOT NULL,
  validated           BOOLEAN     NOT NULL DEFAULT FALSE,

  -- The SUBMITTER of the transaction. NOT "the source of funds". On an
  -- EscrowFinish this is whoever triggered the release; conflating the two is
  -- the defect that printed Ripple's scheduled unlock as "500M XRP from a
  -- large private holder" three mornings running.
  from_account        TEXT,
  to_account          TEXT,

  amount_drops        NUMERIC(21,0),   -- XRP only
  amount_value        NUMERIC,         -- issued currency only, arbitrary precision
  currency            TEXT        NOT NULL DEFAULT 'XRP',
  issuer              TEXT,

  destination_tag     BIGINT,
  source_tag          BIGINT,

  sig_mode            TEXT,            -- 'single' | 'multisig' | 'unknown'
  signer_count        INTEGER     NOT NULL DEFAULT 0,

  -- Escrow ownership comes off the ledger node, never off the submitter. NULL
  -- means the node could not be read, which means ownership is UNKNOWN. It is
  -- never guessed. (Flagged, not identified.)
  escrow_owner        TEXT,
  escrow_destination  TEXT,
  escrow_amount_drops NUMERIC(21,0),

  fee_drops           NUMERIC(21,0),
  sequence            BIGINT,
  tx_flags            BIGINT,
  transaction_index   INTEGER,         -- meta.TransactionIndex: order within the ledger

  -- Which roster was current when this row was ingested. Labels,
  -- classifications and categories are NOT columns: they are recomputed on
  -- read. Freezing a label forks an identity -- saveBlackboxSnapshot persists
  -- sender_label verbatim (02-core.js:19473-19476) and detectCoordination keys
  -- pair-scoring on the frozen value (:19545), so a relabelled wallet splits
  -- into two coordination identities across 30 snapshots.
  roster_version      TEXT,

  -- RETIRED BY MIGRATION 005 -- these two columns are dropped there and the
  -- payload now lives in `transaction_raw` with a 48-hour expiry. Declared
  -- here because this file is the migration history in order, and 001 really
  -- did create them. Read the 005 section at the end of this file for why.
  raw_tx              JSONB       NOT NULL,
  raw_meta            JSONB       NOT NULL,
  -- Derived conclusions and compact projections, NOT a second copy of the
  -- payload (delivered-amount override, escrow node count, signer list,
  -- AccountRoot balance deltas).
  evidence            JSONB       NOT NULL DEFAULT '{}'::jsonb,

  first_seen_scan_id  TEXT,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT transactions_ledger_positive  CHECK (ledger_index > 0),
  CONSTRAINT transactions_drops_nonneg     CHECK (amount_drops IS NULL OR amount_drops >= 0),
  CONSTRAINT transactions_fee_nonneg       CHECK (fee_drops IS NULL OR fee_drops >= 0),
  CONSTRAINT transactions_escrow_nonneg    CHECK (escrow_amount_drops IS NULL OR escrow_amount_drops >= 0),
  -- An XRP row has no issued-currency value, and vice versa. Storing both
  -- would let two different amounts describe one transaction.
  CONSTRAINT transactions_amount_exclusive CHECK (
    (currency = 'XRP' AND amount_value IS NULL)
    OR (currency <> 'XRP' AND amount_drops IS NULL)
  ),
  CONSTRAINT transactions_sig_mode CHECK (
    sig_mode IS NULL OR sig_mode IN ('single', 'multisig', 'unknown')
  )
);

-- The report's primary read: everything inside a time window.
CREATE INDEX IF NOT EXISTS transactions_close_time_idx  ON transactions (close_time);
-- Range proofs and edge fetches work in ledger space.
CREATE INDEX IF NOT EXISTS transactions_ledger_idx      ON transactions (ledger_index);
-- Escrow Watch reads by owner; NULL owners are the unattributed ones and are
-- not worth indexing.
CREATE INDEX IF NOT EXISTS transactions_escrow_owner_idx
  ON transactions (escrow_owner) WHERE escrow_owner IS NOT NULL;
-- Large-movement detection over successful XRP transfers only.
CREATE INDEX IF NOT EXISTS transactions_xrp_amount_idx
  ON transactions (close_time, amount_drops)
  WHERE currency = 'XRP' AND tx_result = 'tesSUCCESS';

-- ============================================================================
-- transaction_accounts -- every address a transaction touched, and its role
-- ============================================================================
-- This table exists because of a structural loss in the current scan: when a
-- watched wallet pays another watched wallet, both wallets' account_tx walks
-- return the same transaction, the in-memory scan keeps one, and the second
-- wallet's provenance is destroyed.
--
-- The consequence for every report query: a watched-to-watched transfer
-- produces TWO rows here, so a query across watched wallets must collapse to a
-- DISTINCT hash set before summing anything. Otherwise the index inflates both
-- volume and transaction count -- the opposite of the problem it was built to
-- fix.
--
--   Fixture: A pays B, both watched -> 1 transaction, amount counted once.
CREATE TABLE IF NOT EXISTS transaction_accounts (
  tx_hash  TEXT NOT NULL REFERENCES transactions (hash) ON DELETE CASCADE,
  address  TEXT NOT NULL,
  -- 'submitter' | 'destination' | 'escrow_owner' | 'escrow_dest'
  -- 'issuer' | 'signer' | 'observed_via'
  --
  -- 'observed_via' is the watched wallet whose account_tx walk returned this
  -- transaction. It is provenance, not a property of the transaction.
  role     TEXT NOT NULL,
  PRIMARY KEY (tx_hash, address, role),
  CONSTRAINT transaction_accounts_role CHECK (
    role IN ('submitter', 'destination', 'escrow_owner', 'escrow_dest',
             'issuer', 'signer', 'observed_via')
  )
);

CREATE INDEX IF NOT EXISTS transaction_accounts_address_idx ON transaction_accounts (address, tx_hash);
CREATE INDEX IF NOT EXISTS transaction_accounts_role_idx    ON transaction_accounts (role, address);

-- ============================================================================
-- wallet_coverage -- what we have PROVEN, and what we still HOLD
-- ============================================================================
-- A checkpoint records proven COVERAGE, not the last transaction seen. A quiet
-- wallet may have no transactions for thousands of ledgers; having exhausted
-- [100001 .. 105000] and found nothing, coverage through 105000 is proven.
-- Anchoring to the last transaction instead would make quiet wallets rescan
-- proven-empty history forever -- which is the cost this whole exercise exists
-- to remove.
--
-- The close-time columns are what let a TIME window (the Report's window is
-- [startMs, endMs]) be decided against LEDGER coverage. XRPL has no
-- "which ledger was closing at this instant" lookup, and interpolating one
-- would be inventing a ledger value.
CREATE TABLE IF NOT EXISTS wallet_coverage (
  address                         TEXT PRIMARY KEY,

  -- WHAT WAS PROVEN. Advances only after that wallet's missing range was
  -- walked to exhaustion with status COMPLETE.
  scan_coverage_from              BIGINT,
  scan_coverage_through           BIGINT,
  scan_coverage_from_close        TIMESTAMPTZ,
  scan_coverage_through_close     TIMESTAMPTZ,

  -- WHAT IS STILL STORED. Narrows as retention prunes. Always a subset of the
  -- proven range: proof survives pruning, rows do not.
  evidence_retained_from          BIGINT,
  evidence_retained_through       BIGINT,
  evidence_retained_from_close    TIMESTAMPTZ,

  -- Diagnostic only. Never used to decide servability, and never used as a
  -- checkpoint: a wallet with no transactions has no last-observed ledger and
  -- would never advance.
  last_observed_tx_ledger         BIGINT,

  last_status                     TEXT,      -- 'COMPLETE' | 'TRUNCATED' | 'FAILED' | 'UNPROVEN'
  last_scan_id                    TEXT,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_coverage_range_ordered CHECK (
    scan_coverage_from IS NULL OR scan_coverage_through IS NULL
    OR scan_coverage_through >= scan_coverage_from
  ),
  CONSTRAINT wallet_coverage_evidence_ordered CHECK (
    evidence_retained_from IS NULL OR evidence_retained_through IS NULL
    OR evidence_retained_through >= evidence_retained_from
  ),
  -- Retained evidence may not claim to reach further back than the proof does.
  CONSTRAINT wallet_coverage_evidence_within_proof CHECK (
    evidence_retained_from IS NULL OR scan_coverage_from IS NULL
    OR evidence_retained_from >= scan_coverage_from
  ),
  CONSTRAINT wallet_coverage_status CHECK (
    last_status IS NULL OR last_status IN ('COMPLETE', 'TRUNCATED', 'FAILED', 'UNPROVEN')
  )
);

-- ============================================================================
-- A checkpoint may never move backwards -- enforced here, not just in code
-- ============================================================================
-- The application uses a compare-and-set conditional on the expected prior
-- value. That is necessary and not sufficient: two report runs in two browser
-- tabs (index.html:572 iframes the console) plus a server catch-up race each
-- other by design, and a rule that lives only in application code is a
-- convention. A slower worker finishing late must not drag the shared
-- checkpoint back over ledgers a faster one already proved.
CREATE OR REPLACE FUNCTION wallet_coverage_monotonic()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.scan_coverage_through IS NOT NULL
     AND NEW.scan_coverage_through IS NOT NULL
     AND NEW.scan_coverage_through < OLD.scan_coverage_through THEN
    RAISE EXCEPTION
      'wallet_coverage.scan_coverage_through may not decrease (% -> %) for %',
      OLD.scan_coverage_through, NEW.scan_coverage_through, OLD.address;
  END IF;
  -- Clearing a proven checkpoint is the same violation wearing a different
  -- hat: tomorrow's run would treat the wallet as never scanned, which is
  -- merely wasteful, but any code path that can null it can also be used to
  -- reset a floor. Require an explicit DELETE for that.
  IF OLD.scan_coverage_through IS NOT NULL AND NEW.scan_coverage_through IS NULL THEN
    RAISE EXCEPTION
      'wallet_coverage.scan_coverage_through may not be cleared for % (DELETE the row instead)',
      OLD.address;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_coverage_monotonic_trg ON wallet_coverage;
CREATE TRIGGER wallet_coverage_monotonic_trg
  BEFORE UPDATE ON wallet_coverage
  FOR EACH ROW EXECUTE FUNCTION wallet_coverage_monotonic();

-- ============================================================================
-- coverage_advances -- the audit trail behind every coverage claim
-- ============================================================================
-- "251/251 proved the transaction window" is read aloud live on air. This is
-- the evidence that the claim was earned: which run advanced which wallet, over
-- which ledgers, and how many rows that range actually produced. An advance
-- with rows_stored = 0 is legitimate and important -- an exhausted empty range
-- is a proof -- but it should be visible as such rather than indistinguishable
-- from a range that was never walked.
CREATE TABLE IF NOT EXISTS coverage_advances (
  id            BIGSERIAL   PRIMARY KEY,
  address       TEXT        NOT NULL,
  scan_id       TEXT        NOT NULL,
  from_through  BIGINT,                  -- checkpoint before the advance (NULL = first ever)
  to_through    BIGINT      NOT NULL,    -- checkpoint after
  from_floor    BIGINT,
  to_floor      BIGINT,
  proven_from   BIGINT      NOT NULL,    -- the range this run actually walked
  proven_through BIGINT     NOT NULL,
  rows_stored   INTEGER     NOT NULL DEFAULT 0,
  reason        TEXT        NOT NULL,    -- 'RANGE_PROVEN' | 'EMPTY_RANGE_EXHAUSTED'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coverage_advances_forward CHECK (from_through IS NULL OR to_through > from_through OR
    (to_through = from_through AND from_floor IS NOT NULL AND to_floor IS NOT NULL AND to_floor < from_floor)),
  CONSTRAINT coverage_advances_range   CHECK (proven_through >= proven_from)
);

CREATE INDEX IF NOT EXISTS coverage_advances_address_idx ON coverage_advances (address, created_at DESC);
CREATE INDEX IF NOT EXISTS coverage_advances_scan_idx    ON coverage_advances (scan_id);

-- ============================================================================
-- scan_runs -- one immutable validated-ledger anchor per Report
-- ============================================================================
-- Every Report owns one anchor, fetched once at scan start and passed as an
-- explicit numeric ledger_index_max on every request. A concurrent server
-- catch-up may advance the shared index mid-run; the running Report still
-- queries only `<= its anchor`, so all 251 wallets and every derived metric
-- describe ONE ledger state. Today everything uses -1, resolved per request,
-- which is why no index can mean "I scanned up to here".
--
-- anchor_ledger is NOT NULL and never updated after insert. A run whose anchor
-- moved would be a run whose wallets disagree about what "now" means.
CREATE TABLE IF NOT EXISTS scan_runs (
  scan_id            TEXT        PRIMARY KEY,
  anchor_ledger      BIGINT      NOT NULL,
  anchor_close_time  TIMESTAMPTZ NOT NULL,
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,
  window_label       TEXT,                 -- 'LAST 24H' / 'LAST 72H' / a custom range
  target_wallets     INTEGER     NOT NULL DEFAULT 0,
  complete_wallets   INTEGER     NOT NULL DEFAULT 0,
  failed_wallets     INTEGER     NOT NULL DEFAULT 0,
  truncated_wallets  INTEGER     NOT NULL DEFAULT 0,
  -- PARTIAL is not a failure: a run that died at wallet 120 of 251 keeps the
  -- checkpoints of the 119 already proven. Making it pay for that work again
  -- tomorrow is the exact behaviour this project exists to remove.
  status             TEXT        NOT NULL DEFAULT 'RUNNING',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  CONSTRAINT scan_runs_anchor_positive CHECK (anchor_ledger > 0),
  CONSTRAINT scan_runs_window_ordered  CHECK (window_end >= window_start),
  -- A run may not claim time its own validated-ledger anchor did not
  -- cover. Without this the final seconds of a window can fall after the
  -- anchor closed, so the Report asserts a period no ledger it read was
  -- inside. Cap window_end to anchor_close_time before persisting.
  CONSTRAINT scan_runs_window_within_anchor CHECK (window_end <= anchor_close_time),
  CONSTRAINT scan_runs_status CHECK (
    status IN ('RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED')
  )
);

CREATE INDEX IF NOT EXISTS scan_runs_started_idx ON scan_runs (started_at DESC);

-- ============================================================================
-- schema_migrations -- which migrations have been applied
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
BEGIN;

ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS roster_hash TEXT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS roster_accounts JSONB;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS floor_ledger BIGINT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS floor_close_time TIMESTAMPTZ;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS transport JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS scan_wallets (
  scan_id TEXT NOT NULL REFERENCES scan_runs(scan_id),
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  proof JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scan_id, address)
);

-- One admission clock across function instances. Provider refusals pause all
-- server callers; changing sockets does not erase a provider cooldown.
CREATE TABLE IF NOT EXISTS xrpl_admission (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cooldown_until TIMESTAMPTZ NOT NULL DEFAULT now(),
  gap_ms INTEGER NOT NULL DEFAULT 250,
  last_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO xrpl_admission(id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION wallet_coverage_monotonic()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Proven wallet coverage cannot be deleted or truncated';
  END IF;
  IF NEW.address <> OLD.address THEN
    RAISE EXCEPTION 'Coverage identity is immutable';
  END IF;
  IF OLD.scan_coverage_through IS NOT NULL AND
     (NEW.scan_coverage_through IS NULL OR NEW.scan_coverage_through < OLD.scan_coverage_through) THEN
    RAISE EXCEPTION 'Proven coverage cannot move backwards or be cleared';
  END IF;
  IF OLD.scan_coverage_from IS NOT NULL AND
     (NEW.scan_coverage_from IS NULL OR NEW.scan_coverage_from > OLD.scan_coverage_from) THEN
    RAISE EXCEPTION 'Proven historical floor cannot be discarded';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER wallet_coverage_no_delete BEFORE DELETE ON wallet_coverage
  FOR EACH ROW EXECUTE FUNCTION wallet_coverage_monotonic();
CREATE TRIGGER wallet_coverage_no_truncate BEFORE TRUNCATE ON wallet_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION wallet_coverage_monotonic();

CREATE OR REPLACE FUNCTION scan_anchor_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.anchor_ledger IS DISTINCT FROM OLD.anchor_ledger OR
     NEW.anchor_close_time IS DISTINCT FROM OLD.anchor_close_time OR
     NEW.window_start IS DISTINCT FROM OLD.window_start OR
     NEW.window_end IS DISTINCT FROM OLD.window_end OR
     NEW.roster_hash IS DISTINCT FROM OLD.roster_hash OR
     NEW.roster_accounts IS DISTINCT FROM OLD.roster_accounts THEN
    RAISE EXCEPTION 'Run anchor, window and roster are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER scan_runs_immutable BEFORE UPDATE ON scan_runs
  FOR EACH ROW EXECUTE FUNCTION scan_anchor_immutable();

ALTER TABLE wallet_coverage ADD CONSTRAINT retained_through_within_proof
  CHECK (evidence_retained_through IS NULL OR
         (scan_coverage_through IS NOT NULL AND evidence_retained_through <= scan_coverage_through));

INSERT INTO schema_migrations(version) VALUES ('002_live_evidence');
COMMIT;

BEGIN;
ALTER TABLE xrpl_admission ADD COLUMN IF NOT EXISTS success_streak INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION invalidate_pruned_evidence()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE wallet_coverage SET evidence_retained_from=NULL,evidence_retained_through=NULL,evidence_retained_from_close=NULL;
    RETURN NULL;
  END IF;
  UPDATE wallet_coverage SET evidence_retained_from=NULL,evidence_retained_through=NULL,evidence_retained_from_close=NULL
    WHERE address IN (SELECT address FROM transaction_accounts WHERE tx_hash=OLD.hash AND role='observed_via');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_prune_invalidates BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION invalidate_pruned_evidence();
CREATE TRIGGER transactions_truncate_invalidates BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION invalidate_pruned_evidence();

INSERT INTO schema_migrations(version) VALUES ('003_retention_and_admission');
COMMIT;

BEGIN;

-- ============================================================================
-- 005 — DELTA EVIDENCE: slim events kept, bulky payloads expire at 48h
-- ============================================================================
-- SW-20260910 filled a 512 MB Neon project in two days and every run then died
-- at its first INSERT. The cause was not row COUNT -- a day of ledger activity
-- is a day of ledger activity whether it is fetched cold or as a delta -- it
-- was BYTES PER ROW. raw_tx + raw_meta are kilobytes each; the normalized
-- event is a couple hundred bytes.
--
-- So the payload moves out of `transactions` into its own table with its own
-- expiry. It is NOT made nullable in place: a nullable raw_tx cannot tell
-- "never stored" from "expired on schedule", and the whole schema is built on
-- refusing to conflate absence with proof.
--
-- What this buys, concretely: deleting an expired payload touches only
-- transaction_raw, so invalidate_pruned_evidence() (003) never fires, no
-- wallet's retained range is NULLed, and no wallet goes cold. Slim retention
-- (7 days) still fires it and still needs the in-transaction repair in
-- scripts/db-prune.js.
--
-- OPERATOR NOTE. If the project is already at its size ceiling, run
--   node scripts/db-prune.js --days 2 --apply
-- BEFORE applying this migration. The backfill below writes a copy of the last
-- 48 hours of payloads, and a full database cannot write anything at all.

CREATE TABLE IF NOT EXISTS transaction_raw (
  -- The FK is what makes the two tables one fact. Deleting a slim event takes
  -- its payload with it; deleting a payload leaves the event untouched.
  hash       TEXT PRIMARY KEY REFERENCES transactions(hash) ON DELETE CASCADE,
  raw_tx     JSONB       NOT NULL,
  raw_meta   JSONB       NOT NULL,
  stored_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Policy carried by the row, not by whoever runs the prune. A payload that
  -- outlives this is a retention bug, and the prune reads this column rather
  -- than recomputing a cutoff from an argument.
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT transaction_raw_expiry_forward CHECK (expires_at > stored_at)
);
CREATE INDEX IF NOT EXISTS transaction_raw_expires_at ON transaction_raw(expires_at);

-- Move what is still inside the 48-hour window, then retire the columns.
-- Payloads older than that are already past the policy this migration
-- introduces; they are dropped rather than copied, which is also what keeps
-- the backfill small enough to run on a nearly full project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'transactions' AND column_name = 'raw_tx') THEN
    INSERT INTO transaction_raw(hash, raw_tx, raw_meta, stored_at, expires_at)
      SELECT hash, raw_tx, raw_meta, ingested_at, ingested_at + interval '48 hours'
        FROM transactions
       WHERE ingested_at > now() - interval '48 hours'
      ON CONFLICT (hash) DO NOTHING;
    ALTER TABLE transactions DROP COLUMN raw_tx;
    ALTER TABLE transactions DROP COLUMN raw_meta;
  END IF;
END $$;

-- ============================================================================
-- wallet_state — balance as a CROSS-CHECK, never as a trigger
-- ============================================================================
-- Nothing in this table may be read to decide whether a wallet gets its edge
-- query. Every wallet is walked from last_proven_ledger+1 to the run anchor
-- whether its balance moved or not: a routing wallet can receive five million
-- XRP and send five million XRP inside one day and show a net-zero balance,
-- and that wallet is precisely the one this project exists to catch.
--
-- What the balance is for is the opposite direction. Between two balances
-- pinned to two known ledgers, the XRP delta is an exact identity: it must
-- equal the sum of this account's AccountRoot balance deltas across every
-- transaction in the range. When it does not, evidence is MISSING -- and a
-- wallet with zero rows and an unexplained balance change must never be
-- rendered as "quiet".
CREATE TABLE IF NOT EXISTS wallet_state (
  address                 TEXT PRIMARY KEY,

  -- Pinned observations. A balance with no ledger index cannot be reconciled
  -- against anything, so the two are always written together.
  balance_drops           NUMERIC(21,0),
  balance_ledger          BIGINT,
  previous_balance_drops  NUMERIC(21,0),
  previous_balance_ledger BIGINT,

  -- The delta checkpoint: the ledger this wallet's evidence is proven through.
  -- A mirror of wallet_coverage.scan_coverage_through kept beside the balance
  -- it was observed with, so a reconciliation never has to trust two tables to
  -- agree about which ledger it is talking about.
  last_proven_ledger      BIGINT,
  last_scan_id            TEXT,

  -- The most recent verdict: RECONCILED | CONTRADICTION | NOT_APPLICABLE,
  -- with the arithmetic that produced it.
  reconciliation          JSONB NOT NULL DEFAULT '{}',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_state_balance_nonneg CHECK (balance_drops IS NULL OR balance_drops >= 0),
  CONSTRAINT wallet_state_previous_nonneg CHECK (previous_balance_drops IS NULL OR previous_balance_drops >= 0),
  CONSTRAINT wallet_state_balance_pinned CHECK (
    (balance_drops IS NULL) = (balance_ledger IS NULL)
  ),
  CONSTRAINT wallet_state_previous_pinned CHECK (
    (previous_balance_drops IS NULL) = (previous_balance_ledger IS NULL)
  ),
  CONSTRAINT wallet_state_observation_ordered CHECK (
    previous_balance_ledger IS NULL OR balance_ledger IS NULL
    OR balance_ledger >= previous_balance_ledger
  )
);

CREATE OR REPLACE FUNCTION wallet_state_forward()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.last_proven_ledger IS NOT NULL AND
     (NEW.last_proven_ledger IS NULL OR NEW.last_proven_ledger < OLD.last_proven_ledger) THEN
    RAISE EXCEPTION 'A delta checkpoint cannot move backwards or be cleared';
  END IF;
  IF OLD.balance_ledger IS NOT NULL AND NEW.balance_ledger IS NOT NULL AND
     NEW.balance_ledger < OLD.balance_ledger THEN
    RAISE EXCEPTION 'A balance observation cannot move backwards';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wallet_state_monotonic ON wallet_state;
CREATE TRIGGER wallet_state_monotonic BEFORE UPDATE ON wallet_state
  FOR EACH ROW EXECUTE FUNCTION wallet_state_forward();

-- ============================================================================
-- wallet_routes — the compact intelligence that outlives both prunes
-- ============================================================================
-- Bot and routing patterns are the one thing that genuinely needs a long
-- memory, and they need almost none of the payload to express. One row per
-- (observing wallet, counterparty pair, currency, day) is a few dozen bytes
-- and survives every retention pass, so "this pair moved money on 19 of the
-- last 30 days" stays answerable when neither the payload nor the slim event
-- is still stored.
--
-- Counts here are DERIVED, never evidence. The rollup is written only from
-- hashes the insert actually accepted, so re-running a wallet never inflates
-- it.
CREATE TABLE IF NOT EXISTS wallet_routes (
  observed_via  TEXT NOT NULL,
  from_account  TEXT NOT NULL,
  to_account    TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'XRP',
  day           DATE NOT NULL,
  tx_count      INTEGER NOT NULL DEFAULT 0,
  -- Unconstrained NUMERIC on purpose. A ledger AMOUNT fits NUMERIC(21,0)
  -- because the XRP supply is 1e17 drops; a rolling SUM of amounts has no such
  -- ceiling, and an overflow here would abort a run over a derived statistic.
  total_drops   NUMERIC NOT NULL DEFAULT 0,
  total_value   NUMERIC NOT NULL DEFAULT 0,
  first_ledger  BIGINT NOT NULL,
  last_ledger   BIGINT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (observed_via, from_account, to_account, currency, day),
  CONSTRAINT wallet_routes_count_positive CHECK (tx_count > 0),
  CONSTRAINT wallet_routes_ledgers_ordered CHECK (last_ledger >= first_ledger)
);
CREATE INDEX IF NOT EXISTS wallet_routes_pair_day ON wallet_routes(from_account, to_account, day);

-- Per-run reconciliation verdict, beside the per-run proof it belongs to.
ALTER TABLE scan_wallets ADD COLUMN IF NOT EXISTS reconciliation JSONB NOT NULL DEFAULT '{}';

INSERT INTO schema_migrations(version) VALUES ('005_delta_evidence');
COMMIT;
