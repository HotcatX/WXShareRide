CREATE TABLE market_listings (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  owner_user_id uuid,
  admin_owner_key text CHECK (admin_owner_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  shared_admin_management boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'sold', 'deleted')),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND NOT (content ? 'images')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, owner_user_id) REFERENCES users(app_id, id),
  CHECK ((owner_user_id IS NOT NULL AND admin_owner_key IS NULL) OR
    (owner_user_id IS NULL AND admin_owner_key IS NOT NULL)),
  CHECK (NOT shared_admin_management OR owner_user_id IS NOT NULL)
);

-- The public query filters active expiry and orders by creation time; these
-- indexes keep both paths scoped to one configured app. Owners can also read
-- their inactive records without making them publicly visible.
CREATE INDEX market_listings_public_created_idx ON market_listings(app_id, status, created_at DESC, id);
CREATE INDEX market_listings_public_expiry_idx ON market_listings(app_id, status, expires_at, id);
CREATE INDEX market_listings_user_idx ON market_listings(app_id, owner_user_id, created_at DESC, id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX market_listings_admin_idx ON market_listings(app_id, admin_owner_key, created_at DESC, id) WHERE admin_owner_key IS NOT NULL;
