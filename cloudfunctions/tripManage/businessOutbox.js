// Package a copy with the statistics function; never use timestamp watermarks.
async function readPendingBusinessEvents(db, { limit = 10, maxBytes = 112 * 1024 } = {}) {
  const result = await db.collection('TripActions').where({ deliveryState: 'pending' }).orderBy('createdAt', 'asc').limit(Math.min(10, Math.max(1, limit))).get()
  const events = []
  let bytes = 64
  for (const row of result.data || []) {
    if (!row.event || row.event.eventId !== row._id) throw new Error('invalid_business_outbox_record')
    const next = Buffer.byteLength(JSON.stringify(row.event), 'utf8') + 1
    if (bytes + next > maxBytes) {
      if (!events.length) throw new Error('business_outbox_record_too_large')
      break
    }
    bytes += next
    events.push(row.event)
  }
  return events
}
async function acknowledgeBusinessEvents(db, sentEvents, response) {
  if (!response || response.ok !== true || !Array.isArray(response.acceptedEventIds) || !Array.isArray(response.duplicateEventIds)) throw new Error('invalid_business_outbox_ack')
  const sent = new Set(sentEvents.map(event => event.eventId))
  const ids = Array.from(new Set(response.acceptedEventIds.concat(response.duplicateEventIds)))
  if (ids.some(id => !sent.has(id))) throw new Error('unexpected_business_outbox_ack')
  // Immutable IDs identify individual committed facts. Partial ACK or a crash
  // retries only still-pending rows; receiver deduplicates the already stored IDs.
  for (let offset = 0; offset < ids.length; offset += 10) {
    await Promise.all(ids.slice(offset, offset + 10).map(id => db.collection('TripActions').doc(id).update({ data: { deliveryState: 'delivered', deliveredAt: db.serverDate() } })))
  }
  return ids.length
}
module.exports = { readPendingBusinessEvents, acknowledgeBusinessEvents }
