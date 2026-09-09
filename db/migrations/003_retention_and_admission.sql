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
