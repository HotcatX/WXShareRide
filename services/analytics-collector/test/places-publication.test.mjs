import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { openDatabase } from '../src/database.mjs';
import { SCHEMA_VERSION } from '../src/schema.mjs';

const DAY = 86400000, now = Date.now(), A = 'fixture_place_publisher_A', B = 'fixture_place_viewer_B';
const hash = value => createHash('sha256').update(value).digest('hex');
const day = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const point = label => ({ address: label, placeId: '', date: day(now), time: '09:00' });
function business(label, extra = {}) {
  const at = extra.eventAtMs ?? now - DAY, actor = extra.actorOpenid || A;
  return { schemaVersion: 1, eventId: randomUUID(), tripId: randomUUID(), tripType: 'carpool', action: 'publish',
    actorOpenid: actor, eventAtMs: at, version: 1, before: null, synthetic: false, affectedOpenids: [actor],
    after: { cityKey: 'ny_nj', status: 'open', departures: [point(label)], destinations: [point('哥大')],
      referencePriceCents: 1300, currency: 'USD', priceKind: 'listed_reference', availableSeats: 3, passengerCount: 4,
      creatorOpenid: actor, driverOpenid: actor, passengerOpenids: [], participantEdges: [{ openid: actor, role: 'driver' }],
      serviceDate: day(at), departureAtMs: at, latestDepartureAtMs: at, tripVersion: 1 }, ...extra };
}
const body = (...events) => ({ schemaVersion: 1, events });
const request = { schemaVersion: 1, cityKey: 'ny_nj', field: 'departure', mode: 'driver' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-places-')), path = join(dir, 'collector.sqlite');
  const f = { dir, path, store: openStore(path, { realEnabled: true }) };
  t.after(() => { f.store?.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
function enroll(s, openid = B, synthetic = false) {
  const p = s.updateAccount({ accountSubject: randomBytes(32).toString('hex'), action: 'activate', requestId: randomUUID(),
    expectedStatusVersion: 0, purposeVersion: 'ride-analytics-v1', noticeVersion: 'ride-analytics-notice-2026-09-23', openid,
    ...(synthetic ? { synthetic: true } : {}) }).participant;
  return { ...p, sub: p.participantKey, scopes: ['batches:write', 'places:read'] };
}
const shared = s => Object.fromEntries(['place_catalog', 'place_aliases', 'place_candidates'].map(table => [table, s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const immutable = s => Object.fromEntries(['place_business_events', 'place_outcomes', 'place_followup_population', 'place_rank_snapshots',
  'analytics_accounts', 'analytics_participants', 'analytics_operations', 'ingest_batches', 'batch_receipts', 'event_receipts']
  .map(table => [table, s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('real publication is sufficient; normalized aliases, retries and synthetic activity cannot rename shared POIs', t => {
  const { store: s } = fixture(t), viewer = enroll(s), fake = business('Modern 800', { synthetic: true });
  const initial = shared(s);
  s.places.ingestBusiness(body(fake), now);
  assert.deepEqual(shared(s), initial, 'synthetic unknown text does not even create a shared candidate');
  const e = business('Modern800');
  s.places.ingestBusiness(body(e), now);
  const p = s.places.resolve(' modern 800 ', 'ny_nj');
  assert.equal(p.place_id, `poi_${hash('ny_nj\nmodern800')}`);
  assert.equal(p.label, 'Modern800'); assert.equal(p.verification, 'published_route'); assert.equal(p.parent_region_id, 'unknown');
  const catalog = shared(s);
  s.places.ingestBusiness(body(e), now + 1);
  s.places.ingestBusiness(body(business('MODERN 800', { synthetic: true })), now + 2);
  assert.deepEqual(shared(s), catalog);
  s.places.ingestBusiness(body(business(' modern 800 ')), now + 3);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM place_catalog WHERE standard=0').get().n, 1);
  const reply = s.placeSuggestions(viewer, request, now + 4);
  assert.deepEqual(reply.places.map(row => row.label), ['Modern800']);
  assert.equal(JSON.stringify(reply).includes(A), false);
  assert.equal(reply.places[0].historicalUsage30d, 1, 'two public trips by one account on one day count once');
});

test('only effective public route points qualify; private/contact/placeholder text and unsigned picker labels cannot promote', t => {
  const { store: s } = fixture(t), viewer = enroll(s);
  const rejected = ['全部', '其他', '自选', '请选择出发地', 'TBD', 'Home apt 2', 'Room 305', '2单元', '555-123-4567',
    '微信：contact123', 'wechat someone', 'https://example.org/place', 'www.example.org', 'example.com', 'Building #12', 'bad\u007flabel'];
  for (const label of rejected) s.places.ingestBusiness(body(business(label)), now);
  const cancelled = business('Cancelled-only place'); cancelled.after.status = 'cancelled';
  s.places.ingestBusiness(body(cancelled, business('Joined-only place', { action: 'join' })), now);
  const selected = { eventId: randomUUID(), eventName: 'place_picker_selected', schemaVersion: 1, occurredAt: now,
    data: { pickerSessionId: randomUUID(), field: 'departure', mode: 'driver', cityKey: 'ny_nj', catalogVersion: 'places-v2',
      rankingVersion: 'circle-selection-v1', placeId: 'custom', source: 'custom', position: 0 } };
  const batch = { schemaVersion: 1, batchId: randomUUID(), events: [selected] };
  s.receive(viewer, Buffer.from(JSON.stringify(batch)), batch, now);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM place_catalog WHERE standard=0').get().n, 0);
  assert.equal(s.placeSuggestions(viewer, request, now).places.length, 0);
  s.places.ingestBusiness(body(business('800 Modern'), business('Terminal 4'), business('42nd Street Station')), now);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM place_catalog WHERE standard=0').get().n, 3, 'legitimate building and station numbers remain valid');
  assert.throws(() => s.places.ingestBusiness(body(business('bad\u0001label')), now), { code: 'INVALID_BUSINESS_EVENTS' });
});

test('automatic places retain publisher circles, city and synthetic isolation and the existing capped selection ranking', t => {
  const { store: s } = fixture(t), viewer = enroll(s), synthetic = enroll(s, 'fixture_place_synthetic_C', true);
  const old = now - 45 * DAY;
  for (const actor of [A, B]) {
    const outward = business('Fort Lee', { actorOpenid: actor, eventAtMs: old });
    const back = business('哥大', { actorOpenid: actor, eventAtMs: old + DAY }); back.after.destinations = [point('Fort Lee')];
    s.places.ingestBusiness(body(outward, back), old + 2 * DAY);
  }
  const publish = business('Modern800', { eventAtMs: old + 3 * DAY });
  s.places.ingestBusiness(body(publish), old + 4 * DAY);
  const poi = s.places.resolve('Modern800', 'ny_nj').place_id;
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT circle_ids FROM place_public_usage WHERE event_id=? AND place_id=?').get(publish.eventId, poi).circle_ids), ['columbia:fort_lee']);
  const reply = s.placeSuggestions(viewer, request, now);
  assert.equal(reply.places[0].source, 'circle'); assert.equal(reply.places[0].placeId, poi);
  assert.equal(s.placeSuggestions(synthetic, request, now).places.length, 0);
  assert.equal(s.placeSuggestions(viewer, { ...request, cityKey: 'boston' }, now).places.length, 0);
  for (let i = 0; i < 2; i++) {
    const batch = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(), eventName: 'place_picker_selected', schemaVersion: 1, occurredAt: now,
      data: { pickerSessionId: randomUUID(), field: 'departure', mode: 'driver', cityKey: 'ny_nj', catalogVersion: 'places-v2',
        rankingVersion: 'circle-selection-v1', placeId: poi, source: 'circle', position: 12 } }] };
    s.receive(viewer, Buffer.from(JSON.stringify(batch)), batch, now);
  }
  const voted = s.placeSuggestions(viewer, request, now + 300001);
  assert.equal(voted.rankingBasis, 'confirmed_selection'); assert.equal(voted.places[0].selectionCount30d, 1);
});

test('a trusted real legacy baseline promotes its public stop with the original service-date ranking clock', t => {
  const { store: s } = fixture(t), viewer = enroll(s), observed = now - 1000, service = now - 40 * DAY;
  const e = business('Legacy Station', { action: 'legacy_snapshot', source: 'legacy_snapshot', version: 0, eventAtMs: observed });
  e.after.tripVersion = 0; e.after.serviceDate = day(service); e.after.departureAtMs = service; e.after.latestDepartureAtMs = service;
  s.places.ingestBusiness(body(e), now);
  const poi = s.places.resolve('Legacy Station', 'ny_nj').place_id;
  const usage = s.db.prepare('SELECT * FROM place_public_usage WHERE place_id=?').get(poi);
  assert.equal(day(usage.occurred_at), day(service)); assert.equal(usage.evidence_at, observed);
  assert.equal(usage.source, 'legacy_snapshot');
  assert.equal(s.placeSuggestions(viewer, request, now).places[0].placeId, poi);
  assert.equal(s.db.prepare('SELECT event_hash FROM place_business_events WHERE event_id=?').get(e.eventId).event_hash, hash(JSON.stringify(e)));
});

function oldProjection(f) {
  const s = f.store, viewer = enroll(s);
  const batch = { schemaVersion: 1, batchId: randomUUID(), events: Array.from({ length: 20 }, () => ({
    eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: now, data: { page: 'home' } })) };
  const raw = Buffer.from(JSON.stringify(batch)); s.receive(viewer, raw, batch, now);
  assert.equal(s.db.prepare('SELECT codec FROM ingest_batches').get().codec, 'gzip');
  const e = business('Migration Museum'); s.places.ingestBusiness(body(e), now);
  const poi = s.places.resolve('Migration Museum', 'ny_nj').place_id;
  s.db.prepare('DELETE FROM place_public_usage WHERE place_id=?').run(poi);
  s.db.prepare('DELETE FROM place_aliases WHERE place_id=?').run(poi);
  s.db.prepare('DELETE FROM place_catalog WHERE place_id=?').run(poi);
  s.db.prepare("UPDATE place_candidates SET classification='pending' WHERE candidate_id=?").run(poi.slice(4));
  s.db.prepare("UPDATE place_membership_history SET origin_id='' WHERE event_id=?").run(e.eventId);
  const empty = s.placeSuggestions(viewer, request, now);
  s.db.pragma('user_version = 6'); s.db.pragma('wal_checkpoint(TRUNCATE)');
  const before = immutable(s); s.close(); f.store = null;
  return { e, poi, viewer, empty, before, batch, raw };
}

test('schema6 public projection backfill is atomic, byte-preserving and idempotent; historical snapshots are immutable', t => {
  const f = fixture(t), old = oldProjection(f);
  const s = f.store = openStore(f.path, { realEnabled: true });
  assert.equal(s.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(immutable(s), old.before);
  assert.equal(s.receive(old.viewer, old.raw, old.batch, now + 1).duplicate, true);
  assert.deepEqual(immutable(s), old.before, 'retry after upgrade preserves the original compressed bytes and receipts');
  assert.equal(s.db.prepare('SELECT origin_id FROM place_membership_history WHERE event_id=?').get(old.e.eventId).origin_id, old.poi);
  const usage = s.db.prepare('SELECT * FROM place_public_usage WHERE place_id=?').get(old.poi);
  assert.equal(usage.occurred_at, old.e.eventAtMs); assert.equal(usage.evidence_at, old.e.eventAtMs);
  assert.equal(s.placeSuggestions(old.viewer, request, now + 1).places[0].placeId, old.poi);
  const before = shared(s), facts = immutable(s);
  s.db.transaction(() => s.places.backfillPublicRoutes(now + 2)).immediate();
  assert.deepEqual(shared(s), before); assert.deepEqual(immutable(s), facts);
  s.close(); f.store = openStore(f.path, { realEnabled: true });
  assert.deepEqual(shared(f.store), before); assert.deepEqual(immutable(f.store), facts);
});

test('schema6 backup restores forward in quarantine without changing the backup or opening collection', t => {
  const f = fixture(t), old = oldProjection(f), sourceHash = hash(readFileSync(f.path)), target = join(f.dir, 'restored.sqlite');
  const result = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/restore-check.mjs', import.meta.url).pathname, f.path, target], { encoding: 'utf8' }));
  assert.equal(result.ok, true); assert.equal(result.restoreGate, 'closed'); assert.equal(hash(readFileSync(f.path)), sourceHash);
  const restored = openDatabase(target, { readonly: true });
  try {
    assert.equal(restored.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(restored.prepare('SELECT label FROM place_catalog WHERE place_id=?').get(old.poi).label, 'Migration Museum');
    assert.deepEqual(immutable({ db: restored }), old.before);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 0);
  } finally { restored.close(); }
});

test('corrupt historical business evidence aborts the projection upgrade and preserves the original schema and rows', t => {
  const f = fixture(t), old = oldProjection(f), db = openDatabase(f.path);
  db.prepare("UPDATE place_business_events SET event_hash='corrupt' WHERE event_id=?").run(old.e.eventId);
  const before = immutable({ db }), catalog = shared({ db }); db.close();
  assert.throws(() => openStore(f.path, { realEnabled: true }), { code: 'PLACE_BACKFILL_SOURCE_CONFLICT' });
  const check = openDatabase(f.path, { readonly: true });
  try { assert.equal(check.pragma('user_version', { simple: true }), 6); assert.deepEqual(immutable({ db: check }), before); assert.deepEqual(shared({ db: check }), catalog); }
  finally { check.close(); }
});

test('the bounded schema upgrade refuses excess history atomically instead of leaving a partially promoted catalog', t => {
  const f = fixture(t), s = f.store;
  const e = business('Capacity Museum');
  s.db.transaction(() => {
    const insert = s.db.prepare('INSERT INTO place_business_events VALUES (?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i <= 10000; i++) {
      const next = { ...e, eventId: `capacity_event_${i}`, tripId: `capacity_trip_${i}` }, payload = JSON.stringify(next);
      insert.run(0, next.eventId, hash(payload), next.tripId, next.tripType, next.version, next.eventAtMs, now, payload);
    }
    s.db.pragma('user_version = 6');
  }).immediate();
  const catalog = shared(s); s.close(); f.store = null;
  assert.throws(() => openStore(f.path, { realEnabled: true }), { code: 'PLACE_BACKFILL_CAPACITY' });
  const check = openDatabase(f.path, { readonly: true });
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 6); assert.deepEqual(shared({ db: check }), catalog);
    assert.equal(check.prepare('SELECT COUNT(*) n FROM place_business_events').get().n, 10001);
  } finally { check.close(); }
});
