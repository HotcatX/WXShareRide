import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAds } from '../src/migration/ads.ts';
import type { MigrationIssue, UserRow } from '../src/migration/types.ts';

const createdAt = '2026-09-01T12:00:00.000Z';
const updatedAt = '2026-09-02T12:00:00.000Z';
const user: UserRow = { id: 'bfbf7e2b-a8b7-4d82-91bf-c03845325d1b', appId: 'ads-test', openid: 'fixture-user', name: 'Fixture', avatarUrl: '', profile: {}, createdAt, updatedAt };
const context = { appId: 'ads-test', users: [user] };
const image = 'cloud://fixture/market_ad/a.jpg';
const ad = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: 'fixture-ad', status: 'online', placement: 'market_feed', title: 'Fixture ad', subtitle: 'Fixture description',
  badgeText: '广告', ctaText: '查看', weight: 2, priority: 3, startAtMs: 0, endAtMs: 0,
  imageFileID: image, thumbFileID: image, targetType: 'contact', contactSessionFrom: 'fixture-source',
  contactMessageTitle: 'Message', contactMessagePath: '/pages/market/market?source=ad', showMessageCard: false,
  createTime: createdAt, updateTime: updatedAt, ...patch,
});
const event = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: 'fixture-click', _openid: user.openid, adId: 'fixture-ad', type: 'click', placement: 'market_feed', listingType: 'goods',
  createTime: { $date: updatedAt }, createTimeMs: Date.parse(updatedAt) - 50, ...patch,
});
function convert(input: { ads: unknown; events: unknown } = { ads: [ad()], events: [event()] }, ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = normalizeAds(input, ctx, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { ...result, issues, errors: issues.filter(issue => issue.severity === 'error') };
}
function rejects(input: { ads: unknown; events: unknown }, code?: string) {
  const result = convert(input); assert.ok(result.errors.length);
  if (code) assert.ok(result.errors.some(issue => issue.code === code), `Expected ${code}`);
  assert.deepEqual(result.ads, []); assert.deepEqual(result.events, []); assert.deepEqual(result.references, []);
}

test('contact ad preserves display, scheduling and customer-service semantics with one canonical target', () => {
  const input = { ads: [ad()], events: [event()] }, before = JSON.stringify(input), result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.ads.length, 1); assert.equal(result.events.length, 1);
  assert.deepEqual(result.ads[0], { id: 'fixture-ad', appId: context.appId, status: 'online', placement: 'market_feed',
    title: 'Fixture ad', subtitle: 'Fixture description', badgeText: '广告', ctaText: '查看', weight: 2, priority: 3,
    startAt: null, endAt: null, target: { kind: 'contact', sessionFrom: 'fixture-source',
      messageCard: { enabled: false, title: 'Message', path: '/pages/market/market?source=ad' } }, createdAt, updatedAt });
  assert.deepEqual(result.events[0], { id: 'fixture-click', appId: context.appId, adId: 'fixture-ad', type: 'click',
    placement: 'market_feed', listingType: 'goods', actorUserId: user.id, createdAt: updatedAt });
  assert.equal(JSON.stringify(input), before);
});

test('main and thumbnail are distinct slots even when sharing a locator, with no invented owner or upload time', () => {
  const result = convert(); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.references, [
    { appId: context.appId, resourceKind: 'ad', resourceId: 'fixture-ad', slot: 'image', locator: image },
    { appId: context.appId, resourceKind: 'ad', resourceId: 'fixture-ad', slot: 'thumbnail', locator: image },
  ]);
  for (const key of ['ownerUserId', 'adminOwnerKey', 'imageFileID', 'imageUrl', 'imageSrc', 'hasImage', 'targetType']) assert.equal(key in result.ads[0]!, false);
  assert.ok(result.references.every(ref => !('createdAt' in ref) && !('ownerUserId' in ref)));
});

test('orphan clicks and unmatched actors are retained without creating ads, users or successful contact claims', () => {
  const result = convert({ ads: [], events: [event({ _openid: 'unknown-person', adId: 'deleted-old-ad' }),
    event({ _id: 'second-click', _openid: '', listingType: 'sublet' })] });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.ads, []); assert.equal(result.events.length, 2);
  assert.equal(result.events[0]!.adId, 'deleted-old-ad'); assert.ok(result.events.every(row => row.actorUserId === null));
  assert.ok(result.issues.some(issue => issue.code === 'AD_EVENT_WITHOUT_CURRENT_AD' && issue.severity === 'notice'));
  assert.ok(result.issues.some(issue => issue.code === 'UNMATCHED_AD_EVENT_ACTOR_ARCHIVED'));
  assert.equal(JSON.stringify(result.events).includes('unknown-person'), false);
  assert.equal('completedContact' in result.events[0]!, false);
});

test('deleted and offline ads retain original state and historical image references', () => {
  for (const status of ['offline', 'deleted']) {
    const result = convert({ ads: [ad({ status })], events: [event()] });
    assert.deepEqual(result.errors, []); assert.equal(result.ads[0]!.status, status); assert.equal(result.references.length, 2);
  }
  for (const status of ['', 'removed', 'ONLINE', undefined]) {
    const row = ad({ status }); if (status === undefined) delete row.status;
    rejects({ ads: [row], events: [] }, 'UNSUPPORTED_AD_STATUS');
  }
});

test('only proven contact targets and click events are accepted; no fabricated impressions', () => {
  for (const targetType of ['page', 'web', 'miniProgram', 'serviceChat', 'copyWechat', 'none', null]) {
    rejects({ ads: [ad({ targetType })], events: [] }, 'UNSUPPORTED_AD_TARGET');
  }
  for (const type of ['view', 'impression', 'exposure', 'CLICK', 'contact_success']) {
    rejects({ ads: [ad()], events: [event({ type })] }, 'UNSUPPORTED_AD_EVENT_TYPE');
  }
  rejects({ ads: [ad({ targetExtraData: {} })], events: [] }, 'UNMAPPED_AD_FIELD');
  rejects({ ads: [ad({ imageUrl: 'https://fixture/image.jpg' })], events: [] }, 'UNMAPPED_AD_FIELD');
});

test('source timestamps remain exact; missing timestamps are nullable and server clock is not conflated with its ms companion', () => {
  const noTimes = ad(); delete noTimes.createTime; delete noTimes.updateTime;
  const click = event(); delete click.createTime; delete click.createTimeMs;
  const result = convert({ ads: [noTimes], events: [click] });
  assert.deepEqual(result.errors, []); assert.equal(result.ads[0]!.createdAt, null); assert.equal(result.ads[0]!.updatedAt, null); assert.equal(result.events[0]!.createdAt, null);
  const msOnly = event(); delete msOnly.createTime;
  const msResult = convert({ ads: [ad()], events: [msOnly] });
  assert.deepEqual(msResult.errors, []); assert.equal(msResult.events[0]!.createdAt, new Date(Date.parse(updatedAt) - 50).toISOString());
  assert.ok(msResult.issues.some(issue => issue.code === 'AD_EVENT_MILLISECOND_TIMESTAMP_USED'));
  const ordinary = convert(); assert.equal(ordinary.events[0]!.createdAt, updatedAt);
  assert.ok(ordinary.issues.some(issue => issue.code === 'AD_EVENT_DISTINCT_CLOCK_ARCHIVED'));
  rejects({ ads: [ad({ createTime: '2026-09-01' })], events: [] }, 'INVALID_AD_TIMESTAMP');
  rejects({ ads: [ad()], events: [event({ createTimeMs: '2026-09-01' })] }, 'INVALID_AD_TIMESTAMP');
});

test('timestamp aliases must agree while an inclusive ad scheduling endpoint is preserved', () => {
  const startAtMs = Date.parse(createdAt), endAtMs = Date.parse(updatedAt);
  const result = convert({ ads: [ad({ startAtMs, endAtMs, startAt: createdAt, endAt: updatedAt })], events: [] });
  assert.deepEqual(result.errors, []); assert.equal(result.ads[0]!.startAt, createdAt); assert.equal(result.ads[0]!.endAt, updatedAt);
  assert.deepEqual(convert({ ads: [ad({ startAtMs, endAtMs: startAtMs })], events: [] }).errors, []);
  rejects({ ads: [ad({ startAtMs, startAt: updatedAt })], events: [] }, 'CONFLICTING_AD_TIME_ALIASES');
  rejects({ ads: [ad({ startAtMs: endAtMs, endAtMs: startAtMs })], events: [] }, 'INVALID_AD_WINDOW');
  rejects({ ads: [ad({ startAtMs: String(startAtMs) })], events: [] }, 'INVALID_AD_TIMESTAMP');
  rejects({ ads: [ad({ updateTime: '2000-01-01T00:00:00Z' })], events: [] }, 'INVALID_AD_TIMESTAMP_ORDER');
});

test('bounded display and target values cannot be coerced or silently truncated', () => {
  for (const patch of [{ weight: 0 }, { weight: '2' }, { priority: null }, { showMessageCard: 'false' },
    { title: ' Leading space' }, { title: 'x'.repeat(1001) }, { contactMessagePath: '//other/path' },
    { contactMessagePath: 'https://other/path' }, { contactMessagePath: '/pages/other\\path' },
    { imageFileID: 'https://fixture/a.jpg' }, { imageFileID: 'cloud://fixture/market_ad/../a.jpg' }]) {
    rejects({ ads: [ad(patch)], events: [] });
  }
  const defaults = ad(); delete defaults.showMessageCard; delete defaults.contactMessageTitle;
  const result = convert({ ads: [defaults], events: [] });
  assert.deepEqual(result.errors, []); assert.equal(result.ads[0]!.target.messageCard.enabled, true);
  assert.equal(result.ads[0]!.target.messageCard.title, 'Fixture ad');
});

test('duplicate IDs, cross-app users and invalid references block the complete candidate set', () => {
  rejects({ ads: [ad(), ad()], events: [] }, 'INVALID_AD_ID');
  rejects({ ads: [ad()], events: [event(), event()] }, 'INVALID_AD_EVENT_ID');
  rejects({ ads: [ad()], events: [event({ adId: 'bad id' })] }, 'INVALID_AD_EVENT_ID');
  rejects({ ads: [ad()], events: [event({ _openid: 123 })] }, 'INVALID_AD_EVENT_ACTOR');
  rejects({ ads: [ad()], events: [event({ listingType: 'rental' })] }, 'INVALID_AD_EVENT_LISTING_TYPE');
  for (const users of [[user, user], [{ ...user, appId: 'other-app' }], [{ ...user, id: 'not-uuid' }]]) {
    const result = convert(undefined, { ...context, users }); assert.ok(result.errors.length); assert.deepEqual(result.ads, []);
  }
});

test('issues are controlled, unsafe JSON does not invoke accessors and no partial successful slice leaks through', () => {
  const result = convert({ ads: [ad({ 'private-field': 'private-value' })], events: [event()] });
  assert.ok(result.errors.some(issue => issue.code === 'UNMAPPED_AD_FIELD'));
  assert.equal(JSON.stringify(result.issues).includes('private-field'), false); assert.equal(JSON.stringify(result.issues).includes('private-value'), false);
  let invoked = false;
  const unsafe = event(); Object.defineProperty(unsafe, 'extra', { enumerable: true, get() { invoked = true; return 'private'; } });
  rejects({ ads: [ad()], events: [unsafe] }, 'INVALID_SOURCE_JSON'); assert.equal(invoked, false);
  rejects({ ads: [ad()], events: [event({ extra: undefined })] }, 'INVALID_SOURCE_JSON');
  rejects({ ads: {}, events: [] }, 'INVALID_AD_COLLECTION');
  assert.deepEqual(convert({ ads: [], events: [] }).errors, []);
});
