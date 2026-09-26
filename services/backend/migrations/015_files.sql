ALTER TABLE users ADD CONSTRAINT users_app_id_id_unique UNIQUE (app_id, id);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  provider text NOT NULL CHECK (provider IN ('cloudbase', 'cos')),
  locator text NOT NULL CHECK (octet_length(locator) BETWEEN 1 AND 1024),
  owner_user_id uuid,
  admin_owner_key text CHECK (admin_owner_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  legacy_readonly boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleting', 'deleted')),
  size_bytes bigint CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
  media_type text CHECK (media_type ~ '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$' AND length(media_type) <= 255),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (app_id, id),
  UNIQUE (provider, locator),
  FOREIGN KEY (app_id, owner_user_id) REFERENCES users(app_id, id),
  CHECK ((owner_user_id IS NOT NULL AND admin_owner_key IS NULL) OR
    (owner_user_id IS NULL AND admin_owner_key IS NOT NULL) OR
    (legacy_readonly AND owner_user_id IS NULL AND admin_owner_key IS NULL)),
  CHECK (legacy_readonly OR status = 'pending' OR
    (size_bytes IS NOT NULL AND media_type IS NOT NULL AND sha256 IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX files_deleting_idx ON files(app_id, id) WHERE status = 'deleting';

-- Retried storage deletion must always target the same physical object.
CREATE FUNCTION protect_file_locator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.app_id, NEW.provider, NEW.locator) IS DISTINCT FROM
    (OLD.id, OLD.app_id, OLD.provider, OLD.locator) THEN
    RAISE EXCEPTION 'file identity and locator are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER files_immutable_locator BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION protect_file_locator();

CREATE TABLE file_references (
  app_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('listing', 'ad', 'community')),
  resource_id text NOT NULL CHECK (resource_id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  slot text NOT NULL CHECK (slot ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  file_id uuid NOT NULL,
  PRIMARY KEY (app_id, resource_kind, resource_id, slot),
  FOREIGN KEY (app_id, file_id) REFERENCES files(app_id, id)
);
CREATE INDEX file_references_file_idx ON file_references(app_id, file_id);
