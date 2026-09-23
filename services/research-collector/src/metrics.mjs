export function readSafeMetrics(db) {
  const count = sql => db.prepare(sql).get().n;
  return {
    realActiveParticipants: count("SELECT COUNT(*) AS n FROM research_participants WHERE synthetic=0 AND status='active'"),
    realRevokedParticipants: count("SELECT COUNT(*) AS n FROM research_participants WHERE synthetic=0 AND status='revoked'"),
    syntheticParticipants: count('SELECT COUNT(*) AS n FROM research_participants WHERE synthetic=1'),
    syntheticActiveParticipants: count("SELECT COUNT(*) AS n FROM research_participants WHERE synthetic=1 AND status='active'"),
    syntheticRevokedParticipants: count("SELECT COUNT(*) AS n FROM research_participants WHERE synthetic=1 AND status='revoked'"),
    realEligibleEvents: count('SELECT COUNT(*) AS n FROM eligible_events e JOIN research_participants p ON p.participant_key=e.participant_key WHERE p.synthetic=0'),
    realEligibleBatches: count('SELECT COUNT(*) AS n FROM eligible_batches b JOIN research_participants p ON p.participant_key=b.participant_key WHERE p.synthetic=0'),
    realLatestReceivedAt: db.prepare('SELECT MAX(b.received_at) AS at FROM eligible_batches b JOIN research_participants p ON p.participant_key=b.participant_key WHERE p.synthetic=0').get().at,
    realEventsByName: db.prepare(`SELECT json_extract(e.event_json,'$.eventName') AS eventName, COUNT(*) AS count
      FROM eligible_events e JOIN research_participants p ON p.participant_key=e.participant_key WHERE p.synthetic=0
      GROUP BY eventName ORDER BY eventName`).all(),
    syntheticEligibleEvents: count('SELECT COUNT(*) AS n FROM eligible_events e JOIN research_participants p ON p.participant_key=e.participant_key WHERE p.synthetic=1'),
    syntheticEligibleBatches: count('SELECT COUNT(*) AS n FROM eligible_batches b JOIN research_participants p ON p.participant_key=b.participant_key WHERE p.synthetic=1'),
    syntheticLatestReceivedAt: db.prepare('SELECT MAX(b.received_at) AS at FROM eligible_batches b JOIN research_participants p ON p.participant_key=b.participant_key WHERE p.synthetic=1').get().at,
    syntheticEventsByName: db.prepare(`SELECT json_extract(e.event_json,'$.eventName') AS eventName, COUNT(*) AS count
      FROM eligible_events e JOIN research_participants p ON p.participant_key=e.participant_key WHERE p.synthetic=1
      GROUP BY eventName ORDER BY eventName`).all(),
  };
}
