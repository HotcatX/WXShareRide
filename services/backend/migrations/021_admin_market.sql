-- Permanent row receipts also retain legacy web hashes. A canonical payload
-- cannot be compared with the old web payload format.
ALTER TABLE admin_requests ADD COLUMN payload_format text NOT NULL DEFAULT 'canonical-v1'
  CHECK (payload_format IN ('canonical-v1', 'legacy-web-v1'));

CREATE TABLE market_import_batches (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  owner_key text NOT NULL CHECK (owner_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload_format text NOT NULL CHECK (payload_format IN ('canonical-v1', 'legacy-web-v1')),
  total integer NOT NULL CHECK (total BETWEEN 1 AND 50),
  status text NOT NULL CHECK (status IN ('running', 'partial', 'failed', 'done')),
  results jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(results) = 'array'),
  failures jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(failures) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz,
  PRIMARY KEY (app_id, owner_key, id),
  CHECK (updated_at IS NULL OR updated_at >= created_at),
  CHECK (
    (status = 'running' AND jsonb_array_length(results) = 0 AND jsonb_array_length(failures) = 0) OR
    (status = 'done' AND jsonb_array_length(results) = total AND jsonb_array_length(failures) = 0) OR
    (status = 'failed' AND jsonb_array_length(results) = 0 AND jsonb_array_length(failures) = total) OR
    (status = 'partial' AND jsonb_array_length(results) BETWEEN 1 AND total - 1
      AND jsonb_array_length(results) + jsonb_array_length(failures) = total)
  )
);
-- Result IDs intentionally have no listing FK: deletion cannot erase a
-- successful publishing receipt or make a historical batch re-create an item.
