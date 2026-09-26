-- A retried import must identify the same conversion, not silently overwrite
-- data because a newer application maps the same source differently.
ALTER TABLE migration_batches ADD COLUMN plan_sha256 text
  CHECK (plan_sha256 IS NULL OR plan_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE migration_batches ADD COLUMN imported_counts jsonb
  CHECK (imported_counts IS NULL OR jsonb_typeof(imported_counts) = 'object');
ALTER TABLE migration_batches ADD CONSTRAINT migration_batches_receipt_pair
  CHECK ((plan_sha256 IS NULL) = (imported_counts IS NULL));
