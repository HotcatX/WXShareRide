-- Transport replay protection only; identity and sessions remain in their existing tables.
CREATE TABLE auth_bridge_nonces (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{32}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, nonce)
);
CREATE INDEX auth_bridge_nonces_expiry_idx ON auth_bridge_nonces(app_id, expires_at);
