CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id),
  target_id uuid NOT NULL REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 180),
  blocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (blocker_id, target_id),
  CHECK (blocker_id <> target_id),
  CHECK (updated_at >= blocked_at)
);
CREATE INDEX user_blocks_list_idx ON user_blocks(blocker_id, updated_at DESC, target_id) WHERE active;

