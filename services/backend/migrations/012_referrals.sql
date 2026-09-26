CREATE TABLE referral_codes (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^ref_[a-f0-9]{12}$')
);

CREATE TABLE referral_bindings (
  referred_user_id uuid PRIMARY KEY REFERENCES users(id),
  referrer_user_id uuid NOT NULL REFERENCES users(id),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (referred_user_id <> referrer_user_id)
);
CREATE INDEX referral_bindings_referrer_idx ON referral_bindings(referrer_user_id);
