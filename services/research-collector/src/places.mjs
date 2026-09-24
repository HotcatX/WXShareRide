import { createHash, randomUUID } from 'node:crypto';
import { requireThat } from './errors.mjs';
import { shape } from './validation.mjs';
import placeCatalog from './place-catalog.cjs';

export const PLACE_ROUTE = '/v1/place-suggestions';
export const BUSINESS_ROUTE = '/internal/v1/places/business-events';
export const CATALOG_VERSION = placeCatalog.CATALOG_VERSION;
export const RANKING_VERSION = 'circle-selection-v1';
const DAY = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const openid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const code = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value);
const placeId = value => typeof value === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(value);
const int = (min, max = Number.MAX_SAFE_INTEGER) => value => Number.isSafeInteger(value) && value >= min && value <= max;
const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nullable = predicate => value => value === null || predicate(value);
const text = max => value => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);
const uniqueList = (predicate, max) => value => Array.isArray(value) && value.length <= max && value.every(predicate) && new Set(value).size === value.length;
const normalize = value => value.trim().replace(/\s+/g, '').toLowerCase();
const dayAt = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const privateLooking = label => /(?:\b(?:apt|apartment|unit|suite|room)\b|房号|单元|室|\+?\d[\d ()-]{8,}\d|@)/i.test(label);
export const STANDARD_PLACES = placeCatalog.FIXED_PLACES;
const standardIds = new Set(STANDARD_PLACES.map(p => p.placeId));
export function validateSuggestionsRequest(body) {
  requireThat(shape(body, { schemaVersion: v => v === 1, cityKey: code,
    field: v => ['departure', 'destination'].includes(v), mode: v => ['driver', 'passenger', 'filter'].includes(v), counterpartPlaceId: placeId },
  ['schemaVersion', 'cityKey', 'field', 'mode']), 422, 'INVALID_PLACE_REQUEST');
  return body;
}
const endpoint = value => shape(value, { address: text(200), placeId: v => v === '' || placeId(v), date: v => v === '' || date(v), time: text(32) });
const snapshot = value => shape(value, {
  cityKey: code, status: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v),
  departures: v => Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every(endpoint),
  destinations: v => Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every(endpoint),
  referencePriceCents: nullable(int(0, 1_000_000)), currency: v => v === 'USD', priceKind: v => v === 'listed_reference',
  availableSeats: nullable(int(0, 20)), passengerCount: int(0, 100), creatorOpenid: openid,
  driverOpenid: v => v === '' || openid(v), passengerOpenids: uniqueList(openid, 100),
  participantEdges: v => Array.isArray(v) && v.length <= 101 && v.every(e => shape(e, { openid, role: r => ['driver', 'passenger'].includes(r) }))
    && new Set(v.map(e => e.openid)).size === v.length,
  serviceDate: v => v === '' || date(v), departureAtMs: nullable(int(0)), latestDepartureAtMs: nullable(int(0)), tripVersion: int(0, 2_147_483_647),
});
export function validateBusinessEvents(body) {
  requireThat(shape(body, { schemaVersion: v => v === 1, events: v => Array.isArray(v) && v.length >= 1 && v.length <= 50
    && v.every(e => shape(e, { schemaVersion: v => v === 1, eventId: id, tripId: id, tripType: v => ['carpool', 'request'].includes(v),
      action: v => ['publish', 'join', 'accept', 'quit', 'kick', 'delete', 'status', 'update', 'cancel', 'legacy_snapshot'].includes(v), actorOpenid: v => v === '' || openid(v),
      eventAtMs: int(0), version: int(0, 2_147_483_647), before: nullable(snapshot), after: nullable(snapshot),
      affectedOpenids: uniqueList(openid, 101), synthetic: v => typeof v === 'boolean', source: v => ['transaction', 'legacy_snapshot'].includes(v),
    }, ['schemaVersion', 'eventId', 'tripId', 'tripType', 'action', 'actorOpenid', 'eventAtMs', 'version', 'before', 'after', 'affectedOpenids', 'synthetic'])
      && (e.before || e.after) && (!e.after || e.after.tripVersion === e.version)
      && (e.actorOpenid !== '' || e.action === 'status')
      && (e.version > 0 || (e.action === 'legacy_snapshot' && e.source === 'legacy_snapshot')))
    && new Set(v.map(e => `${Number(e.synthetic)}:${e.eventId}`)).size === v.length }), 422, 'INVALID_BUSINESS_EVENTS');
  return body;
}
export function initializePlaces(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS place_catalog (
      place_id TEXT PRIMARY KEY, label TEXT NOT NULL, city_key TEXT NOT NULL, parent_region_id TEXT NOT NULL,
      airport INTEGER NOT NULL, standard INTEGER NOT NULL, approved_at INTEGER NOT NULL, verification TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS place_aliases (alias TEXT NOT NULL, city_key TEXT NOT NULL, place_id TEXT NOT NULL,
      PRIMARY KEY(alias,city_key), FOREIGN KEY(place_id) REFERENCES place_catalog(place_id)) STRICT;
    CREATE TABLE IF NOT EXISTS place_candidates (candidate_id TEXT PRIMARY KEY, city_key TEXT NOT NULL, label TEXT NOT NULL,
      classification TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS place_business_events (synthetic INTEGER NOT NULL, event_id TEXT NOT NULL, event_hash TEXT NOT NULL,
      trip_id TEXT NOT NULL, trip_type TEXT NOT NULL, version INTEGER NOT NULL, event_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(synthetic,event_id), UNIQUE(synthetic,trip_type,trip_id,version)) STRICT;
    CREATE INDEX IF NOT EXISTS place_business_age ON place_business_events(received_at);
    CREATE TABLE IF NOT EXISTS place_participation_history (synthetic INTEGER NOT NULL, openid TEXT NOT NULL,
      event_id TEXT NOT NULL, trip_id TEXT NOT NULL, trip_type TEXT NOT NULL, version INTEGER NOT NULL,
      event_at INTEGER NOT NULL, city_key TEXT NOT NULL, service_date TEXT NOT NULL, role TEXT NOT NULL,
      active INTEGER NOT NULL, origin_id TEXT NOT NULL, destination_id TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(synthetic,openid,event_id)) STRICT;
    CREATE INDEX IF NOT EXISTS place_participation_account ON place_participation_history(synthetic,openid,event_at);
    CREATE INDEX IF NOT EXISTS place_participation_trip_version ON place_participation_history(synthetic,openid,trip_type,trip_id,version,event_at);
    CREATE TABLE IF NOT EXISTS place_public_usage (synthetic INTEGER NOT NULL, event_id TEXT NOT NULL, place_id TEXT NOT NULL,
      city_key TEXT NOT NULL, field TEXT NOT NULL, openid TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      circle_ids TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(synthetic,event_id,place_id,field)) STRICT;
    CREATE INDEX IF NOT EXISTS place_usage_query ON place_public_usage(synthetic,city_key,field,occurred_at);
    CREATE TABLE IF NOT EXISTS place_selection_votes (synthetic INTEGER NOT NULL, openid TEXT NOT NULL, place_id TEXT NOT NULL,
      field TEXT NOT NULL, vote_day TEXT NOT NULL, city_key TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      circle_ids TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(synthetic,openid,place_id,field,vote_day)) STRICT;
    CREATE INDEX IF NOT EXISTS place_votes_query ON place_selection_votes(synthetic,city_key,field,occurred_at);
    CREATE TABLE IF NOT EXISTS place_outcomes (synthetic INTEGER NOT NULL, openid TEXT NOT NULL, trip_id TEXT NOT NULL,
      trip_type TEXT NOT NULL, event_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, outcome TEXT NOT NULL,
      PRIMARY KEY(synthetic,openid,event_id)) STRICT;
    CREATE INDEX IF NOT EXISTS place_outcomes_account ON place_outcomes(synthetic,openid,occurred_at);
    CREATE TABLE IF NOT EXISTS place_rank_snapshots (snapshot_id TEXT PRIMARY KEY, participant_key TEXT NOT NULL,
      synthetic INTEGER NOT NULL, cache_key TEXT NOT NULL, generated_at INTEGER NOT NULL, response TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS place_snapshot_account ON place_rank_snapshots(participant_key,cache_key,generated_at);
    CREATE TABLE IF NOT EXISTS place_followup_population (synthetic INTEGER NOT NULL, trip_id TEXT NOT NULL, trip_type TEXT NOT NULL,
      openid TEXT NOT NULL, role TEXT NOT NULL, trip_version INTEGER NOT NULL, eligible_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, active INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(synthetic,trip_id,trip_type,openid)) STRICT;
  `);
  if (!db.prepare('PRAGMA table_info(place_public_usage)').all().some(c => c.name === 'evidence_at')) {
    db.exec('ALTER TABLE place_public_usage ADD COLUMN evidence_at INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE place_public_usage SET evidence_at=occurred_at');
  }
  for (const p of STANDARD_PLACES) {
    db.prepare('INSERT OR IGNORE INTO place_catalog VALUES (?,?,?,?,?,?,?,?)').run(p.placeId, p.label, 'ny_nj', p.placeId, Number(p.airport), 1, 0, 'curated_standard');
    for (const alias of [...p.aliases, p.label, p.value, p.placeId]) db.prepare('INSERT OR IGNORE INTO place_aliases VALUES (?,?,?)').run(normalize(alias), 'ny_nj', p.placeId);
  }
}
export function createPlacesStore(db, { realEnabled = false } = {}) {
  const resolve = (label, cityKey) => db.prepare(`SELECT c.* FROM place_aliases a JOIN place_catalog c ON c.place_id=a.place_id
    WHERE a.alias=? AND a.city_key=?`).get(normalize(label), cityKey);
  const pointId = (p, cityKey) => p ? resolve(p.address, cityKey)?.place_id || '' : '';
  const circles = (openid, synthetic, cityKey, at, counterpart = '') => {
    // Latest state at the observation time, not today's eventual state. Versions
    // make delayed/out-of-order outbox deliveries deterministic.
    const rows = db.prepare(`SELECT h.* FROM place_participation_history h WHERE h.synthetic=? AND h.openid=? AND h.city_key=?
      AND h.event_at<=? AND h.service_date>=? AND h.service_date<=? AND NOT EXISTS
      (SELECT 1 FROM place_participation_history n WHERE n.synthetic=h.synthetic AND n.openid=h.openid
       AND n.trip_id=h.trip_id AND n.trip_type=h.trip_type AND n.event_at<=? AND n.version>h.version)
      ORDER BY h.event_at DESC LIMIT 1001`).all(Number(synthetic), openid, cityKey, at, dayAt(at - 90 * DAY), dayAt(at + 90 * DAY), at);
    requireThat(rows.length <= 1000, 503, 'PLACE_HISTORY_CAPACITY');
    const negative = new Set(db.prepare(`SELECT trip_type,trip_id FROM place_outcomes WHERE synthetic=? AND openid=? AND occurred_at<=? AND outcome='no'`)
      .all(Number(synthetic), openid, at).map(r => `${r.trip_type}:${r.trip_id}`));
    const groups = new Map(); const anchors = new Set();
    for (const r of rows) {
      if (!r.active || negative.has(`${r.trip_type}:${r.trip_id}`)) continue;
      const a = db.prepare('SELECT * FROM place_catalog WHERE place_id=?').get(r.origin_id);
      const b = db.prepare('SELECT * FROM place_catalog WHERE place_id=?').get(r.destination_id);
      if (a && !a.airport && standardIds.has(a.parent_region_id)) anchors.add(a.parent_region_id);
      if (b && !b.airport && standardIds.has(b.parent_region_id)) anchors.add(b.parent_region_id);
      if (!a || !b || a.airport || b.airport || !standardIds.has(a.parent_region_id) || !standardIds.has(b.parent_region_id) || a.parent_region_id === b.parent_region_id) continue;
      const ends = [a.parent_region_id, b.parent_region_id].sort(); const key = ends.join(':');
      const g = groups.get(key) || { circleId: key, stable: false, ends, days: new Set(), recent: new Set(), directions: new Set(), sources: new Set(), latest: 0 };
      g.days.add(r.service_date); if (r.service_date >= dayAt(at - 30 * DAY)) g.recent.add(r.service_date);
      g.directions.add(`${a.parent_region_id}:${b.parent_region_id}`); g.sources.add(r.source); g.latest = Math.max(g.latest, r.event_at); groups.set(key, g);
    }
    const parent = db.prepare('SELECT parent_region_id FROM place_catalog WHERE place_id=?').get(counterpart)?.parent_region_id || counterpart;
    const result = [...groups.values()].map(g => ({ ...g, stable: g.days.size >= 2 || g.directions.size >= 2 })).sort((a, b) =>
      Number(b.ends.includes(parent)) - Number(a.ends.includes(parent)) || Number(b.stable) - Number(a.stable)
      || b.recent.size - a.recent.size || b.days.size - a.days.size || b.latest - a.latest || a.circleId.localeCompare(b.circleId)).slice(0, 2);
    return { circles: result.map(({ circleId, stable, sources }) => ({ circleId, stable,
      evidenceKind: sources.size > 1 ? 'mixed' : [...sources][0] })), anchors: [...anchors].sort() };
  };
  const activateUsage = event => {
    if (!['publish', 'legacy_snapshot'].includes(event.action) || !event.after) return;
    const s = event.after; const asOf = circles(event.actorOpenid, event.synthetic, s.cityKey, event.eventAtMs - 1).circles.map(c => c.circleId);
    for (const [field, points] of [['departure', s.departures], ['destination', s.destinations]]) {
      for (const point of points) {
        const label = point.address.trim(); if (!label) continue;
        const p = resolve(label, s.cityKey);
        if (p) {
          // A retained historical snapshot proves its planned service date, not
          // when a place was chosen. Keep that ranking clock separate from the
          // time this partial evidence became known to the collector.
          const usageAt = event.source === 'legacy_snapshot' && date(s.serviceDate)
            ? Date.parse(`${s.serviceDate}T16:00:00.000Z`) : event.eventAtMs;
          db.prepare('INSERT OR IGNORE INTO place_public_usage VALUES (?,?,?,?,?,?,?,?,?,?)').run(Number(event.synthetic), event.eventId, p.place_id, s.cityKey, field, event.actorOpenid, usageAt, JSON.stringify(asOf), event.source || 'transaction', event.eventAtMs);
        }
        else {
          const candidateId = hash(`${s.cityKey}\n${normalize(label)}`);
          db.prepare(`INSERT INTO place_candidates VALUES (?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`)
            .run(candidateId, s.cityKey, label, privateLooking(label) ? 'private' : 'pending', event.eventAtMs, event.eventAtMs);
        }
      }
    }
  };
  const reconcile = (account, synthetic, now) => {
    for (const table of ['place_selection_votes', 'place_public_usage']) {
      const rows = db.prepare(`SELECT rowid,* FROM ${table} WHERE synthetic=? AND openid=? AND occurred_at>=? LIMIT 5001`).all(Number(synthetic), account, now - 90 * DAY);
      requireThat(rows.length <= 5000, 503, 'PLACE_RECONCILIATION_CAPACITY');
      for (const r of rows) {
        const next = JSON.stringify(circles(account, synthetic, r.city_key, (r.evidence_at || r.occurred_at) - 1).circles.map(c => c.circleId));
        if (r.circle_ids !== next) db.prepare(`UPDATE ${table} SET circle_ids=? WHERE rowid=?`).run(next, r.rowid);
      }
    }
  };
  const ingestBusiness = db.transaction((body, now) => {
    validateBusinessEvents(body); const acceptedEventIds = []; const duplicateEventIds = []; const affected = new Map();
    requireThat(db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value === 'open', 503, 'RESTORE_QUARANTINE');
    requireThat(realEnabled || body.events.every(e => e.synthetic), 503, 'COLLECTION_DISABLED');
    for (const e of body.events) {
      requireThat(e.eventAtMs <= now + 300_000, 422, 'FUTURE_BUSINESS_EVENT');
      const payload = JSON.stringify(e); const payloadHash = hash(payload);
      const prior = db.prepare('SELECT event_hash FROM place_business_events WHERE synthetic=? AND event_id=?').get(Number(e.synthetic), e.eventId);
      if (prior) { requireThat(prior.event_hash === payloadHash, 409, 'BUSINESS_EVENT_CONFLICT'); duplicateEventIds.push(e.eventId); acceptedEventIds.push(e.eventId); continue; }
      requireThat(!db.prepare('SELECT 1 FROM place_business_events WHERE synthetic=? AND trip_type=? AND trip_id=? AND version=?').get(Number(e.synthetic), e.tripType, e.tripId, e.version), 409, 'BUSINESS_VERSION_CONFLICT');
      db.prepare('INSERT INTO place_business_events VALUES (?,?,?,?,?,?,?,?,?)').run(Number(e.synthetic), e.eventId, payloadHash, e.tripId, e.tripType, e.version, e.eventAtMs, now, payload);
      activateUsage(e);
      const s = e.after || e.before; const all = new Map([...(e.before?.participantEdges || []), ...(e.after?.participantEdges || [])].map(p => [p.openid, p]));
      const current = new Set((e.after?.participantEdges || []).map(p => p.openid));
      const activeStatus = !!e.after && ['open', 'full', 'past', 'close'].includes(e.after.status) && !['cancel', 'delete'].includes(e.action);
      for (const [account, p] of all) {
        affected.set(`${Number(e.synthetic)}:${account}`, { account, synthetic: e.synthetic });
        const active = activeStatus && current.has(account);
        db.prepare('INSERT INTO place_participation_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(Number(e.synthetic), account, e.eventId, e.tripId, e.tripType,
          e.version, e.eventAtMs, s.cityKey, s.serviceDate, p.role, Number(active), pointId(s.departures[0], s.cityKey), pointId(s.destinations[0], s.cityKey), e.source || 'transaction');
        // Same qualification clock as client: max(last departure +4h, next NY day 09h).
        // A lower-bound marker is retained even when precise departure is unknown.
        const dep = s.latestDepartureAtMs || s.departureAtMs;
        if (dep !== null) {
          const eligibleAt = Math.max(dep + 4 * 3_600_000, nextNewYorkMorning(dep));
          db.prepare(`INSERT INTO place_followup_population VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(synthetic,trip_id,trip_type,openid) DO UPDATE SET
            role=excluded.role,trip_version=excluded.trip_version,eligible_at=excluded.eligible_at,expires_at=excluded.expires_at,active=excluded.active,source=excluded.source
            WHERE excluded.trip_version>place_followup_population.trip_version`).run(Number(e.synthetic), e.tripId, e.tripType, account, p.role, e.version, eligibleAt, dep + 7 * DAY, Number(active && ['past', 'close'].includes(s.status)), e.source || 'transaction');
        }
      }
      acceptedEventIds.push(e.eventId);
    }
    for (const { account, synthetic } of affected.values()) reconcile(account, synthetic, now);
    return { ok: true, acceptedEventIds, duplicateEventIds };
  });
  const recordEvent = (participant, event) => {
    const account = db.prepare('SELECT openid FROM research_accounts WHERE participant_key=?').get(participant.participant_key)?.openid;
    if (!account) return;
    const d = event.data; const synthetic = participant.synthetic;
    if (event.eventName === 'followup_answer') {
      db.prepare('INSERT OR IGNORE INTO place_outcomes VALUES (?,?,?,?,?,?,?)').run(synthetic, account, d.tripKey, d.tripType, event.eventId, event.occurredAt, d.outcome);
      reconcile(account, synthetic, event.occurredAt);
    }
    if (event.eventName !== 'place_picker_selected') return;
    const p = db.prepare('SELECT * FROM place_catalog WHERE place_id=? AND city_key=?').get(d.placeId, d.cityKey); if (!p) return;
    const currentCircles = circles(account, synthetic, d.cityKey, event.occurredAt - 1).circles.map(c => c.circleId);
    db.prepare(`INSERT INTO place_selection_votes VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(synthetic,openid,place_id,field,vote_day) DO UPDATE SET
      occurred_at=excluded.occurred_at,circle_ids=excluded.circle_ids,event_id=excluded.event_id WHERE excluded.occurred_at<place_selection_votes.occurred_at`)
      .run(synthetic, account, d.placeId, d.field, dayAt(event.occurredAt), d.cityKey, event.occurredAt, JSON.stringify(currentCircles), event.eventId);
  };
  const suggestions = (participant, body, now) => {
    validateSuggestionsRequest(body);
    const account = db.prepare('SELECT openid FROM research_accounts WHERE participant_key=?').get(participant.participant_key)?.openid;
    requireThat(account, 403, 'PLACE_IDENTITY_REQUIRED');
    const context = circles(account, participant.synthetic, body.cityKey, now, body.counterpartPlaceId);
    const preferenceVersion = hash(JSON.stringify(context)).slice(0, 24);
    const cacheKey = hash(JSON.stringify([body, preferenceVersion, CATALOG_VERSION, RANKING_VERSION]));
    const previous = db.prepare('SELECT * FROM place_rank_snapshots WHERE participant_key=? AND cache_key=? ORDER BY generated_at DESC LIMIT 1').get(participant.participant_key, cacheKey);
    if (previous && previous.generated_at > now - 300_000) return JSON.parse(previous.response);
    const candidates = db.prepare(`SELECT DISTINCT c.* FROM place_catalog c JOIN place_public_usage u ON u.place_id=c.place_id
      WHERE c.city_key=? AND c.standard=0 AND u.synthetic=? AND u.occurred_at>=? LIMIT 501`).all(body.cityKey, participant.synthetic, now - 180 * DAY);
    requireThat(candidates.length <= 500, 503, 'PLACE_CATALOG_CAPACITY');
    const selectionRows = db.prepare('SELECT * FROM place_selection_votes WHERE synthetic=? AND city_key=? AND field=? AND occurred_at>=? AND occurred_at<=? LIMIT 50001')
      .all(participant.synthetic, body.cityKey, body.field, now - 90 * DAY, now);
    requireThat(selectionRows.length <= 50000, 503, 'PLACE_VOTE_CAPACITY');
    const historicalRows = db.prepare('SELECT * FROM place_public_usage WHERE synthetic=? AND city_key=? AND field=? AND occurred_at>=? AND occurred_at<=? LIMIT 50001')
      .all(participant.synthetic, body.cityKey, body.field, now - 90 * DAY, now);
    requireThat(historicalRows.length <= 50000, 503, 'PLACE_USAGE_CAPACITY');
    const rankingBasis = selectionRows.some(r => !standardIds.has(r.place_id)) ? 'confirmed_selection' : 'historical_usage';
    const rows = rankingBasis === 'confirmed_selection' ? selectionRows : historicalRows;
    const circleIds = new Set(context.circles.map(c => c.circleId));
    const grouped = new Map();
    for (const row of rows) {
      const item = { ...row, belongs: JSON.parse(row.circle_ids).some(c => circleIds.has(c)) };
      const group = grouped.get(row.place_id) || []; group.push(item); grouped.set(row.place_id, group);
    }
    const previousOrder = new Map((previous ? JSON.parse(previous.response).places : []).map((p, i) => [p.placeId, i]));
    const metrics = (p, inCircle) => {
      const matching = (grouped.get(p.place_id) || []).filter(r => !inCircle || r.belongs);
      // Historical counts remain explicitly a separate basis, deduplicated with
      // the same per-account/side/NY-day unit; they are never added to selections.
      const unique = new Map(); for (const r of matching) unique.set(`${r.openid}:${dayAt(r.occurred_at)}`, r);
      const all = [...unique.values()]; const recent = all.filter(r => r.occurred_at >= now - 30 * DAY);
      return { selectionCount30d: rankingBasis === 'confirmed_selection' ? recent.length : 0,
        uniqueUsers30d: new Set(recent.map(r => r.openid)).size, selectionCount90d: rankingBasis === 'confirmed_selection' ? all.length : 0,
        historicalUsage30d: rankingBasis === 'historical_usage' ? recent.length : 0, rank30: recent.length, rank90: all.length };
    };
    const rank = inCircle => candidates.map(p => ({ p, ...metrics(p, inCircle) })).filter(r => !inCircle || r.rank90 > 0).sort((a, b) =>
      b.rank30 - a.rank30 || b.uniqueUsers30d - a.uniqueUsers30d || b.rank90 - a.rank90
      || (previousOrder.get(a.p.place_id) ?? 999) - (previousOrder.get(b.p.place_id) ?? 999) || a.p.place_id.localeCompare(b.p.place_id));
    const selected = []; const seen = new Set();
    const fresh = candidates.filter(p => p.approved_at >= now - 30 * DAY).sort((a, b) => b.approved_at - a.approved_at || a.place_id.localeCompare(b.place_id));
    const newPlace = fresh.length ? fresh[Math.floor(now / 300_000) % fresh.length] : null;
    const add = (r, source) => { if (seen.has(r.p.place_id)) return; seen.add(r.p.place_id);
      selected.push({ placeId: r.p.place_id, label: r.p.label, parentRegionId: r.p.parent_region_id, source,
        selectionCount30d: r.selectionCount30d, uniqueUsers30d: r.uniqueUsers30d, selectionCount90d: r.selectionCount90d, historicalUsage30d: r.historicalUsage30d }); };
    for (const r of rank(true)) { if (selected.length >= 8) break; if (r.p.place_id !== newPlace?.place_id) add(r, 'circle'); }
    // Airport-only histories use the known non-airport anchor before city fallback.
    const city = rank(false).sort((a, b) => Number(context.anchors.includes(b.p.parent_region_id)) - Number(context.anchors.includes(a.p.parent_region_id)));
    for (const r of city) { if (selected.length >= 8) break; if (r.p.place_id !== newPlace?.place_id) add(r, 'city'); }
    if (newPlace) add({ p: newPlace, ...metrics(newPlace, false) }, 'new');
    const response = { ok: true, catalogVersion: CATALOG_VERSION, rankingVersion: RANKING_VERSION, snapshotId: randomUUID(), generatedAt: now,
      preferenceVersion, circles: context.circles, rankingBasis, places: selected };
    db.prepare('INSERT INTO place_rank_snapshots VALUES (?,?,?,?,?,?)').run(response.snapshotId, participant.participant_key, participant.synthetic, cacheKey, now, JSON.stringify(response));
    return response;
  };
  const approve = db.transaction((body, now) => {
    requireThat(shape(body, { candidateId: v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), label: text(120),
      parentRegionId: v => v === 'unknown' || (standardIds.has(v) && !STANDARD_PLACES.find(p => p.placeId === v).airport),
      verification: v => v === 'manual_public_poi', verificationReference: v => typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 500 }), 422, 'INVALID_PLACE_APPROVAL');
    const candidate = db.prepare('SELECT * FROM place_candidates WHERE candidate_id=?').get(body.candidateId);
    requireThat(candidate && candidate.classification !== 'private' && !privateLooking(body.label) && body.label.trim().length > 0, 422, 'PLACE_NOT_PUBLIC');
    const place = `poi_${candidate.candidate_id}`;
    db.prepare('INSERT OR IGNORE INTO place_catalog VALUES (?,?,?,?,?,?,?,?)').run(place, body.label.trim(), candidate.city_key, body.parentRegionId, 0, 0, now, `${body.verification}:${body.verificationReference}`);
    for (const alias of [candidate.label, body.label]) {
      const old = resolve(alias, candidate.city_key); requireThat(!old || old.place_id === place, 409, 'PLACE_ALIAS_CONFLICT');
      db.prepare('INSERT OR IGNORE INTO place_aliases VALUES (?,?,?)').run(normalize(alias), candidate.city_key, place);
    }
    db.prepare("UPDATE place_candidates SET classification='public' WHERE candidate_id=?").run(candidate.candidate_id);
    // Approved names become eligible through their original successful publish,
    // retaining its true time and publisher's circle as of that time.
    const events = db.prepare("SELECT payload FROM place_business_events WHERE json_extract(payload,'$.action') IN ('publish','legacy_snapshot') AND event_at>=? ORDER BY event_at,version LIMIT 10001").all(now - 180 * DAY);
    requireThat(events.length <= 10000, 503, 'PLACE_APPROVAL_BACKFILL_CAPACITY');
    for (const e of events) activateUsage(JSON.parse(e.payload));
    return { ok: true, placeId: place, catalogVersion: CATALOG_VERSION };
  });
  const seed = db.transaction((body, now) => {
    requireThat(shape(body, { label: text(120), aliases: uniqueList(text(120), 10), cityKey: code,
      parentRegionId: v => v === 'unknown' || (standardIds.has(v) && !STANDARD_PLACES.find(p => p.placeId === v).airport),
      verificationReference: v => typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 500 }), 422, 'INVALID_PLACE_SEED');
    requireThat(body.label.trim().length > 0 && ![body.label, ...body.aliases].some(privateLooking), 422, 'PLACE_NOT_PUBLIC');
    const candidateId = hash(`${body.cityKey}\n${normalize(body.label)}`);
    db.prepare('INSERT OR IGNORE INTO place_candidates VALUES (?,?,?,?,?,?)').run(candidateId, body.cityKey, body.label, 'pending', now, now);
    const result = approve({ candidateId, label: body.label, parentRegionId: body.parentRegionId,
      verification: 'manual_public_poi', verificationReference: body.verificationReference }, now);
    for (const alias of body.aliases) {
      const prior = resolve(alias, body.cityKey); requireThat(!prior || prior.place_id === result.placeId, 409, 'PLACE_ALIAS_CONFLICT');
      db.prepare('INSERT OR IGNORE INTO place_aliases VALUES (?,?,?)').run(normalize(alias), body.cityKey, result.placeId);
    }
    // Aliases may match existing publications even when the display label did not.
    for (const row of db.prepare("SELECT payload FROM place_business_events WHERE event_at>=? ORDER BY event_at,version LIMIT 10001").all(now - 180 * DAY)) activateUsage(JSON.parse(row.payload));
    return result;
  });
  const pending = body => {
    requireThat(shape(body, { limit: int(1, 100) }), 422, 'INVALID_PLACE_PENDING_REQUEST');
    return { ok: true, candidates: db.prepare("SELECT candidate_id AS candidateId,city_key AS cityKey,label,classification,first_seen AS firstSeen,last_seen AS lastSeen FROM place_candidates WHERE classification='pending' ORDER BY last_seen DESC,candidate_id LIMIT ?").all(body.limit) };
  };
  const status = (now = Date.now()) => ({ ok: true, schemaVersion: 4,
    catalog: db.prepare('SELECT standard,COUNT(*) AS count FROM place_catalog GROUP BY standard').all(),
    candidates: db.prepare('SELECT classification,COUNT(*) AS count FROM place_candidates GROUP BY classification').all(),
    business: db.prepare('SELECT synthetic,COUNT(*) AS count,MAX(received_at) AS lastReceivedAt,MAX(event_at) AS lastEventAt FROM place_business_events GROUP BY synthetic').all(),
    businessBySource: db.prepare("SELECT synthetic,COALESCE(json_extract(payload,'$.source'),'transaction') AS source,COUNT(*) AS count,MAX(received_at) AS lastReceivedAt FROM place_business_events GROUP BY synthetic,source").all(),
    selections: db.prepare('SELECT synthetic,COUNT(*) AS deduplicatedVotes FROM place_selection_votes GROUP BY synthetic').all(),
    snapshots: db.prepare('SELECT synthetic,COUNT(*) AS count FROM place_rank_snapshots GROUP BY synthetic').all(),
    followupPopulation: db.prepare(`SELECT synthetic,source,COUNT(*) AS records,SUM(CASE WHEN active=1 AND eligible_at<=? AND expires_at>? THEN 1 ELSE 0 END) AS currentlyEligible FROM place_followup_population GROUP BY synthetic,source`).all(now, now),
    followupInteractions: db.prepare(`SELECT synthetic,json_extract(event_json,'$.eventName') AS eventName,COUNT(*) AS count
      FROM operational_events WHERE json_extract(event_json,'$.eventName') IN ('followup_presented','followup_dismissed','followup_answer') GROUP BY synthetic,eventName`).all(),
  });
  const prune = now => {
    const counts = {};
    for (const [table, time, days] of [['place_business_events', 'received_at', 180], ['place_participation_history', 'event_at', 180],
      ['place_public_usage', 'occurred_at', 180], ['place_selection_votes', 'occurred_at', 180], ['place_outcomes', 'occurred_at', 180],
      ['place_rank_snapshots', 'generated_at', 180]]) {
      counts[table] = db.prepare(`DELETE FROM ${table} WHERE (synthetic=1 AND ${time}<=?) OR (synthetic=0 AND ${time}<=?)`).run(now - 14 * DAY, now - days * DAY).changes;
    }
    counts.place_candidates = db.prepare("DELETE FROM place_candidates WHERE classification<>'public' AND last_seen<=?").run(now - 180 * DAY).changes;
    counts.place_followup_population = db.prepare('DELETE FROM place_followup_population WHERE expires_at<=?').run(now - 180 * DAY).changes;
    return counts;
  };
  return { resolve, circles, recordEvent, ingestBusiness: (body, now = Date.now()) => ingestBusiness.immediate(body, now),
    suggestions, approve: (body, now = Date.now()) => approve.immediate(body, now),
    seed: (body, now = Date.now()) => seed.immediate(body, now), pending, status, prune };
}
function nextNewYorkMorning(time) {
  const parts = dayAt(time).split('-').map(Number); const tomorrow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1, 9));
  // Find 09:00 wall time using timezone formatting; handles DST transitions.
  for (let offset = 4; offset <= 5; offset++) {
    const candidate = tomorrow.getTime() + offset * 3_600_000;
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(candidate));
    if (hour === '09') return candidate;
  }
  return tomorrow.getTime() + 5 * 3_600_000;
}
