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
