const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { routeKey, readJoinAddresses, rememberJoinAddresses } = require('../utils/joinAddresses')

const addresses = { pickupAddress: 'Modern 800', dropoffAddress: '法学院' }
const route = (from = 'Fort Lee', to = '哥大', extra = {}) => ({
  _id: 'ride-1', _openid: 'driver', status: 'open', passengers: [], availSeatNum: 3,
  departures: [{ address: from, date: '2030-10-01', time: '15:00' }], destinations: [{ address: to }], ...extra
})
function storage() {
  const values = new Map([['openid', 'alice']])
  return { values, getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, structuredClone(value)) }
}

test('the last successful addresses follow the same account and directional route across dates and canonical aliases', () => {
  const api = storage()
  assert.equal(rememberJoinAddresses(route(), addresses, api), true)
  const nextWeek = route('fort lee', 'Columbia University', { _id: 'ride-next', cityKey: 'ny_nj' })
  nextWeek.departures[0].date = '2030-10-08'
  nextWeek.departures[0].time = '18:00'
  assert.deepEqual(readJoinAddresses(nextWeek, api), addresses)
  assert.equal(readJoinAddresses(route('哥大', 'Fort Lee'), api), null)
  assert.equal(readJoinAddresses(route('Fort Lee', 'JFK'), api), null)
  assert.equal(readJoinAddresses(route('Fort Lee', '哥大', { cityKey: 'boston' }), api), null)
  api.values.set('openid', 'bob')
  assert.equal(readJoinAddresses(route(), api), null)
  rememberJoinAddresses(route(), { pickupAddress: 'Fiat House', dropoffAddress: '主校区' }, api)
  api.values.set('openid', 'alice')
  assert.deepEqual(readJoinAddresses(route(), api), addresses)
  api.values.set('isGuest', true)
  assert.equal(readJoinAddresses(route(), api), null)
  assert.equal(rememberJoinAddresses(route(), addresses, api), false)
})

test('complete ordered routes are compared and custom addresses never collapse to unknown', () => {
  const api = storage(), trip = route('Custom Origin', 'Custom Destination')
  rememberJoinAddresses(trip, addresses, api)
  assert.deepEqual(readJoinAddresses(route(' Custom   Origin ', 'custom destination'), api), addresses)
  assert.equal(readJoinAddresses(route('Another Origin', 'Custom Destination'), api), null)
  trip.departures.push({ address: 'LIC', date: '2030-10-01', time: '16:00' })
  assert.equal(readJoinAddresses(trip, api), null)
  rememberJoinAddresses(trip, addresses, api)
  const reversedStops = structuredClone(trip); reversedStops.departures.reverse()
  assert.equal(readJoinAddresses(reversedStops, api), null)
  assert.equal(routeKey({ departures: [], destinations: [{ address: '哥大' }] }), '')
  assert.equal(routeKey(route('', '哥大')), '')
})

test('saving updates one route, trims valid input, bounds storage, and safely ignores corrupt or unavailable storage', () => {
  const api = storage()
  rememberJoinAddresses(route(), addresses, api)
  rememberJoinAddresses(route(), { pickupAddress: '  私议  ', dropoffAddress: ' 主校区 ' }, api)
  assert.deepEqual(readJoinAddresses(route(), api), { pickupAddress: '私议', dropoffAddress: '主校区' })
  for (const values of [{ pickupAddress: '', dropoffAddress: 'x' }, { pickupAddress: 'a'.repeat(61), dropoffAddress: 'x' }]) {
    assert.equal(rememberJoinAddresses(route(), values, api), false)
  }
  for (let i = 0; i < 35; i++) rememberJoinAddresses(route(`Origin ${i}`, 'Destination'), addresses, api)
  assert.equal([...api.values.values()].find(Array.isArray).length, 30)
  assert.equal(readJoinAddresses(route('Origin 0', 'Destination'), api), null)
  assert.deepEqual(readJoinAddresses(route('Origin 34', 'Destination'), api), addresses)
  const key = [...api.values.keys()].find(key => key.startsWith('rideJoinAddresses'))
  api.values.set(key, [{ route: routeKey(route()), pickupAddress: {}, dropoffAddress: 'a' }, null])
  assert.equal(readJoinAddresses(route(), api), null)
  const broken = { getStorageSync() { throw Error('storage unavailable') } }
  assert.equal(readJoinAddresses(route(), broken), null)
  assert.equal(rememberJoinAddresses(route(), addresses, broken), false)
})

function pageHarness() {
  const wx = storage(), state = { writes: [], result: { success: true }, notices: [], profile: null }
  wx.showToast = notice => state.notices.push(notice.title)
  wx.removeStorageSync = key => wx.values.delete(key)
  wx.stopPullDownRefresh = () => {}
  wx.showModal = () => {}
  wx.navigateTo = () => {}
  let definition
  const file = path.resolve(__dirname, '../pages/home/tripDetail/tripDetail.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { definition = value }, wx, console: { error() {}, warn() {} },
    getCurrentPages: () => [{}], setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name.endsWith('/compat/rides')) return { isBackendEnabled: () => true,
        async joinTrip(body) { state.writes.push(structuredClone(body)); if (state.throwJoin) throw Error('offline'); return { result: await state.result } } }
      if (name.endsWith('/compat/profile')) return {
        getUserInfo: async () => state.profile || { result: { data: [{ _openid: wx.getStorageSync('openid'), wechatID: 'valid' }] } },
        legacyDocument: () => ({})
      }
      if (name.endsWith('/rideTelemetry')) return { detailViewed() {} }
      if (name.endsWith('/tripManage')) return { ...require('../utils/tripManage'), markRideListStale() {} }
      if (name.endsWith('/tripDetailCache')) return {}
      return require(path.resolve(path.dirname(file), name))
    }
  })
  const page = { ...definition, data: structuredClone(definition.data), _detailAccount: 'user:alice' }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); callback?.() }
  page.loadTripDetail = async () => {}
  return { page, wx, state }
}

test('trip detail autofills once but never overwrites edits, intentional clearing, or a selected tag during refresh', () => {
  const { page, wx } = pageHarness()
  rememberJoinAddresses(route(), addresses, wx)
  page.applyTripData(route(), 'ride-1')
  assert.equal(page.data.pickupAddress, addresses.pickupAddress)
  assert.equal(page.data.dropoffAddress, addresses.dropoffAddress)
  page.onPickupInput({ detail: { value: '' } })
  page.onDropoffTagSelect({ currentTarget: { dataset: { value: ' 私议 ' } } })
  page.applyTripData(route(), 'ride-1')
  assert.equal(page.data.pickupAddress, '')
  assert.equal(page.data.dropoffAddress, '私议')

  const early = pageHarness()
  rememberJoinAddresses(route(), addresses, early.wx)
  early.page.onPickupInput({ detail: { value: 'My new lobby' } })
  early.page.applyTripData(route(), 'ride-1')
  assert.equal(early.page.data.pickupAddress, 'My new lobby')
  assert.equal(early.page.data.dropoffAddress, addresses.dropoffAddress)
})

test('changing accounts clears visible old instructions and loads only the new account memory', async () => {
  const { page, wx } = pageHarness()
  rememberJoinAddresses(route(), addresses, wx)
  page.applyTripData(route(), 'ride-1')
  page.onPickupInput({ detail: { value: 'Alice private edit' } })
  wx.values.set('openid', 'bob')
  const bob = { pickupAddress: 'Bob lobby', dropoffAddress: 'Bob gate' }
  rememberJoinAddresses(route(), bob, wx)
  await page.onShow()
  assert.equal(page.data.pickupAddress, '')
  assert.equal(page.data.dropoffAddress, '')
  page.applyTripData(route(), 'ride-1')
  assert.equal(page.data.pickupAddress, bob.pickupAddress)
  assert.equal(page.data.dropoffAddress, bob.dropoffAddress)
})

test('joining saves only successful confirmed instructions and keeps the submitted values stable while profile lookup waits', async () => {
  for (const outcome of ['success', 'rejected', 'offline']) {
    const { page, wx, state } = pageHarness()
    page.applyTripData(route(), 'ride-1')
    page.onPickupInput({ detail: { value: '  Modern 800 ' } })
    page.onDropoffInput({ detail: { value: ' 法学院 ' } })
    let resolveProfile
    state.profile = new Promise(resolve => { resolveProfile = resolve })
    if (outcome === 'rejected') state.result = { success: false }
    if (outcome === 'offline') state.throwJoin = true
    const pending = page.joinCarpool()
    page.onPickupInput({ detail: { value: 'Changed after tapping' } })
    resolveProfile({ result: { data: [{ wechatID: 'valid' }] } })
    await pending
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].passengerInfo.pickupAddress, addresses.pickupAddress)
    assert.equal(state.writes[0].passengerInfo.dropoffAddress, addresses.dropoffAddress)
    assert.deepEqual(readJoinAddresses(route(), wx), outcome === 'success' ? addresses : null)
  }
})

test('a failed storage write after a confirmed join never turns success into an error', async () => {
  const { page, wx, state } = pageHarness()
  page.applyTripData(route(), 'ride-1')
  page.setData(addresses)
  wx.setStorageSync = () => { throw Error('full') }
  await page.joinCarpool()
  assert.equal(page.data.hasJoined, true)
  assert.deepEqual(state.notices, ['加入成功'])
})

test('cancelled profile completion and a late response for a departed account never create address memory', async () => {
  const cancelled = pageHarness()
  cancelled.page.applyTripData(route(), 'ride-1')
  cancelled.page.setData(addresses)
  cancelled.state.profile = { result: { data: [{ wechatID: '' }] } }
  await cancelled.page.joinCarpool()
  assert.equal(cancelled.state.writes.length, 0)
  assert.equal(readJoinAddresses(route(), cancelled.wx), null)

  const late = pageHarness()
  late.page.applyTripData(route(), 'ride-1')
  late.page.setData(addresses)
  let finishJoin
  late.state.result = new Promise(resolve => { finishJoin = resolve })
  const pending = late.page.joinCarpool()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.state.writes.length, 1)
  late.wx.values.set('openid', 'bob')
  finishJoin({ success: true })
  await pending
  assert.equal(readJoinAddresses(route(), late.wx), null)
  late.wx.values.set('openid', 'alice')
  assert.equal(readJoinAddresses(route(), late.wx), null)
})
