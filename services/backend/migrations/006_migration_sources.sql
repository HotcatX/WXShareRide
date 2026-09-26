-- Missing historical facts stay unknown. New API writes still provide real times.
ALTER TABLE users ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE rides ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE ride_members ALTER COLUMN joined_at DROP NOT NULL;
ALTER TABLE rides ALTER COLUMN city_key DROP NOT NULL;
ALTER TABLE rides ALTER COLUMN seat_capacity DROP NOT NULL;
ALTER TABLE rides ADD CONSTRAINT rides_active_facts_required
  CHECK (status = 'closed' OR (city_key IS NOT NULL AND seat_capacity IS NOT NULL));

-- Private import evidence, never an alternate editable business model or public API.
-- Hashes refer to the exact serialized JSON kept here, not original export-file bytes.
CREATE TABLE migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, source_sha256)
);
CREATE TABLE migration_sources (
  batch_id uuid NOT NULL REFERENCES migration_batches(id),
  collection text NOT NULL CHECK (length(btrim(collection)) > 0),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  document_json text NOT NULL CHECK (json_typeof(document_json::json) = 'object'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (sha256 = encode(sha256(convert_to(document_json, 'UTF8')), 'hex')),
  PRIMARY KEY (batch_id, collection, source_id)
);
