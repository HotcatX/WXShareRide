-- One daily counted-view bucket, not one individual impression. Deleted
-- listing IDs and unknown historical actors remain facts without new accounts.
CREATE TABLE market_views (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  listing_id text NOT NULL CHECK (listing_id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  actor_user_id uuid,
  day date NOT NULL CHECK (day >= DATE '0001-01-01' AND day <= DATE '9999-12-31'),
  count bigint NOT NULL CHECK (count BETWEEN 1 AND 9007199254740991),
  created_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, actor_user_id) REFERENCES users(app_id, id),
  CHECK (created_at IS NULL OR updated_at IS NULL OR updated_at >= created_at)
);
CREATE INDEX market_views_listing_idx ON market_views(app_id, listing_id);
CREATE UNIQUE INDEX market_views_known_actor_day_idx
  ON market_views(app_id, listing_id, actor_user_id, day) WHERE actor_user_id IS NOT NULL;
