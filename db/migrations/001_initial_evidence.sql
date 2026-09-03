-- 001_initial_evidence.sql
-- XRPMAN Shadow Watch — initial evidence + coverage schema.
--
-- Apply migrations in filename order. Never edit a migration that has been
-- applied; add the next one instead.
--
-- db/schema.sql is the annotated reference for the model and the reasoning.
-- THIS file is the executable definition. scripts/db-foundation.test.js asserts
-- the two do not drift: every table, column, constraint and index named in one
-- must appear in the other.
--
-- Idempotent: safe to re-run. Creates nothing that already exists.
--
-- Read-only toward XRPL. No credentials, seeds or signing material are stored.

BEGIN;

-- ── transactions ───────────────────────────────────────────────────────────
-- Observed ledger evidence, one row per hash. Amounts are NUMERIC because
-- 1e17 drops (the XRP supply) exceeds the exact range of a double.
-- ledger_index is NOT NULL: without it a row can never take part in a range
-- proof, and admitting it would let coverage claim ledgers nobody read.
CREATE TABLE IF NOT EXISTS transactions (
  hash                TEXT        PRIMARY KEY,
  ledger_index        BIGINT      NOT NULL,
  close_time          TIMESTAMPTZ NOT NULL,
  tx_type             TEXT        NOT NULL,
  tx_result           TEXT        NOT NULL,
  validated           BOOLEAN     NOT NULL DEFAULT FALSE,
  from_account        TEXT,
  to_account          TEXT,
  amount_drops        NUMERIC(21,0),
  amount_value        NUMERIC,
  currency            TEXT        NOT NULL DEFAULT 'XRP',
  issuer              TEXT,
  destination_tag     BIGINT,
  source_tag          BIGINT,
  sig_mode            TEXT,
  signer_count        INTEGER     NOT NULL DEFAULT 0,
  escrow_owner        TEXT,
  escrow_destination  TEXT,
  escrow_amount_drops NUMERIC(21,0),
  fee_drops           NUMERIC(21,0),
  sequence            BIGINT,
  tx_flags            BIGINT,
  transaction_index   INTEGER,
  roster_version      TEXT,
  evidence            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  first_seen_scan_id  TEXT,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transactions_ledger_positive  CHECK (ledger_index > 0),
  CONSTRAINT transactions_drops_nonneg     CHECK (amount_drops IS NULL OR amount_drops >= 0),
  CONSTRAINT transactions_fee_nonneg       CHECK (fee_drops IS NULL OR fee_drops >= 0),
  CONSTRAINT transactions_escrow_nonneg    CHECK (escrow_amount_drops IS NULL OR escrow_amount_drops >= 0),
  CONSTRAINT transactions_amount_exclusive CHECK (
    (currency = 'XRP' AND amount_value IS NULL)
    OR (currency <> 'XRP' AND amount_drops IS NULL)
  ),
  CONSTRAINT transactions_sig_mode CHECK (
    sig_mode IS NULL OR sig_mode IN ('single', 'multisig', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS transactions_close_time_idx ON transactions (close_time);
CREATE INDEX IF NOT EXISTS transactions_ledger_idx     ON transactions (ledger_index);
CREATE INDEX IF NOT EXISTS transactions_escrow_owner_idx
  ON transactions (escrow_owner) WHERE escrow_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_xrp_amount_idx
  ON transactions (close_time, amount_drops)
  WHERE currency = 'XRP' AND tx_result = 'tesSUCCESS';

-- ── transaction_accounts ───────────────────────────────────────────────────
-- Every address a transaction touched, with its role. A watched-to-watched
-- transfer produces TWO rows here (both wallets observed it), so every report
-- query across watched wallets must collapse to a DISTINCT hash set before
-- summing -- otherwise the index inflates volume and transaction count.
CREATE TABLE IF NOT EXISTS transaction_accounts (
  tx_hash  TEXT NOT NULL REFERENCES transactions (hash) ON DELETE CASCADE,
  address  TEXT NOT NULL,
  role     TEXT NOT NULL,
  PRIMARY KEY (tx_hash, address, role),
  CONSTRAINT transaction_accounts_role CHECK (
    role IN ('submitter', 'destination', 'escrow_owner', 'escrow_dest',
             'issuer', 'signer', 'observed_via')
  )
);

CREATE INDEX IF NOT EXISTS transaction_accounts_address_idx ON transaction_accounts (address, tx_hash);
CREATE INDEX IF NOT EXISTS transaction_accounts_role_idx    ON transaction_accounts (role, address);

-- ── wallet_coverage ────────────────────────────────────────────────────────
-- What was PROVEN (scan_coverage_*) kept separate from what is still STORED
-- (evidence_retained_*). A window is servable from the index only when BOTH
-- cover it, so pruning can never make an empty query read as "nothing
-- happened". last_observed_tx_ledger is diagnostic only -- a quiet wallet has
-- none and would never advance if the checkpoint were anchored to it.
CREATE TABLE IF NOT EXISTS wallet_coverage (
  address                      TEXT PRIMARY KEY,
  scan_coverage_from           BIGINT,
  scan_coverage_through        BIGINT,
  scan_coverage_from_close     TIMESTAMPTZ,
  scan_coverage_through_close  TIMESTAMPTZ,
  evidence_retained_from       BIGINT,
  evidence_retained_through    BIGINT,
  evidence_retained_from_close TIMESTAMPTZ,
  last_observed_tx_ledger      BIGINT,
  last_status                  TEXT,
  last_scan_id                 TEXT,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_coverage_range_ordered CHECK (
    scan_coverage_from IS NULL OR scan_coverage_through IS NULL
    OR scan_coverage_through >= scan_coverage_from
  ),
  CONSTRAINT wallet_coverage_evidence_ordered CHECK (
    evidence_retained_from IS NULL OR evidence_retained_through IS NULL
    OR evidence_retained_through >= evidence_retained_from
  ),
  CONSTRAINT wallet_coverage_evidence_within_proof CHECK (
    evidence_retained_from IS NULL OR scan_coverage_from IS NULL
    OR evidence_retained_from >= scan_coverage_from
  ),
  CONSTRAINT wallet_coverage_status CHECK (
    last_status IS NULL OR last_status IN ('COMPLETE', 'TRUNCATED', 'FAILED')
  )
);

-- A checkpoint may never move backwards or be cleared by an UPDATE. The
-- application also uses a compare-and-set, but two report runs and a server
-- catch-up race each other by design, and a rule that lives only in
-- application code is a convention rather than a guarantee.
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

-- ── coverage_advances ──────────────────────────────────────────────────────
-- The audit trail behind every coverage claim. "251/251 proved the transaction
-- window" is read aloud on air; this is how that claim is shown to have been
-- earned. rows_stored = 0 with reason EMPTY_RANGE_EXHAUSTED is a real proof and
-- must stay distinguishable from a range that was never walked.
CREATE TABLE IF NOT EXISTS coverage_advances (
  id             BIGSERIAL   PRIMARY KEY,
  address        TEXT        NOT NULL,
  scan_id        TEXT        NOT NULL,
  from_through   BIGINT,
  to_through     BIGINT      NOT NULL,
  proven_from    BIGINT      NOT NULL,
  proven_through BIGINT      NOT NULL,
  rows_stored    INTEGER     NOT NULL DEFAULT 0,
  reason         TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coverage_advances_forward CHECK (from_through IS NULL OR to_through > from_through),
  CONSTRAINT coverage_advances_range   CHECK (proven_through >= proven_from)
);

CREATE INDEX IF NOT EXISTS coverage_advances_address_idx ON coverage_advances (address, created_at DESC);
CREATE INDEX IF NOT EXISTS coverage_advances_scan_idx    ON coverage_advances (scan_id);

-- ── scan_runs ──────────────────────────────────────────────────────────────
-- One immutable validated-ledger anchor per Report, so all 251 wallets and
-- every derived metric describe ONE ledger state. PARTIAL is not a failure: a
-- run that died at wallet 120 of 251 keeps the checkpoints of the 119 already
-- proven.
CREATE TABLE IF NOT EXISTS scan_runs (
  scan_id           TEXT        PRIMARY KEY,
  anchor_ledger     BIGINT      NOT NULL,
  anchor_close_time TIMESTAMPTZ,
  window_start      TIMESTAMPTZ NOT NULL,
  window_end        TIMESTAMPTZ NOT NULL,
  window_label      TEXT,
  target_wallets    INTEGER     NOT NULL DEFAULT 0,
  complete_wallets  INTEGER     NOT NULL DEFAULT 0,
  failed_wallets    INTEGER     NOT NULL DEFAULT 0,
  truncated_wallets INTEGER     NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'RUNNING',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT scan_runs_anchor_positive CHECK (anchor_ledger > 0),
  CONSTRAINT scan_runs_window_ordered  CHECK (window_end >= window_start),
  CONSTRAINT scan_runs_status CHECK (
    status IN ('RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED')
  )
);

CREATE INDEX IF NOT EXISTS scan_runs_started_idx ON scan_runs (started_at DESC);

-- ── schema_migrations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial_evidence')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
