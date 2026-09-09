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
