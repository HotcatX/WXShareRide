-- Shared administrator draft library. Creator fields are provenance, not an
-- owner ACL; pictures and listing identities are not part of template data.
CREATE TABLE market_templates (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name=btrim(name) AND name !~ '[[:cntrl:]]'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  status text NOT NULL CHECK (status IN ('active','deleted')),
  created_by_admin_id text,
  updated_by_admin_id text,
  created_at timestamptz DEFAULT clock_timestamp(),
  updated_at timestamptz DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id,id),
  FOREIGN KEY (app_id,created_by_admin_id) REFERENCES admin_accounts(app_id,id),
  FOREIGN KEY (app_id,updated_by_admin_id) REFERENCES admin_accounts(app_id,id),
  CHECK (created_at IS NULL OR isfinite(created_at)),
  CHECK (updated_at IS NULL OR isfinite(updated_at)),
  CHECK (created_at IS NULL OR updated_at IS NULL OR updated_at>=created_at),
  CHECK (data - ARRAY['listingType','title','description','priceCents','category','condition','region','buildingName',
    'location','startDate','endDate','sellerContact','sublet']::text[] = '{}'::jsonb),
  CHECK (COALESCE(jsonb_typeof(data->'listingType')='string' AND data->>'listingType' IN ('goods','sublet')
    AND jsonb_typeof(data->'priceCents')='number' AND (data->>'priceCents')::numeric BETWEEN 0 AND 10000000000
    AND (data->>'priceCents')::numeric=trunc((data->>'priceCents')::numeric)
    AND jsonb_typeof(data->'region')='object' AND jsonb_typeof(data->'sellerContact')='object',false))
);
CREATE INDEX market_templates_active_idx ON market_templates(app_id,status,updated_at DESC,id);
