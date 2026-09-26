-- A scheduled closure has no human actor. Other mutations still require one.
ALTER TABLE business_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE business_events ADD CONSTRAINT business_events_system_actor
  CHECK ((action = 'closed' AND actor_id IS NULL) OR (action <> 'closed' AND actor_id IS NOT NULL));

CREATE TABLE ride_completions (
  ride_id text NOT NULL REFERENCES rides(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('driver', 'passenger')),
  -- Old receipts prove the count, but not when it first happened.
  counted_at timestamptz,
  event_id text REFERENCES business_events(id),
  PRIMARY KEY (ride_id, user_id),
  CHECK ((counted_at IS NULL) = (event_id IS NULL))
);
CREATE INDEX ride_completions_user_idx ON ride_completions(user_id, role);

-- Import the verified legacy total explicitly before enabling new closures.
-- Do not derive this total from the surviving rides or personal receipts.
CREATE TABLE public_statistics (
  app_id text PRIMARY KEY CHECK (length(btrim(app_id)) > 0),
  served_count bigint NOT NULL CHECK (served_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
