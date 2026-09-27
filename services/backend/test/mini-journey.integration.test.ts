import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';
import { miniProgram } from './helpers/mini-program.ts';

const plain = (value: any) => JSON.parse(JSON.stringify(value));

test('real mini pages and compat modules complete a weekly ride, notifications and marketplace journey over loopback HTTP/PG',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase();
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const devices: ReturnType<typeof miniProgram>[] = [];
    t.after(async () => {
      devices.forEach(device => device.close());
      try { await app?.close(); } finally { await db.close(); }
    });
    const bridgeKey = randomBytes(32), appId = 'wx8a8a389199aa2a0e';
    app = await createApp({ pool: db.pool, config: { databaseUrl: '', host: '127.0.0.1', port: 0,
      appId, sessionTtlSeconds: 3600, businessMode: 'active', authBridgeKey: bridgeKey } });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const driver = miniProgram({ url, appId, bridgeKey, openid: 'synthetic-journey-driver' });
    const passenger = miniProgram({ url, appId, bridgeKey, openid: 'synthetic-journey-passenger' });
    const guest = miniProgram({ url, appId, bridgeKey });
    devices.push(driver, passenger, guest);
    const profile = driver.load('utils/compat/profile.js');
    await assert.rejects(profile.login(), { code: 'BACKEND_NOT_READY' });
    await Promise.all(devices.map(device => device.ready()));
    assert.ok(devices.every(device => device.authorityCalls() === 1));
    assert.equal(guest.bridgeCalls(), 0, 'public authority metadata does not log a guest in');
    const signedIn = (await profile.login()).result;
    assert.equal(signedIn.openid, 'synthetic-journey-driver');
    const updated = (await profile.updateUser({ name: 'Synthetic driver', wechatID: 'synthetic_driver_contact',
      carNumber: 'TEST-PLATE', carBrand: 'Test', carModel: 'Car', defaultShowZelle: false })).result.data;
    assert.equal(updated._id, signedIn.id);
    assert.equal((await profile.getUserInfo()).result.data[0].wechatID, 'synthetic_driver_contact');
    await passenger.load('utils/compat/profile.js').updateUser({ name: 'Synthetic passenger', wechatID: 'synthetic_passenger_contact' });
    const passengerId = (await passenger.load('utils/compat/profile.js').getUserInfo()).result.data[0]._id;
    const directory = await guest.load('utils/locationConfig.js').loadLocationConfig();
    assert.equal(directory.fixedPlaces[0].placeId, 'fort_lee'); assert.equal(guest.bridgeCalls(), 0);
    const rideTime = driver.load('utils/rideTime.js');
    const targetDate = rideTime.getRideDateTime(Date.now() + 2 * 86400000).date;
    const weekday = rideTime.getRideWeekday(targetDate), weekdayIndex = (weekday + 6) % 7;
    const weekdayText = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekdayIndex];

    // Invoke the actual editor's lifecycle and save handler, not its adapter
    // directly. Modal confirmation is the only native interaction simulated.
    const editor = driver.page('pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js');
    editor.onLoad({});
    await driver.until(() => !!editor.data.userInfo && !editor.data.loadingDepartureAddrs, 'template editor loaded through canonical routes');
    // Keep the next weekly occurrence beyond the 15-minute booking cutoff on
    // every day this test runs, without replacing the server's real clock.
    editor.setData({ departureAddress: 'Fort Lee', destinationAddress: '哥大', weekdayIndex, weekdayText,
      departureTime: '15:00', passengerCount: '3', referencePrice: '11-13$', comment: 'Weekly class' });
    editor.confirmTemplate();
    await driver.until(() => !!editor.data.templateId && !editor.data.submitting, 'template save and profile preferences completed');
    const templateId = editor.data.templateId;
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ride_templates')).rows[0].n, 1);
    const template = (await db.pool.query('SELECT weekday,local_time,definition FROM ride_templates WHERE id=$1', [templateId])).rows[0];
    assert.equal(template.weekday, weekday); assert.equal(template.local_time, '15:00');
    assert.equal(template.definition.listedPriceCents, null); assert.equal(template.definition.listedPriceLabel, '11-13$');

    const publish = driver.page('pages/home/newTrip/newTrip.js'); publish.onLoad({ mode: 'driver' });
    await driver.until(() => !!publish.data.userInfo && publish.data.templates.length === 1 && !publish.data.loadingUserInfo,
      'publish page loaded its actual saved template and owner profile');
    publish.onTemplateTap({ currentTarget: { dataset: { id: templateId } } });
    assert.equal(publish.data.departureTime, '15:00'); assert.equal(publish.data.referencePrice, '11-13$');
    const selectedDate = publish.data.departureDate;
    assert.equal(rideTime.getRideWeekday(selectedDate), weekday); assert.equal(selectedDate, targetDate);
    assert.ok(rideTime.parseRideDateTime(selectedDate, '15:00') > Date.now());
    await publish.confirmTrip();
    await driver.until(() => !!publish.data.publishedRide && !publish.data.submitting, 'confirmed page publication reached PostgreSQL');
    const rideId = publish.data.publishedRide.id;
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM rides')).rows[0].n, 1);
    const stored = (await db.pool.query('SELECT creator_id,listed_price_label,listed_price_cents,time_zone FROM rides WHERE id=$1', [rideId])).rows[0];
    assert.equal(stored.creator_id, signedIn.id); assert.equal(stored.listed_price_label, '11-13$');
    assert.equal(stored.listed_price_cents, null); assert.equal(stored.time_zone, 'America/New_York');
    assert.equal(driver.modals.at(-1).title, '确认新建路线');

    const guestRides = guest.load('utils/compat/rides.js'), rides = passenger.load('utils/compat/rides.js');
    const publicList = await guestRides.callTripList({ type: 'carpool', startDate: selectedDate,
      endDateExclusive: rideTime.shiftRideDate(selectedDate, 1) });
    assert.equal(publicList.result.data.carpool[0]._id, rideId);
    const publicDetail = await guestRides.getTripDetail('carpool', rideId);
    assert.equal(publicDetail.driverInfo, null);
    assert.ok(!JSON.stringify(publicDetail).includes('synthetic_driver_contact'));
    assert.ok(!JSON.stringify(publicDetail).includes('synthetic-journey-driver'));
    assert.equal(guest.bridgeCalls(), 0);
    await rides.joinTrip({ type: 'carpool', tripId: rideId, pickupAddress: 'Synthetic lobby', dropoffAddress: 'Synthetic gate' });
    const memberDetail = await rides.getTripDetail('carpool', rideId);
    assert.equal(memberDetail.viewer.role, 'passenger');
    assert.equal(memberDetail.driverInfo.userId, signedIn.id);
    assert.equal(memberDetail.driverInfo.wechatID, 'synthetic_driver_contact');
    assert.ok(memberDetail.participants.every((member: any) => !('_openid' in member)));
    assert.equal((await rides.getHomeTripList()).result.data.passenger.joinList.length, 1);

    const notices = driver.page('pages/profile/notification/notification.js'); notices.onLoad(); await notices.onShow();
    assert.equal(notices.data.unreadCount, 1); assert.equal(notices.data.list[0].type, 'passenger_joined');
    await notices.onTapItem({ currentTarget: { dataset: { id: notices.data.list[0]._id } } });
    assert.equal(notices.data.unreadCount, 0); assert.equal(driver.storage.get('customTabProfileBadge'), 0);
    await rides.callTripManage({ action: 'quitTrip', tripId: rideId, reason: 'Synthetic schedule change' });
    await notices.onShow();
    assert.equal(notices.data.unreadCount, 1); assert.equal(notices.data.list[0].type, 'passenger_left');
    await notices.onMarkAllRead(); assert.equal(notices.data.unreadCount, 0);
    assert.equal((await db.pool.query('SELECT state FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, passengerId])).rows[0].state, 'left');
    assert.equal((await rides.getTripDetail('carpool', rideId)).driverInfo, null, 'private contacts disappear after leaving');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM notifications WHERE read=false')).rows[0].n, 0);

    // Marketplace previously had VM/mocked adapter tests and server route
    // tests separately. Cross both with the real composed app and lost ACK.
    let market = driver.load('utils/compat/market.js');
    const payload = { listingType: 'goods', title: 'Synthetic desk', desc: 'Integration fixture only', price: '12.34', category: '家具', condition: 'Used',
      regionState: 'NJ', regionCounty: 'Fort Lee', regionArea: 'Fort Lee 核心区',
      pickupStartDate: selectedDate, pickupEndDate: rideTime.shiftRideDate(selectedDate, 1), imageFileIDs: [] };
    driver.failAfterCommit('POST', '/api/v1/market/listings');
    await assert.rejects(market.call({ data: { action: 'create', payload } }), { code: 'NETWORK_ERROR' });
    driver.restart(); await driver.ready(); market = driver.load('utils/compat/market.js');
    assert.equal(driver.authorityCalls(), 1, 'persisted server handoff never asks CloudBase to downgrade after restart');
    const recovered = (await market.call({ data: { action: 'create', payload: { ...payload, title: 'Changed uncertain input' } } })).result;
    assert.equal(recovered.recovered, true);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM market_listings')).rows[0].n, 1);
    const createRequests = driver.requests.filter(request => request.method === 'POST' && request.path === '/api/v1/market/listings');
    assert.equal(createRequests.length, 2); assert.equal(createRequests[0].key, createRequests[1].key);
    assert.deepEqual(createRequests[0].body, createRequests[1].body);
    const listingId = recovered.id;
    const publicMarket = guest.load('utils/compat/market.js');
    const listing = (await publicMarket.call({ data: { action: 'detail', id: listingId } })).result.item;
    assert.equal(listing.title, 'Synthetic desk'); assert.equal(listing.price, 12.34); assert.equal(listing.isOwner, false);
    assert.equal((await publicMarket.call({ data: { action: 'list', listingType: 'goods' } })).result.items[0].id, listingId);
    const changed = (await market.call({ data: { action: 'update', id: listingId, expectedVersion: recovered.version,
      patch: { ...payload, title: 'Updated after recovery' } } })).result;
    await assert.rejects(market.call({ data: { action: 'update', id: listingId, expectedVersion: recovered.version,
      patch: { ...payload, title: 'Stale editor' } } }), { code: 'LISTING_VERSION_CONFLICT' });
    assert.equal((await market.call({ data: { action: 'detail', id: listingId } })).result.item.title, 'Updated after recovery');
    await market.call({ data: { action: 'delete', id: listingId, expectedVersion: changed.version } });
    await assert.rejects(publicMarket.call({ data: { action: 'detail', id: listingId } }), { code: 'LISTING_NOT_FOUND' });

    assert.equal(guest.bridgeCalls(), 0); assert.equal(driver.bridgeCalls(), 1); assert.equal(passenger.bridgeCalls(), 1);
    assert.deepEqual((await db.pool.query('SELECT action FROM business_events ORDER BY created_at,id')).rows.map(row => row.action), ['created', 'joined', 'left']);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n, 2);
    assert.deepEqual(plain(driver.errors), []); assert.deepEqual(plain(passenger.errors), []);
    t.diagnostic(`${devices.reduce((sum, device) => sum + device.requests.length, 0)} actual loopback HTTP API requests; ` +
      '2 signed fixture logins; 3 actual Page controllers; synthetic PostgreSQL schema only');
  });
