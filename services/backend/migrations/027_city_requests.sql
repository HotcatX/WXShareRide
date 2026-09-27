-- One row is one confirmed request. Totals and distinct requesters are derived
-- from these facts, never incremented independently in another summary table.
CREATE TABLE city_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  city_key text NOT NULL CHECK (city_key ~ '^[A-Za-z0-9_-]{1,80}$'),
  city_label text NOT NULL CHECK (length(btrim(city_label)) BETWEEN 1 AND 200),
  city_aliases text[] NOT NULL DEFAULT '{}' CHECK (cardinality(city_aliases) <= 100 AND array_position(city_aliases, NULL) IS NULL),
  source_page text NOT NULL CHECK (length(btrim(source_page)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX city_requests_city_time ON city_requests(city_key, created_at);
CREATE INDEX city_requests_user_time ON city_requests(user_id, created_at);
