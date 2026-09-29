-- Schema captured from the deployed pre-rename store (Git ce68663).
-- Historical values below are synthetic fixture data, never user records.
CREATE TABLE collector_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE research_participants (
      participant_key TEXT PRIMARY KEY, grant_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      status_version INTEGER NOT NULL, purpose_version TEXT NOT NULL, synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)), updated_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE revoked_grants (
      participant_key TEXT NOT NULL, grant_id TEXT NOT NULL, status_version INTEGER NOT NULL, revoked_at INTEGER NOT NULL,
      PRIMARY KEY(participant_key, grant_id)
    ) STRICT;
CREATE TABLE batch_receipts (
      participant_key TEXT NOT NULL, batch_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, event_count INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(participant_key, batch_id)
    ) STRICT;
CREATE TABLE ingest_batches (
      participant_key TEXT NOT NULL, batch_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      status_version INTEGER NOT NULL, purpose_version TEXT NOT NULL, received_at INTEGER NOT NULL,
      payload BLOB NOT NULL, PRIMARY KEY(participant_key, batch_id),
      FOREIGN KEY(participant_key, batch_id) REFERENCES batch_receipts(participant_key, batch_id)
    ) STRICT;
CREATE TABLE event_receipts (
      participant_key TEXT NOT NULL, event_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      event_hash TEXT NOT NULL, first_batch_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(participant_key, event_id)
    ) STRICT;
CREATE TABLE research_accounts (
      account_subject TEXT PRIMARY KEY, participant_key TEXT NOT NULL UNIQUE,
      notice_version TEXT NOT NULL, created_at INTEGER NOT NULL, openid TEXT,
      FOREIGN KEY(participant_key) REFERENCES research_participants(participant_key)
    ) STRICT;
CREATE TABLE participation_operations (
      account_subject TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      action TEXT NOT NULL, status_version INTEGER NOT NULL, purpose_version TEXT NOT NULL,
      notice_version TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(account_subject, request_id)
    ) STRICT;
CREATE TABLE bridge_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX bridge_nonce_expiry ON bridge_nonces(expires_at);
CREATE INDEX participation_operation_age ON participation_operations(created_at);
CREATE INDEX ingest_batch_age ON ingest_batches(received_at);
CREATE INDEX research_account_openid ON research_accounts(openid);
CREATE TABLE place_catalog (
      place_id TEXT PRIMARY KEY, label TEXT NOT NULL, city_key TEXT NOT NULL, parent_region_id TEXT NOT NULL,
      airport INTEGER NOT NULL, standard INTEGER NOT NULL, approved_at INTEGER NOT NULL, verification TEXT NOT NULL
    ) STRICT;
CREATE TABLE place_aliases (alias TEXT NOT NULL, city_key TEXT NOT NULL, place_id TEXT NOT NULL,
      PRIMARY KEY(alias,city_key), FOREIGN KEY(place_id) REFERENCES place_catalog(place_id)) STRICT;
CREATE TABLE place_candidates (candidate_id TEXT PRIMARY KEY, city_key TEXT NOT NULL, label TEXT NOT NULL,
      classification TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL) STRICT;
CREATE TABLE place_business_events (synthetic INTEGER NOT NULL, event_id TEXT NOT NULL, event_hash TEXT NOT NULL,
      trip_id TEXT NOT NULL, trip_type TEXT NOT NULL, version INTEGER NOT NULL, event_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(synthetic,event_id), UNIQUE(synthetic,trip_type,trip_id,version)) STRICT;
CREATE INDEX place_business_age ON place_business_events(received_at);
CREATE TABLE place_participation_history (synthetic INTEGER NOT NULL, openid TEXT NOT NULL,
      event_id TEXT NOT NULL, trip_id TEXT NOT NULL, trip_type TEXT NOT NULL, version INTEGER NOT NULL,
      event_at INTEGER NOT NULL, city_key TEXT NOT NULL, service_date TEXT NOT NULL, role TEXT NOT NULL,
      active INTEGER NOT NULL, origin_id TEXT NOT NULL, destination_id TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(synthetic,openid,event_id)) STRICT;
CREATE INDEX place_participation_account ON place_participation_history(synthetic,openid,event_at);
CREATE INDEX place_participation_trip_version ON place_participation_history(synthetic,openid,trip_type,trip_id,version,event_at);
CREATE TABLE place_public_usage (synthetic INTEGER NOT NULL, event_id TEXT NOT NULL, place_id TEXT NOT NULL,
      city_key TEXT NOT NULL, field TEXT NOT NULL, openid TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      circle_ids TEXT NOT NULL, source TEXT NOT NULL, evidence_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(synthetic,event_id,place_id,field)) STRICT;
CREATE INDEX place_usage_query ON place_public_usage(synthetic,city_key,field,occurred_at);
CREATE TABLE place_selection_votes (synthetic INTEGER NOT NULL, openid TEXT NOT NULL, place_id TEXT NOT NULL,
      field TEXT NOT NULL, vote_day TEXT NOT NULL, city_key TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      circle_ids TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(synthetic,openid,place_id,field,vote_day)) STRICT;
CREATE INDEX place_votes_query ON place_selection_votes(synthetic,city_key,field,occurred_at);
CREATE TABLE place_outcomes (synthetic INTEGER NOT NULL, openid TEXT NOT NULL, trip_id TEXT NOT NULL,
      trip_type TEXT NOT NULL, event_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, outcome TEXT NOT NULL,
      PRIMARY KEY(synthetic,openid,event_id)) STRICT;
CREATE INDEX place_outcomes_account ON place_outcomes(synthetic,openid,occurred_at);
CREATE TABLE place_rank_snapshots (snapshot_id TEXT PRIMARY KEY, participant_key TEXT NOT NULL,
      synthetic INTEGER NOT NULL, cache_key TEXT NOT NULL, generated_at INTEGER NOT NULL, response TEXT NOT NULL) STRICT;
CREATE INDEX place_snapshot_account ON place_rank_snapshots(participant_key,cache_key,generated_at);
CREATE TABLE place_followup_population (synthetic INTEGER NOT NULL, trip_id TEXT NOT NULL, trip_type TEXT NOT NULL,
      openid TEXT NOT NULL, role TEXT NOT NULL, trip_version INTEGER NOT NULL, eligible_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, active INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(synthetic,trip_id,trip_type,openid)) STRICT;
CREATE VIEW eligible_batches AS
      SELECT b.* FROM ingest_batches b JOIN research_participants p ON p.participant_key=b.participant_key
      WHERE p.status='active' AND p.grant_id=b.grant_id AND p.purpose_version=b.purpose_version
        AND (SELECT value FROM collector_settings WHERE key='restore_gate')='open'
        AND b.received_at > (CAST(strftime('%s','now') AS INTEGER)*1000 - CASE p.synthetic WHEN 1 THEN 14 ELSE 180 END*86400000);
CREATE VIEW eligible_events AS
      SELECT b.participant_key, b.grant_id, b.purpose_version, b.batch_id, b.received_at,
        json_extract(e.value,'$.eventId') AS event_id, e.value AS event_json
      FROM eligible_batches b, json_each(CAST(b.payload AS TEXT),'$.events') e
      JOIN event_receipts r ON r.participant_key=b.participant_key
        AND r.event_id=json_extract(e.value,'$.eventId') AND r.first_batch_id=b.batch_id;
CREATE VIEW eligible_real_batches AS
      SELECT b.* FROM eligible_batches b JOIN research_participants p ON p.participant_key=b.participant_key WHERE p.synthetic=0;
CREATE VIEW eligible_real_events AS
      SELECT e.* FROM eligible_events e JOIN research_participants p ON p.participant_key=e.participant_key WHERE p.synthetic=0;
CREATE VIEW operational_events AS
        SELECT a.openid,p.synthetic,json_extract(e.event_json,'$.data.tripKey') AS tripKey,e.*
        FROM eligible_events e JOIN research_accounts a ON a.participant_key=e.participant_key
        JOIN research_participants p ON p.participant_key=e.participant_key;
PRAGMA user_version = 4;
