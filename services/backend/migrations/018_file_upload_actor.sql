ALTER TABLE files ADD COLUMN uploaded_by_admin_id text
  CHECK (uploaded_by_admin_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$');
ALTER TABLE files ADD CONSTRAINT files_upload_admin_fk
  FOREIGN KEY (app_id, uploaded_by_admin_id) REFERENCES admin_accounts(app_id, id);
ALTER TABLE files ADD CONSTRAINT files_upload_admin_owner
  CHECK (uploaded_by_admin_id IS NULL OR admin_owner_key IS NOT NULL);
ALTER TABLE files ADD CONSTRAINT files_upload_admin_required
  CHECK (legacy_readonly OR admin_owner_key IS NULL OR uploaded_by_admin_id IS NOT NULL);

-- Ownership can be shared by an administrator group, but that does not make
-- an unattached upload available to every account in that group.
CREATE FUNCTION protect_file_upload_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.uploaded_by_admin_id IS DISTINCT FROM NEW.uploaded_by_admin_id THEN
    RAISE EXCEPTION 'file upload actor is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER files_upload_actor_immutable BEFORE UPDATE OF uploaded_by_admin_id ON files
  FOR EACH ROW EXECUTE FUNCTION protect_file_upload_actor();
