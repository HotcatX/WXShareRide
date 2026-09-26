CREATE TABLE ads (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  status text NOT NULL CHECK (status IN ('online', 'offline', 'deleted')),
  placement text NOT NULL CHECK (length(btrim(placement)) BETWEEN 1 AND 80 AND placement !~ '[[:cntrl:]]'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 1000 AND title !~ '[[:cntrl:]]'),
  subtitle text NOT NULL CHECK (length(subtitle) <= 2000 AND subtitle !~ '[[:cntrl:]]'),
  badge_text text NOT NULL CHECK (length(btrim(badge_text)) BETWEEN 1 AND 240 AND badge_text !~ '[[:cntrl:]]'),
  cta_text text NOT NULL CHECK (length(btrim(cta_text)) BETWEEN 1 AND 240 AND cta_text !~ '[[:cntrl:]]'),
  weight double precision NOT NULL CHECK (weight BETWEEN 1 AND 9007199254740991),
  priority double precision NOT NULL CHECK (priority BETWEEN -9007199254740991 AND 9007199254740991),
  start_at timestamptz CHECK (start_at IS NULL OR isfinite(start_at)),
  end_at timestamptz CHECK (end_at IS NULL OR isfinite(end_at)),
  target jsonb NOT NULL CHECK (COALESCE(
    jsonb_typeof(target) = 'object' AND target ?& ARRAY['kind','sessionFrom','messageCard'] AND
    target - ARRAY['kind','sessionFrom','messageCard'] = '{}'::jsonb AND target->>'kind' = 'contact' AND
    jsonb_typeof(target->'sessionFrom') = 'string' AND length(target->>'sessionFrom') <= 2000 AND
    (target->>'sessionFrom') !~ '[[:cntrl:]]' AND jsonb_typeof(target->'messageCard') = 'object' AND
    (target->'messageCard') ?& ARRAY['enabled','title','path'] AND
    (target->'messageCard') - ARRAY['enabled','title','path'] = '{}'::jsonb AND
    jsonb_typeof(target#>'{messageCard,enabled}') = 'boolean' AND
    jsonb_typeof(target#>'{messageCard,title}') = 'string' AND length(target#>>'{messageCard,title}') BETWEEN 1 AND 1000 AND
    (target#>>'{messageCard,title}') !~ '[[:cntrl:]]' AND
    jsonb_typeof(target#>'{messageCard,path}') = 'string' AND length(target#>>'{messageCard,path}') <= 2048 AND
    (target#>>'{messageCard,path}') !~ '[[:cntrl:]]' AND
    ((target#>>'{messageCard,path}') = '' OR
      ((target#>>'{messageCard,path}') LIKE '/%' AND (target#>>'{messageCard,path}') NOT LIKE '//%' AND
       strpos(target#>>'{messageCard,path}', chr(92)) = 0)),
    false
  )),
  created_at timestamptz DEFAULT clock_timestamp() CHECK (created_at IS NULL OR isfinite(created_at)),
  updated_at timestamptz DEFAULT clock_timestamp() CHECK (updated_at IS NULL OR isfinite(updated_at)),
  PRIMARY KEY (app_id, id),
  -- Existing advertisement windows include their end instant.
  CHECK (start_at IS NULL OR end_at IS NULL OR start_at <= end_at),
  CHECK (created_at IS NULL OR updated_at IS NULL OR created_at <= updated_at)
);
CREATE INDEX ads_placement_idx ON ads(app_id, placement, status, priority DESC, updated_at DESC, id);

-- This table records clicks only. No duplicated type column, impression count
-- or successful-contact claim. ad_id is deliberately not a foreign key: an old
-- click remains evidence even after its advertisement has disappeared.
CREATE TABLE ad_clicks (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  ad_id text NOT NULL CHECK (ad_id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  placement text NOT NULL CHECK (length(btrim(placement)) BETWEEN 1 AND 80 AND placement !~ '[[:cntrl:]]'),
  listing_type text NOT NULL CHECK (listing_type IN ('goods', 'sublet')),
  actor_user_id uuid,
  created_at timestamptz DEFAULT clock_timestamp() CHECK (created_at IS NULL OR isfinite(created_at)),
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, actor_user_id) REFERENCES users(app_id, id)
);
CREATE INDEX ad_clicks_ad_idx ON ad_clicks(app_id, ad_id, created_at DESC, id);

-- A small storage-shape predicate shared by current and revision content. It
-- excludes attachments and unknown bags, but does not interpret availability,
-- expiry, manual viewing or the relationship between successive versions.
CREATE FUNCTION valid_community_content(value jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    jsonb_typeof(value) = 'object' AND value ?& ARRAY['group','announcement'] AND
    value - ARRAY['group','announcement'] = '{}'::jsonb AND
    jsonb_typeof(value->'group') = 'object' AND
    (value->'group') ?& ARRAY['enabled','title','expiresAt'] AND
    (value->'group') - ARRAY['enabled','title','expiresAt'] = '{}'::jsonb AND
    jsonb_typeof(value#>'{group,enabled}') = 'boolean' AND
    jsonb_typeof(value#>'{group,title}') = 'string' AND length(value#>>'{group,title}') BETWEEN 1 AND 80 AND
    jsonb_typeof(value#>'{group,expiresAt}') IN ('null','string') AND
    length(COALESCE(value#>>'{group,expiresAt}', '')) <= 40 AND
    jsonb_typeof(value->'announcement') = 'object' AND
    (value->'announcement') ?& ARRAY['enabled','id','title','body','showGroupImage','maxShows','intervalHours','startAt','endAt'] AND
    (value->'announcement') - ARRAY['enabled','id','title','body','showGroupImage','maxShows','intervalHours','startAt','endAt'] = '{}'::jsonb AND
    jsonb_typeof(value#>'{announcement,enabled}') = 'boolean' AND
    jsonb_typeof(value#>'{announcement,id}') = 'string' AND
    (value#>>'{announcement,id}') ~ '^[a-zA-Z0-9_-]{0,128}$' AND
    jsonb_typeof(value#>'{announcement,title}') = 'string' AND length(value#>>'{announcement,title}') BETWEEN 1 AND 80 AND
    jsonb_typeof(value#>'{announcement,body}') = 'string' AND length(value#>>'{announcement,body}') <= 2000 AND
    jsonb_typeof(value#>'{announcement,showGroupImage}') = 'boolean' AND
    CASE WHEN jsonb_typeof(value#>'{announcement,maxShows}') = 'number' THEN
      (value#>>'{announcement,maxShows}')::numeric BETWEEN 1 AND 100 AND
      trunc((value#>>'{announcement,maxShows}')::numeric) = (value#>>'{announcement,maxShows}')::numeric
    ELSE false END AND
    CASE WHEN jsonb_typeof(value#>'{announcement,intervalHours}') = 'number' THEN
      (value#>>'{announcement,intervalHours}')::numeric BETWEEN 0 AND 8760
    ELSE false END AND
    jsonb_typeof(value#>'{announcement,startAt}') IN ('null','string') AND
    jsonb_typeof(value#>'{announcement,endAt}') IN ('null','string') AND
    length(COALESCE(value#>>'{announcement,startAt}', '')) <= 40 AND
    length(COALESCE(value#>>'{announcement,endAt}', '')) <= 40,
    false
  )
$$;

-- One configuration per application; its fixed resource ID is "main" in the
-- DTO and file_references, not a second editable database identity.
CREATE TABLE community_configs (
  app_id text PRIMARY KEY CHECK (length(btrim(app_id)) > 0),
  version integer NOT NULL CHECK (version >= 0),
  content jsonb NOT NULL CHECK (valid_community_content(content)),
  updated_by_admin_id text,
  updated_at timestamptz DEFAULT clock_timestamp() CHECK (updated_at IS NULL OR isfinite(updated_at)),
  FOREIGN KEY (app_id, updated_by_admin_id) REFERENCES admin_accounts(app_id, id)
);

CREATE TABLE community_revisions (
  app_id text NOT NULL CHECK (length(btrim(app_id)) > 0),
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
  version integer NOT NULL CHECK (version > 0),
  previous_version integer NOT NULL CHECK (previous_version >= 0),
  before_content jsonb NOT NULL CHECK (valid_community_content(before_content)),
  after_content jsonb NOT NULL CHECK (valid_community_content(after_content)),
  updated_by_admin_id text,
  updated_at timestamptz DEFAULT clock_timestamp() CHECK (updated_at IS NULL OR isfinite(updated_at)),
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, version),
  CHECK (version::bigint = previous_version::bigint + 1),
  FOREIGN KEY (app_id) REFERENCES community_configs(app_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (app_id, updated_by_admin_id) REFERENCES admin_accounts(app_id, id)
);
-- Full chain/content continuity is checked by the source converter. Runtime
-- writes must lock the singleton and write current + revision + same-resource
-- file references in one transaction. Historical images stay under
-- community/main with history.{version}.{before|after}.{group|announcement}
-- slots; this schema neither publishes history nor creates file ownership.
