const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const loadTelemetry = require('./helpers/load-ride-telemetry.cjs')
const tripManage = require('../utils/tripManage')

const names = ['myTripDetailPassenger', 'myTripRequestPassenger', 'myRequestDetailDriver', 'myTripDetailDriver']
const plain = value => JSON.parse(JSON.stringify(value))
function harness(name, type = /Request/.test(name) ? 'request' : 'carpool') {
  const events = [], clipboard = [], toasts = [], renderCallbacks = []
  const state = { scope: 'test:participant:grant', ok: true }
  const trip = { _id: 'trip_synthetic_1', _openid: '', driverOpenid: '', passengerID: [], passengers: [],
    referencePrice: '13$/人', availSeatNum: 2, status: 'open',
    departures: [{ address: 'Fort Lee private stop', date: '2026-09-25', time: '10:00' }],
    destinations: [{ address: 'Columbia private stop' }] }
  const wx = {
    getStorageSync: key => key === 'openid' ? 'viewer' : false,
    showToast: options => toasts.push(options),
    setClipboardData(options) { clipboard.push(options); return 'native-task' },
    cloud: { callFunction() { throw new Error('unexpected cloud lookup') } }
  }
  const helper = loadTelemetry({ getCollectionScope: () => state.scope,
    recordEvent(name, data) { events.push({ name, data: plain(data) }); return { ok: true } }
  }, { wx })
  let definition
  const filename = path.join(__dirname, '..', 'pages/profile', name, `${name}.js`)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value }, wx, setTimeout,
    console: { error() {}, warn() {} },
    require(moduleName) {
      if (moduleName.endsWith('rideTelemetry')) return helper
      if (moduleName.endsWith('tripManage')) return tripManage
      if (moduleName.endsWith('error')) return { showDataError() {} }
      if (moduleName.endsWith('tripDetailCache')) return {
        fetchTripDetail: async () => state.ok ? { ok: true, data: trip, openid: 'viewer' } : { ok: false },
        removeTripDetailCache() {}
      }
      throw new Error(`Unexpected dependency ${moduleName}`)
    }
  })
  const page = { ...definition, route: `pages/profile/${name}/${name}`, data: structuredClone(definition.data) }
  page.data.tripId = type === 'carpool' || name === 'myTripDetailPassenger' ? trip._id : undefined
  page.data.requestId = type === 'request' && name !== 'myTripDetailPassenger' ? trip._id : undefined
  page.data.sourceType = type
  page.setData = function (patch, done) { Object.assign(this.data, patch); if (done) renderCallbacks.push(done) }
  return { page, state, trip, events, clipboard, toasts,
    flushRender() { renderCallbacks.splice(0).forEach(done => done()) },
    load() { return type === 'request' && name !== 'myTripDetailPassenger'
      ? page.loadRequestDetail(trip._id) : page.loadTripDetail(trip._id, ...(name === 'myTripDetailPassenger' ? [type] : [])) }
  }
}

test('all rendered profile contact bindings preserve clipboard content and record only channel, role and result', () => {
  let paths = 0
  for (const name of names) {
    const template = fs.readFileSync(path.join(__dirname, '..', 'pages/profile', name, `${name}.wxml`), 'utf8')
    const h = harness(name)
    for (const tag of template.match(/<view\b[^>]*bindtap="(?:onCopyText|copyPassengerWechat|onCopyPhone)"[^>]*>/g) || []) {
      const method = /bindtap="([^"]+)"/.exec(tag)[1]
      const role = method === 'onCopyText' ? /data-target-role="([^"]+)"/.exec(tag)[1] : 'passenger'
      const channel = method === 'onCopyText' ? /data-channel="([^"]+)"/.exec(tag)[1]
        : method === 'onCopyPhone' ? 'phone' : 'wechat'
      assert.ok(['wechat', 'phone', 'zelle'].includes(channel))
      assert.ok(['driver', 'passenger'].includes(role))
      const content = `private-contact-${++paths}`
      const dataset = { text: ` ${content} `, wechat: ` ${content} `, phone: ` ${content} `, channel, targetRole: role }
      const start = h.events.length
      h.page[method]({ currentTarget: { dataset } })
      const native = h.clipboard.at(-1)
      assert.equal(native.data, content)
      native.success({ errMsg: 'setClipboardData:ok' })
      const recorded = h.events.slice(start)
      assert.deepEqual(recorded.map(item => item.data.outcome), ['attempt', 'success'])
      for (const event of recorded) {
        assert.equal(event.name, 'contact_action')
        assert.deepEqual(Object.keys(event.data).sort(), ['action', 'channel', 'outcome', 'targetRole', 'tripKey', 'tripType'])
        assert.equal(event.data.channel, channel)
        assert.equal(event.data.targetRole, role)
        assert.equal(event.data.tripKey, h.trip._id)
        assert.equal(event.data.tripType, h.page.data.sourceType)
      }
      assert.ok(!JSON.stringify(recorded).includes(content))
      assert.match(h.toasts.at(-1).title, /已复制/)
    }
  }
  assert.equal(paths, 14)
})

test('copy failures preserve original failure hints and empty contacts do not create events', () => {
  for (const name of names) {
    const h = harness(name)
    const method = name === 'myRequestDetailDriver' ? 'onCopyPhone' : 'onCopyText'
    const call = text => h.page[method]({ currentTarget: { dataset: { text, phone: text, channel: 'phone', targetRole: 'passenger' } } })
    call('')
    assert.equal(h.events.length, 0)
    assert.equal(h.clipboard.length, 0)
    call('private-phone')
    h.clipboard[0].fail({ errMsg: 'private native error' })
    assert.deepEqual(h.events.map(item => item.data.outcome), ['attempt', 'failure'])
    assert.equal(h.toasts.at(-1).title, '复制失败')
    assert.ok(!JSON.stringify(h.events).includes('private'))
  }
})

test('successful profile detail render records history once across refresh and hides late render callbacks', async () => {
  const cases = names.map(name => [name, /Request/.test(name) ? 'request' : 'carpool'])
  cases.push(['myTripDetailPassenger', 'request'])
  for (const [name, type] of cases) {
    const h = harness(name, type)
    h.page.onShow()
    await h.load()
    assert.equal(h.events.length, 0, `${name}: wait for rendering`)
    h.flushRender()
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].name, 'detail_viewed')
    assert.equal(h.events[0].data.source, 'history')
    assert.equal(h.events[0].data.tripType, type)
    assert.equal(h.events[0].data.referencePriceCents, 1300)
    assert.ok(!JSON.stringify(h.events).includes('private stop'))
    await h.load(); h.flushRender()
    assert.equal(h.events.length, 1, `${name}: refresh deduplicates`)
    await h.load(); h.page.onHide(); h.flushRender()
    assert.equal(h.events.length, 1, `${name}: hidden callback is not a view`)
    h.page.onShow()
    assert.equal(h.events.length, 2, `${name}: returning to detail is a new view`)
    h.page.onUnload()
    assert.equal(h.page._rideTelemetryHidden, true)
  }
})

test('failed detail reads never create successful render telemetry', async () => {
  for (const name of names) {
    const h = harness(name)
    h.state.ok = false
    h.page.onShow()
    await h.load(); h.flushRender()
    assert.equal(h.events.length, 0)
  }
})

test('a clipboard result completing under another account does not get attributed to that account', () => {
  const h = harness('myTripDetailPassenger')
  h.page.onCopyText({ currentTarget: { dataset: { text: 'private-phone', channel: 'phone', targetRole: 'driver' } } })
  h.state.scope = 'real:another_account:grant'
  h.clipboard[0].success({})
  assert.deepEqual(h.events.map(item => item.data.outcome), ['attempt'])
  assert.equal(h.toasts.at(-1).title, '已复制')
})
