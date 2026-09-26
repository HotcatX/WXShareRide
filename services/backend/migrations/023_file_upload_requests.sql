-- The pending file itself is the durable upload reservation, not a parallel
-- receipt or job. Its existing metadata columns bind the exact expected bytes;
-- verified_at remains NULL until a trusted storage read has confirmed them.
ALTER TABLE files ADD COLUMN upload_request_key text
  CHECK (upload_request_key ~ '^[a-zA-Z0-9._:-]{8,128}$');
ALTER TABLE files ADD CONSTRAINT files_upload_request_metadata CHECK (
  upload_request_key IS NULL OR
  (NOT legacy_readonly AND provider='cos' AND size_bytes>0 AND size_bytes IS NOT NULL
    AND media_type IS NOT NULL AND sha256 IS NOT NULL)
);
CREATE UNIQUE INDEX files_user_upload_request_idx ON files(app_id,owner_user_id,upload_request_key)
  WHERE upload_request_key IS NOT NULL AND owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX files_admin_upload_request_idx ON files(app_id,uploaded_by_admin_id,upload_request_key)
  WHERE upload_request_key IS NOT NULL AND uploaded_by_admin_id IS NOT NULL;

CREATE FUNCTION protect_file_upload_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.upload_request_key IS NOT NULL AND
    (NEW.upload_request_key,NEW.owner_user_id,NEW.admin_owner_key,NEW.size_bytes,NEW.media_type,NEW.sha256)
    IS DISTINCT FROM
    (OLD.upload_request_key,OLD.owner_user_id,OLD.admin_owner_key,OLD.size_bytes,OLD.media_type,OLD.sha256) THEN
    RAISE EXCEPTION 'upload request and expected content are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER files_upload_request_immutable BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION protect_file_upload_request();
