const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createHandler, makeSnapshot } = require('../cloudfunctions/statistics/sync')

const timer = { Type: 'Timer', TriggerName: 'publicStatsHourly' }
function setup(context = { SOURCE: 'wx_trigger' }) {
  const state = { reads: 0, sent: [], logs: [] }
  const deps = {
    getContext: () => context,
    getKey: () => Buffer.alloc(32, 1),
    readPublicStats: async () => { state.reads++; return { servedTrips: 8451, coverageText: 'NY / NJ', lastTripId: 'never-export' } },
    send: async snapshot => state.sent.push(snapshot), now: () => 1800000000000,
    log: entry => state.logs.push(entry)
  }
  return { state, deps, run: event => createHandler(deps)(event) }
}

test('only trusted timer source with exact trigger may read and sync', async () => {
  for (const context of [{ SOURCE: 'wx_client' }, { SOURCE: 'wx_trigger', OPENID: 'u' }, {}, undefined]) {
    const h = setup(context === undefined ? null : context)
    assert.equal((await h.run(timer)).error, 'TIMER_ONLY')
    assert.equal(h.state.reads, 0)
    assert.equal(h.state.sent.length, 0)
  }
  for (const event of [{}, { ...timer, TriggerName: 'other' }, { ...timer, Type: 'http' }]) {
    const h = setup(); assert.equal((await h.run(event)).error, 'TIMER_ONLY'); assert.equal(h.state.reads, 0)
  }
})

test('fresh acquisition projects only public fields with two-hour expiry and digest', async () => {
  const h = setup(); const result = await h.run(timer)
  assert.equal(result.ok, true)
  assert.equal(h.state.reads, 1)
  const s = h.state.sent[0]
  assert.deepEqual(s.data, { _id: 'home', servedTrips: 8451, coverageText: 'NY / NJ' })
  assert.equal(s.expiresAt - s.snapshotAt, 7200000)
  assert.equal(s.revision, crypto.createHash('sha256').update(JSON.stringify(s.data)).digest('hex'))
  assert.ok(!JSON.stringify(h.state).includes('never-export'))
})

test('source/key/transport errors cannot refresh snapshot or leak details', async () => {
  for (const fault of ['key', 'read', 'send']) {
    const h = setup()
    if (fault === 'key') h.deps.getKey = () => Buffer.alloc(1)
    if (fault === 'read') h.deps.readPublicStats = async () => { throw new Error('sensitive-detail') }
    if (fault === 'send') h.deps.send = async () => { throw new Error('sensitive-detail') }
    await assert.rejects(h.run(timer), /^Error: PUBLIC_STATS_SYNC_FAILED$/)
    assert.equal(h.state.sent.length, 0)
    assert.ok(!JSON.stringify(h.state.logs).includes('sensitive-detail'))
  }
})

test('normalization matches public API while unsafe values never leave CloudBase', () => {
  assert.equal(makeSnapshot({ servedTrips: '', coverageText: '' }, 1).data.servedTrips, null)
  assert.equal(makeSnapshot({ servedTrips: '12.9' }, 1).data.servedTrips, 12)
  for (const raw of [null, { servedTrips: Number.MAX_VALUE }, { coverageText: 'NY\nNJ' }, { coverageText: { private: true } }]) {
    assert.throws(() => makeSnapshot(raw, 1))
  }
})
