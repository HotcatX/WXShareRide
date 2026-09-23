import { randomUUID } from 'node:crypto';

// Synthetic business IDs are deliberately shorter than the older opaque IDs.
// No production OpenID, contact value, payload or transaction price appears here.
export function makeRideEvents(now = Date.now()) {
  const searchId = randomUUID(); const selectionSetId = randomUUID(); const followupId = randomUUID();
  const quote = { referencePriceCents: 2500, currency: 'USD', priceKind: 'listed_reference' };
  const trip = { tripKey: 'trip_A1', tripType: 'carpool' };
  const snapshot = { availableSeats: 0, serviceDate: '2026-09-24', departureMinute: 570,
    originArea: 'fort_lee', destinationArea: 'columbia', snapshotAt: now, ...quote };
  const candidates = [{ ...trip, position: 0, tripVersion: 2, ...snapshot },
    { tripKey: 'request_B2', tripType: 'request', position: 1, referencePriceCents: 0, currency: 'unknown', priceKind: 'listed_reference' }];
  const followup = { followupId, ...trip, role: 'driver' };
  const data = {
    search_submitted: { searchId, tripType: 'all', serviceDate: '2026-09-24', originArea: 'fort_lee',
      destinationArea: 'columbia', partySize: 2, hideFullTrips: true },
    result_set_rendered: { searchId, selectionSetId, source: 'network', renderedCount: 2, loadedDateCount: 3,
      hasMore: false, candidatesComplete: true, zeroReason: 'none', candidates },
    list_snapshot: { selectionSetId, searchId, source: 'cache', renderedCount: 2, hasMore: false, candidatesComplete: true, candidates },
    result_card_visible: { selectionSetId, ...trip, position: 0, visibilityBucket: 'half_1s', ...snapshot },
    trip_card_clicked: { ...trip, selectionSetId, position: 0, ...snapshot },
    detail_viewed: { ...trip, source: 'list', ...snapshot },
    contact_action: { ...trip, channel: 'wechat', action: 'copy', outcome: 'success', targetRole: 'driver' },
    followup_presented: followup,
    followup_dismissed: followup,
    followup_answer: { ...followup, outcome: 'yes', outcomeScope: 'driver_any_passenger', ...quote },
    service_request: { operation: 'getTripDetail', outcome: 'success', durationMs: 321, code: 'OK',
      cloudRequestId: 'c'.repeat(128), ...trip },
    client_error: { errorKind: 'runtime', code: 'CLIENT_RUNTIME_ERROR', fingerprint: 'a'.repeat(64) },
  };
  const sessionId = randomUUID();
  return Object.entries(data).map(([eventName, eventData]) => ({ eventId: randomUUID(), eventName,
    schemaVersion: 1, occurredAt: now, sessionId, context: { clientVersion: '2026.09.23.3', sdkVersion: '3.16.0',
      platform: 'devtools', buildMode: 'trial' }, data: structuredClone(eventData) }));
}
