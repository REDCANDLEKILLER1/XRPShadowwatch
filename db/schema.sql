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

  -- Everything the columns above do not carry: SendMax, Paths, Memos,
  -- Signers, EscrowFinish Owner/OfferSequence, Condition/Fulfillment,
  -- LimitAmount, TakerGets/TakerPays, the raw Amount that delivered_amount
  -- overrode, and AccountRoot balance deltas. A forensic index is read by
  -- classifiers that do not exist yet, so nothing the response carried is
  -- discarded.
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

  last_status                     TEXT,      -- 'COMPLETE' | 'TRUNCATED' | 'FAILED'
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
    last_status IS NULL OR last_status IN ('COMPLETE', 'TRUNCATED', 'FAILED')
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
  proven_from   BIGINT      NOT NULL,    -- the range this run actually walked
  proven_through BIGINT     NOT NULL,
  rows_stored   INTEGER     NOT NULL DEFAULT 0,
  reason        TEXT        NOT NULL,    -- 'RANGE_PROVEN' | 'EMPTY_RANGE_EXHAUSTED'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coverage_advances_forward CHECK (from_through IS NULL OR to_through > from_through),
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
  anchor_close_time  TIMESTAMPTZ,
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
