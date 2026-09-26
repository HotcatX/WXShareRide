CREATE TABLE notifications (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  user_id uuid NOT NULL REFERENCES users(id),
  event_id text REFERENCES business_events(id),
  -- Navigation target, deliberately not a FK: legacy cancellations deleted rides.
  ride_id text,
  type text NOT NULL CHECK (length(btrim(type)) > 0),
  title text NOT NULL,
  content text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, user_id)
);
CREATE INDEX notifications_owner_idx ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read = false;
