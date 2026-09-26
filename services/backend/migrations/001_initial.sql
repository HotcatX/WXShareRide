CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  openid text NOT NULL CHECK (length(btrim(openid)) > 0),
  name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, openid)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE rides (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  kind text NOT NULL CHECK (kind IN ('offer', 'request')),
  creator_id uuid NOT NULL REFERENCES users(id),
  city_key text NOT NULL CHECK (length(btrim(city_key)) > 0),
  status text NOT NULL CHECK (status IN ('open', 'cancelled', 'closed')),
  seat_capacity integer NOT NULL CHECK (seat_capacity BETWEEN 1 AND 8),
  departure_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (time_zone = 'America/New_York'),
  listed_price_cents integer CHECK (listed_price_cents >= 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rides_list_idx ON rides(city_key, kind, status, departure_at, id);
CREATE INDEX rides_creator_idx ON rides(creator_id, departure_at DESC);

CREATE TABLE ride_members (
  ride_id text NOT NULL REFERENCES rides(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('driver', 'passenger')),
  seat_count integer NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'left')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  PRIMARY KEY (ride_id, user_id),
  CHECK ((role = 'driver' AND seat_count = 0) OR (role = 'passenger' AND seat_count BETWEEN 1 AND 8)),
  CHECK ((state = 'active' AND left_at IS NULL) OR (state = 'left' AND left_at IS NOT NULL)),
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE UNIQUE INDEX ride_members_driver_idx ON ride_members(ride_id) WHERE role = 'driver' AND state = 'active';
CREATE INDEX ride_members_user_idx ON ride_members(user_id, state, joined_at DESC);

CREATE TABLE ride_stops (
  ride_id text NOT NULL REFERENCES rides(id),
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('departure', 'destination')),
  address text NOT NULL CHECK (length(btrim(address)) > 0),
  place_id text CHECK (place_id IS NULL OR length(btrim(place_id)) > 0),
  departure_at timestamptz,
  PRIMARY KEY (ride_id, position),
  CHECK (kind <> 'departure' OR departure_at IS NOT NULL)
);

CREATE TABLE idempotency_requests (
  user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL CHECK (length(btrim(operation)) > 0),
  request_key text NOT NULL CHECK (length(btrim(request_key)) BETWEEN 1 AND 128),
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, request_key)
);
CREATE INDEX idempotency_created_idx ON idempotency_requests(created_at);

CREATE TABLE business_events (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  ride_id text NOT NULL REFERENCES rides(id),
  ride_version integer NOT NULL CHECK (ride_version > 0),
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  actor_id uuid NOT NULL REFERENCES users(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ride_id, ride_version)
);
CREATE INDEX business_events_created_idx ON business_events(created_at, id);
