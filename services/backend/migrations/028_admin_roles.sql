ALTER TABLE admin_accounts ADD COLUMN role text NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'superadmin'));

CREATE OR REPLACE FUNCTION revoke_changed_admin_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    NEW.credential_version := greatest(OLD.credential_version + 1, NEW.credential_version);
  END IF;
  IF (OLD.enabled AND NOT NEW.enabled) OR OLD.credential_version IS DISTINCT FROM NEW.credential_version
    OR OLD.password_salt IS DISTINCT FROM NEW.password_salt OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR OLD.owner_key IS DISTINCT FROM NEW.owner_key OR OLD.role IS DISTINCT FROM NEW.role THEN
    DELETE FROM admin_sessions WHERE app_id=NEW.app_id AND account_id=NEW.id;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER admin_account_session_revocation ON admin_accounts;
CREATE TRIGGER admin_account_session_revocation BEFORE UPDATE OF enabled,credential_version,password_salt,password_hash,owner_key,role
  ON admin_accounts FOR EACH ROW EXECUTE FUNCTION revoke_changed_admin_sessions();

CREATE INDEX market_listings_admin_cursor_idx ON market_listings(app_id,created_at DESC,id DESC)
  WHERE status <> 'deleted';
