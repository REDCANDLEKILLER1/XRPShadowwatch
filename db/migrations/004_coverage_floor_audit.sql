BEGIN;
ALTER TABLE coverage_advances ADD COLUMN IF NOT EXISTS from_floor BIGINT;
ALTER TABLE coverage_advances ADD COLUMN IF NOT EXISTS to_floor BIGINT;
ALTER TABLE coverage_advances DROP CONSTRAINT coverage_advances_forward;
ALTER TABLE coverage_advances ADD CONSTRAINT coverage_advances_forward CHECK (
  from_through IS NULL OR to_through > from_through OR
  (to_through = from_through AND from_floor IS NOT NULL AND to_floor IS NOT NULL AND to_floor < from_floor)
);
INSERT INTO schema_migrations(version) VALUES('004_coverage_floor_audit');
COMMIT;
