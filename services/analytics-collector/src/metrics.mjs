import { TABLES } from './schema.mjs';
export function readSafeMetrics(db) {
  const count = sql => db.prepare(sql).get().n;
  // One expansion for both populations. CROSS JOIN in eligible_events keeps
  // JSON expansion outside the receipt lookup, so each batch inflates once.
  const events = db.prepare(`SELECT p.synthetic,json_extract(e.event_json,'$.eventName') AS eventName,COUNT(*) AS count
    FROM eligible_events e JOIN ${TABLES.participants} p ON p.participant_key=e.participant_key
    GROUP BY p.synthetic,eventName ORDER BY p.synthetic,eventName`).all();
  const byName = synthetic => events.filter(row => row.synthetic === synthetic).map(({ eventName, count }) => ({ eventName, count }));
  const total = synthetic => events.filter(row => row.synthetic === synthetic).reduce((sum, row) => sum + row.count, 0);
  return {
    realActiveParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=0 AND status='active'`),
    realRevokedParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=0 AND status='revoked'`),
    syntheticParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=1`),
    syntheticActiveParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=1 AND status='active'`),
    syntheticRevokedParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=1 AND status='revoked'`),
    realEligibleEvents: total(0),
    realEligibleBatches: count(`SELECT COUNT(*) AS n FROM eligible_batches b JOIN ${TABLES.participants} p ON p.participant_key=b.participant_key WHERE p.synthetic=0`),
    realLatestReceivedAt: db.prepare(`SELECT MAX(b.received_at) AS at FROM eligible_batches b JOIN ${TABLES.participants} p ON p.participant_key=b.participant_key WHERE p.synthetic=0`).get().at,
    realEventsByName: byName(0),
    syntheticEligibleEvents: total(1),
    syntheticEligibleBatches: count(`SELECT COUNT(*) AS n FROM eligible_batches b JOIN ${TABLES.participants} p ON p.participant_key=b.participant_key WHERE p.synthetic=1`),
    syntheticLatestReceivedAt: db.prepare(`SELECT MAX(b.received_at) AS at FROM eligible_batches b JOIN ${TABLES.participants} p ON p.participant_key=b.participant_key WHERE p.synthetic=1`).get().at,
    syntheticEventsByName: byName(1),
  };
}
