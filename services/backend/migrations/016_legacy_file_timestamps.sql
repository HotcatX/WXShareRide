-- Referenced legacy objects without a ledger have no known file timestamps.
-- Keep the clock defaults for new reservations; imports must explicitly write
-- NULL for unknown historical facts instead of substituting migration time.
ALTER TABLE files
  ALTER COLUMN created_at DROP NOT NULL,
  ALTER COLUMN updated_at DROP NOT NULL,
  ADD CONSTRAINT files_timestamps_required CHECK (
    legacy_readonly OR (created_at IS NOT NULL AND updated_at IS NOT NULL)
  );
