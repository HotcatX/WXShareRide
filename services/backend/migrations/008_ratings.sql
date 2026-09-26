CREATE TABLE ride_ratings (
  -- Source IDs are text too: importing old ratings must not invent new identities.
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  ride_id text NOT NULL REFERENCES rides(id),
  rater_id uuid NOT NULL REFERENCES users(id),
  target_id uuid NOT NULL REFERENCES users(id),
  rater_role text NOT NULL CHECK (rater_role IN ('driver', 'passenger')),
  target_role text NOT NULL CHECK (target_role IN ('driver', 'passenger')),
  score integer NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_id text REFERENCES business_events(id),
  UNIQUE (ride_id, rater_id, target_id),
  CHECK (rater_id <> target_id),
  CHECK (rater_role <> target_role)
);
CREATE INDEX ride_ratings_target_role_idx ON ride_ratings(target_id, target_role);
