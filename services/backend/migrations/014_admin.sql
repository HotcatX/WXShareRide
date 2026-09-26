CREATE TABLE admin_accounts (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  owner_key text NOT NULL CHECK (owner_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  enabled boolean NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  password_salt bytea,
  password_hash bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, id),
  CHECK ((password_salt IS NULL AND password_hash IS NULL) OR
    (password_salt IS NOT NULL AND password_hash IS NOT NULL AND
     octet_length(password_salt) = 32 AND octet_length(password_hash) = 64))
);

CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  app_id text NOT NULL,
  account_id text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (app_id, account_id) REFERENCES admin_accounts(app_id, id),
  CHECK (expires_at > created_at)
);
CREATE INDEX admin_sessions_account_idx ON admin_sessions(app_id, account_id);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

-- Revocation is permanent even if an operator later re-enables the account or
-- changes password bytes without increasing the credential version.
CREATE FUNCTION revoke_changed_admin_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.enabled AND NOT NEW.enabled) OR OLD.credential_version IS DISTINCT FROM NEW.credential_version
    OR OLD.password_salt IS DISTINCT FROM NEW.password_salt OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR OLD.owner_key IS DISTINCT FROM NEW.owner_key THEN
    DELETE FROM admin_sessions WHERE app_id=NEW.app_id AND account_id=NEW.id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER admin_account_session_revocation AFTER UPDATE OF enabled,credential_version,password_salt,password_hash,owner_key
  ON admin_accounts FOR EACH ROW EXECUTE FUNCTION revoke_changed_admin_sessions();

CREATE TABLE admin_login_attempts (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  scope text NOT NULL CHECK (scope = 'global' OR scope ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 120),
  PRIMARY KEY (app_id, scope)
);

CREATE TABLE admin_origins (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  origin text NOT NULL CHECK (origin ~ '^https://[^/?#[:space:]@]+$' AND length(origin) <= 300),
  PRIMARY KEY (app_id, origin)
);

CREATE TABLE admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  account_id text NOT NULL CHECK (account_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-zA-Z0-9_.-]{0,63}$'),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_audit_account_idx ON admin_audit(app_id, account_id, created_at DESC);

CREATE TABLE admin_requests (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  owner_key text NOT NULL CHECK (owner_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-zA-Z0-9_.-]{0,63}$'),
  request_key text NOT NULL CHECK (length(btrim(request_key)) BETWEEN 1 AND 128),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, owner_key, operation, request_key)
);
