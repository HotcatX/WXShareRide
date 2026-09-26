-- Verified lower bound of source observation, when supplied by the operator.
-- It is neither the import time nor a claim that a paged export was atomic.
ALTER TABLE migration_batches ADD COLUMN observed_before timestamptz;
