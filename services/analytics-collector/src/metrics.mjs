import { TABLES } from './schema.mjs';
import { eventSchemas, MAX_EVENTS } from './validation.mjs';
export function readSafeMetrics(db) {
  const read = () => readSnapshot(db);
  return db.inTransaction ? read() : db.transaction(read).deferred();
}

function readSnapshot(db) {
  const count = sql => db.prepare(sql).get().n;
  const populations = [0, 1].map(() => ({ batches: 0, latest: null, total: 0, names: new Map() }));
  const receipt = db.prepare('SELECT first_batch_id FROM event_receipts WHERE participant_key=? AND event_id=?');
  // Keep grant/TTL/quarantine filtering and bounded decoding in the existing view.
  // Iteration avoids the full expanded-event GROUP BY spilling into SQLite temp files.
  const batches = db.prepare(`SELECT b.participant_key,b.batch_id,b.received_at,b.payload,p.synthetic
    FROM eligible_batches b JOIN ${TABLES.participants} p ON p.participant_key=b.participant_key`);
  for (const batch of batches.iterate()) {
    const population = populations[batch.synthetic];
    const body = JSON.parse(batch.payload);
    if (!Array.isArray(body?.events) || body.events.length < 1 || body.events.length > MAX_EVENTS) throw new Error('Invalid stored payload');
    population.batches++;
    population.latest = population.latest === null ? batch.received_at : Math.max(population.latest, batch.received_at);
    for (const event of body.events) {
      if (!event || typeof event.eventId !== 'string' || typeof event.eventName !== 'string' || !Object.hasOwn(eventSchemas, event.eventName)) throw new Error('Invalid stored payload');
      if (receipt.get(batch.participant_key, event.eventId)?.first_batch_id !== batch.batch_id) continue;
      population.total++;
      population.names.set(event.eventName, (population.names.get(event.eventName) || 0) + 1);
    }
  }
  const byName = synthetic => [...populations[synthetic].names].map(([eventName, count]) => ({ eventName, count }))
    .sort((a, b) => a.eventName < b.eventName ? -1 : a.eventName > b.eventName ? 1 : 0);
  return {
    realActiveParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=0 AND status='active'`),
    realRevokedParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=0 AND status='revoked'`),
    syntheticParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=1`),
    syntheticActiveParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=1 AND status='active'`),
    syntheticRevokedParticipants: count(`SELECT COUNT(*) AS n FROM ${TABLES.participants} WHERE synthetic=1 AND status='revoked'`),
    realEligibleEvents: populations[0].total,
    realEligibleBatches: populations[0].batches,
    realLatestReceivedAt: populations[0].latest,
    realEventsByName: byName(0),
    syntheticEligibleEvents: populations[1].total,
    syntheticEligibleBatches: populations[1].batches,
    syntheticLatestReceivedAt: populations[1].latest,
    syntheticEventsByName: byName(1),
  };
}
