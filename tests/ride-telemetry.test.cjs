const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-ride-telemetry.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
function harness() {
  const events = [], timers = new Map(), observers = [], clipboard = []
  let currentScope = 'test:participant_synthetic:1', counter = 0, time = Date.now()
  class Clock extends Date { static now() { return time } }
  const wx = { setClipboardData(options) { clipboard.push(options); return 'native-task' } }
  const analytics = { getCollectionScope: () => currentScope,
    makeEventId: () => `selection_synthetic_${++counter}`,
    recordEvent(name, data) { events.push({ name, data: plain(data) }); return { ok: true } },
    recordResults(data) { events.push({ name: 'result_set_rendered', data: plain(data) }); return { ok: true } } }
  const helper = load(analytics, { wx, Date: Clock, setTimeout(fn) { const id = ++counter; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) } })
  const page = { data: { hasMoreDays: false }, _analyticsVisible: true,
    createIntersectionObserver() {
      const observer = { disconnected: false, relativeTo() { return this }, observe(selector, fn) { this.callback = fn }, disconnect() { this.disconnected = true } }
      observers.push(observer); return observer
    } }
  const trip = { _id: 'business_trip_1', _type: 'carpool', referencePrice: '13$/人', availSeatNum: 2,
    departures: [{ date: '2026-09-24', time: '09:30', address: 'Fort Lee private address' }], destinations: [{ address: 'Columbia exact address' }] }
  const fire = (ratio, id = trip._id) => observers.at(-1).callback({ dataset: { id, type: 'carpool' }, intersectionRatio: ratio })
  const advance = () => { const list = [...timers.values()]; timers.clear(); list.forEach(fn => fn()) }
  return { helper, page, trip, events, timers, observers, clipboard, fire, advance,
    tick(ms) { time += ms }, setScope(value) { currentScope = value } }
}

test('snapshots retain reference price and business ID but exclude raw location and personal data', () => {
  const h = harness()
  h.helper.renderList(h.page, [{ items: [h.trip] }], { source: 'network' })
  const event = h.events[0]
  assert.equal(event.name, 'list_snapshot')
  assert.equal(event.data.candidates[0].tripKey, h.trip._id)
  assert.equal(event.data.candidates[0].referencePriceCents, 1300)
  assert.equal(event.data.candidates[0].priceKind, 'listed_reference')
  assert.equal(event.data.candidates[0].departureMinute, 570)
  assert.equal(event.data.candidates[0].originArea, 'fort_lee')
  assert.ok(!JSON.stringify(event).includes('private address'))
  assert.equal(h.events.filter(item => item.name === 'result_card_visible').length, 0)
})
test('visibility needs a continuous half-visible second, dedupes a result set and stops while hidden', () => {
  const h = harness()
  h.helper.renderList(h.page, [{ items: [h.trip] }])
  h.fire(0.75); assert.equal(h.timers.size, 1)
  h.fire(0.1); h.advance()
  assert.equal(h.events.length, 1)
  h.fire(0.5); h.advance(); h.fire(1); h.advance()
  assert.equal(h.events.filter(item => item.name === 'result_card_visible').length, 1)
  h.helper.renderList(h.page, [{ items: [h.trip] }])
  h.fire(1); h.helper.pageHidden(h.page); h.advance()
  assert.equal(h.events.filter(item => item.name === 'result_card_visible').length, 1)
  assert.equal(h.observers.at(-1).disconnected, true)
})
test('unchanged UI renders reuse the choice set and impressions without refreshing snapshot timestamps', () => {
  const h = harness(), groups = [{ items: [h.trip] }], options = { source: 'network', queryKey: 'same-filter' }
  const first = h.helper.renderList(h.page, groups, options)
  const sampledAt = h.events[0].data.candidates[0].snapshotAt
  h.fire(1); h.advance(); h.tick(5000)
  assert.equal(h.helper.renderList(h.page, groups, options), first)
  h.fire(1); h.advance()
  assert.deepEqual(h.events.map(event => event.name), ['list_snapshot', 'result_card_visible'])
  h.helper.clickTrip(h.page, h.trip._id, 'carpool', h.trip)
  assert.equal(h.events.at(-1).data.selectionSetId, first)
  assert.equal(h.events.at(-1).data.snapshotAt, sampledAt)
})
test('closing an unchanged overlay retains seen cards but interrupted visibility must start a new full second', () => {
  const h = harness(), groups = [{ items: [h.trip] }]
  const first = h.helper.renderList(h.page, groups)
  h.fire(1)
  h.page.data.placePickerVisible = true; h.helper.stopList(h.page)
  h.advance(); assert.equal(h.events.length, 1)
  h.page.data.placePickerVisible = false
  assert.equal(h.helper.renderList(h.page, groups), first)
  h.advance(); assert.equal(h.events.length, 1)
  h.fire(0.5); assert.equal(h.timers.size, 1)
  h.advance(); assert.equal(h.events.filter(event => event.name === 'result_card_visible').length, 1)
  h.page.data.placePickerVisible = true; h.helper.stopList(h.page)
  h.page.data.placePickerVisible = false; h.helper.renderList(h.page, groups)
  h.fire(1); h.advance()
  assert.equal(h.events.filter(event => event.name === 'result_card_visible').length, 1)
})
test('returning to a page and switching collection accounts retain distinct exposure opportunities', () => {
  const h = harness(), groups = [{ items: [h.trip] }]
  const first = h.helper.renderList(h.page, groups)
  h.fire(1); h.advance()
  h.helper.pageHidden(h.page)
  assert.equal(h.helper.renderList(h.page, groups), '')
  h.helper.pageVisible(h.page)
  const next = h.helper.renderList(h.page, groups)
  assert.notEqual(next, first)
  h.fire(1); h.advance()
  h.setScope('real:other_participant:2')
  assert.notEqual(h.helper.renderList(h.page, groups), next)
  h.fire(1); h.advance()
  assert.equal(h.events.filter(event => event.name === 'list_snapshot').length, 3)
  assert.equal(h.events.filter(event => event.name === 'result_card_visible').length, 3)
})
test('new explicit searches record a distinct result even when candidates are unchanged', () => {
  const h = harness(), groups = [{ items: [h.trip] }]
  const first = h.helper.renderList(h.page, groups)
  const search = h.helper.renderList(h.page, groups, { searchId: 'search_synthetic_1' })
  assert.notEqual(search, first)
  assert.equal(h.events.at(-1).name, 'result_set_rendered')
  assert.equal(h.events.at(-1).data.searchId, 'search_synthetic_1')
  assert.equal(h.helper.renderList(h.page, groups), search)
  assert.equal(h.events.length, 2)
})
test('real candidate, order, filter, freshness and completeness changes create new choice sets', () => {
  const cases = [
    ['price', h => { h.trip.referencePrice = '14' }],
    ['seats', h => { h.trip.availSeatNum = 1 }],
    ['business version', h => { h.trip.businessVersion = 2 }],
    ['server generation time', h => { h.trip.__dataGeneratedAt += 1 }],
    ['origin', h => { h.trip.departures[0].address = 'LIC' }],
    ['destination', h => { h.trip.destinations[0].address = 'JFK' }],
    ['departure time', h => { h.trip.departures[0].time = '10:30' }],
    ['service date', h => { h.trip.departures[0].date = '2026-09-25' }],
    ['candidate order', (h, groups) => { groups[0].items.reverse() }],
    ['filter semantics with identical results', (h, groups, options) => { options.queryKey = 'filter-B' }],
    ['cache versus network', (h, groups, options) => { options.source = 'network' }],
    ['more pages', h => { h.page.data.hasMoreDays = true }],
    ['invalid omitted candidate makes snapshot incomplete', (h, groups) => { groups[0].items.push({ _id: '!invalid!' }) }]
  ]
  for (const [name, change] of cases) {
    const h = harness(), groups = [{ items: [h.trip, { ...h.trip, _id: 'business_trip_2' }] }]
    h.trip.__dataGeneratedAt = Date.now() - 1000
    const options = { source: 'cache', queryKey: 'filter-A' }
    const first = h.helper.renderList(h.page, groups, options)
    change(h, groups, options)
    assert.notEqual(h.helper.renderList(h.page, groups, options), first, name)
    assert.equal(h.events.length, 2, name)
  }
})
test('changes past the 50-candidate payload limit still produce a new result and accurate visible-card attributes', () => {
  const h = harness(), trips = Array.from({ length: 55 }, (_, i) => ({ ...h.trip, _id: `trip_${i}` }))
  const groups = [{ items: trips }], first = h.helper.renderList(h.page, groups)
  const originalPayload = h.events[0].data.candidates
  trips[54].availSeatNum = 1
  assert.notEqual(h.helper.renderList(h.page, groups), first)
  assert.deepEqual(h.events[1].data.candidates, originalPayload)
  assert.equal(h.events[1].data.candidatesComplete, false)
  h.fire(1, 'trip_54'); h.advance()
  assert.equal(h.events.at(-1).data.availableSeats, 1)
  assert.equal(h.events.at(-1).data.selectionSetId, h.events[1].data.selectionSetId)
})
test('overlays and an account change invalidate pending impressions; clicks retain the selection link', () => {
  const h = harness()
  h.helper.renderList(h.page, [{ items: [h.trip] }])
  h.fire(1); h.page.data.refineFiltersVisible = true; h.advance()
  assert.equal(h.events.length, 1)
  h.page.data.refineFiltersVisible = false
  h.fire(1); h.setScope('test:other_participant:1'); h.advance()
  assert.equal(h.events.length, 1)
  h.setScope('test:participant_synthetic:1')
  h.helper.clickTrip(h.page, h.trip._id, 'carpool', h.trip)
  assert.equal(h.events.at(-1).data.selectionSetId, h.events[0].data.selectionSetId)
})
test('large result lists explicitly truncate snapshots while visible cards beyond 50 keep their own attributes', () => {
  const h = harness()
  const trips = Array.from({ length: 55 }, (_, i) => ({ ...h.trip, _id: `trip_${i}` }))
  h.helper.renderList(h.page, [{ items: trips }])
  assert.equal(h.events[0].data.candidates.length, 50)
  assert.equal(h.events[0].data.renderedCount, 55)
  assert.equal(h.events[0].data.candidatesComplete, false)
  h.fire(1, 'trip_54'); h.advance()
  assert.equal(h.events.at(-1).data.position, 54)
  assert.equal(h.events.at(-1).data.referencePriceCents, 1300)
})
test('detail cache and network refresh record once; a new visit records again; invalid dates never throw', () => {
  const h = harness(); h.page.data.routeExpired = false
  const trip = { ...h.trip, departures: [{ date: '2026-99-01' }], destinations: {} }
  h.helper.detailViewed(h.page, trip, 'carpool', 'list')
  h.helper.detailViewed(h.page, trip, 'carpool', 'list')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].data.serviceDate, undefined)
  h.helper.pageHidden(h.page); h.helper.detailViewed(h.page, trip, 'carpool', 'list')
  assert.equal(h.events.length, 1)
  h.helper.pageVisible(h.page); h.helper.detailViewed(h.page, trip, 'carpool', 'list')
  assert.equal(h.events.length, 2)
})
test('contact tracks copy success only, never clipboard content, and preserves callback receiver/arguments', () => {
  const h = harness(); h.page.data.tripId = h.trip._id
  let received, receiver
  const options = { success(...args) { received = args; receiver = this; return 9 } }
  assert.equal(h.helper.copyContact(h.page, 'private-contact', 'wechat', 'driver', options), 'native-task')
  const native = { native: true }
  assert.equal(h.clipboard[0].success.call(native, 'one', 'two'), 9)
  assert.deepEqual(received, ['one', 'two']); assert.equal(receiver, native)
  assert.deepEqual(h.events.map(event => event.data.outcome), ['attempt', 'success'])
  assert.ok(!JSON.stringify(h.events).includes('private-contact'))
  h.helper.copyContact(h.page, 'secret', 'phone', 'driver')
  h.setScope('real:changed:1'); h.clipboard[1].success({})
  assert.equal(h.events.length, 3)
})
test('price parsing leaves absent, range, invalid and arbitrary text unknown while preserving explicit zero', () => {
  const helper = load()
  for (const text of ['', '请参考打车价格', '$8–13', '姓名13', '13.001', '-1', 'NaN']) assert.deepEqual(plain(helper.referencePrice({ referencePrice: text })), {})
  assert.equal(helper.referencePrice({ referencePrice: '0' }).referencePriceCents, 0)
})

test('a displayed detail is recorded when identity becomes ready, without crossing an account switch', () => {
  let currentScope = '', listener, openid = 'viewer_a', unsubscribed = false
  const events = []
  const helper = load({ getCollectionScope: () => currentScope,
    subscribe(fn) { listener = fn; fn({ participating: false }); return () => { unsubscribed = true } },
    recordEvent(name, data) { events.push({ name, data }); return { ok: true } }
  }, { wx: { getStorageSync: key => key === 'openid' ? openid : false } })
  const page = { data: {} }, trip = { _id: 'business_trip', referencePrice: '8' }
  helper.detailViewed(page, trip, 'carpool', 'share')
  assert.equal(events.length, 0)
  currentScope = 'test:viewer_a:1'; listener({ participating: true })
  assert.equal(events.length, 1)
  listener({ participating: true }); assert.equal(events.length, 1)
  openid = 'viewer_b'; currentScope = 'test:viewer_b:1'; listener({ participating: true })
  assert.equal(events.length, 1)
  helper.pageHidden(page); assert.equal(unsubscribed, true)
})

test('expanded place snapshots retain stop order and true source acquisition age without private labels', () => {
  const h = harness()
  const trip = { ...h.trip, businessVersion: 7, __dataGeneratedAt: 1800000000000,
    departures: [{ address: 'LIC' }, { address: 'Apartment 5A' }], destinations: [{ address: 'EWR 机场' }, { address: 'JSQ' }] }
  const data = h.helper.snapshot(trip, 1800000010000)
  assert.deepEqual(plain(data.originPlaceIds), ['lic', 'custom'])
  assert.deepEqual(plain(data.destinationPlaceIds), ['ewr', 'jsq'])
  assert.equal(data.tripVersion, 7)
  assert.equal(data.dataGeneratedAt, 1800000000000)
  assert.equal(data.snapshotAt, 1800000010000)
  assert.equal(data.dataTimeSource, 'server')
  assert.equal(h.helper.snapshot(h.trip).dataTimeSource, 'unknown')
  assert.equal(h.helper.snapshot(h.trip).dataGeneratedAt, undefined)
  assert.equal(JSON.stringify(data).includes('Apartment'), false)
  assert.equal(h.helper.coarseArea('Newark'), 'other')
  assert.equal(h.helper.coarseArea('EWR Terminal C'), 'ewr')
  assert.equal(h.helper.coarseArea('Long Island'), 'other')
  assert.equal(h.helper.coarseArea('Long Island City'), 'lic')
})
