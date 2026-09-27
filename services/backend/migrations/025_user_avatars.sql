-- Do not discard a populated old avatar column. The import path must reconcile
-- its exact external/default/cloud values before this migration can proceed.
-- Lock before checking so a concurrent legacy profile write cannot be lost.
LOCK TABLE users IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE avatar_url <> '') THEN
    RAISE EXCEPTION 'Existing avatars require explicit reconciliation before migration 025';
  END IF;
END;
$$;
ALTER TABLE users DROP COLUMN avatar_url;

ALTER TABLE file_references DROP CONSTRAINT file_references_resource_kind_check;
ALTER TABLE file_references ADD CONSTRAINT file_references_resource_kind_check
  CHECK (resource_kind IN ('listing','ad','community','user'));
ALTER TABLE file_references ADD CONSTRAINT file_references_user_avatar_check
  CHECK (resource_kind <> 'user' OR (slot='avatar' AND
    resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
