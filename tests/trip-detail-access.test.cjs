const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/getTripDetail/index.js'), 'utf8')

function harness({ actor = 'viewer', trip, blocks = [], failBlocks = false, failProfile = false, users,
  user = { _id: 'driver-profile', _openid: 'driver', phone: 'fixture' } }) {
  const reads = []
  const db = {
    command: { in: values => ({ $in: values }) },
    collection(name) {
      let condition = {}, fields, count = 100
      const query = {
        where(value) { condition = value; return query },
        field(value) { fields = value; return query },
        limit(value) { count = value; return query },
        async get() {
          reads.push({ name, condition, count, fields })
          if (name === 'UserBlocks' && failBlocks) throw new Error('database unavailable')
          if (name === 'userInfo' && failProfile) throw new Error('profile unavailable')
          const rows = name === 'UserBlocks' ? blocks : name === 'userInfo' ? (users || (user ? [user] : [])) : []
          const selected = rows.filter(row => Object.entries(condition).every(([key, value]) =>
            value && value.$in ? value.$in.includes(row[key]) : row[key] === value)).slice(0, count)
          return { data: selected.map(row => {
            if (!fields) return row
            const projected = {}
            for (const field of Object.keys(fields)) {
              if (!fields[field]) continue
              const parts = field.split('.')
              let value = row
              for (const part of parts) value = value && value[part]
              if (value === undefined) continue
              let target = projected
              for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {})
              target[parts.at(-1)] = value
            }
            return projected
          }) }
        },
        doc(id) { return { async get() { reads.push({ name, id }); return { data: trip } } } }
      }
      return query
    }
  }
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: actor }) }
  const context = { exports: {}, require(name) { assert.equal(name, 'wx-server-sdk'); return cloud }, console: { error() {} } }
  vm.runInNewContext(source, context)
  return { main: context.exports.main, reads, blockReads: () => reads.filter(row => row.name === 'UserBlocks') }
}

const carpool = () => ({ _id: 'trip', _openid: 'driver', passengers: ['p1', 'p2', 'p3', 'p4'].map(_openid => ({ _openid })) })
const request = () => ({ _id: 'trip', _openid: 'creator', driverOpenid: 'driver', passengerID: ['p1', 'p2', 'creator'] })
const block = (from, to, extra = {}) => ({ _id: `block-${from}-${to}`, _openid: from, targetOpenid: to, active: true, ...extra })

test('request participants receive legacy driver contact aliases in the canonical fields', async () => {
  for (const key of ['wechatID', 'wechatId', 'wechat']) {
    const h = harness({ actor: 'creator', trip: request(), user: { _openid: 'driver', nickName: 'Driver', [key]: 'driver-contact' } })
    const result = await h.main({ type: 'request', id: 'trip' })
    assert.equal(result.driverInfo.name, 'Driver')
    assert.equal(result.driverInfo.wechatID, 'driver-contact')
    const outsider = harness({ actor: 'visitor', trip: request(), user: { _openid: 'driver', [key]: 'driver-contact' } })
    assert.equal((await outsider.main({ type: 'request', id: 'trip' })).driverInfo, null)
  }
})

test('batch access checks preserve both blocking directions for every carpool and request member', async () => {
  for (const [type, trip, members] of [
    ['carpool', carpool(), ['driver', 'p1', 'p2', 'p3', 'p4']],
    ['request', request(), ['creator', 'driver', 'p1', 'p2']]
  ]) {
    for (const member of members) {
      for (const blocks of [[block('viewer', member)], [block(member, 'viewer')]]) {
        const h = harness({ trip, blocks })
        const result = await h.main({ type, id: 'trip' })
        assert.equal(result.blocked, true, `${type}/${member}`)
        assert.equal(result.data, undefined)
        assert.equal(result.driverInfo, undefined)
        assert.equal(result.driverStats, undefined)
        assert.equal(h.blockReads().length, 2)
        assert.equal(h.reads.some(read => read.name === 'userInfo' || read.name === 'TripRatings'), false)
      }
    }
  }
})

test('nonmembers without an active matching block need only two block reads and receive no driver contact', async () => {
  const h = harness({ trip: carpool(), blocks: [
    block('viewer', 'p4', { active: false }), block('unrelated', 'viewer'),
    block('viewer', 'unrelated'), { _id: 'legacy', blockerOpenid: 'p4', targetOpenid: 'viewer', active: true }
  ] })
  const result = await h.main({ id: 'trip' })
  assert.equal(result.ok, true)
  assert.equal(result.driverInfo, null)
  assert.equal(h.blockReads().length, 2)
  assert.equal(h.reads.length, 5) // trip, two directional block queries, ratings, public driver aggregates
})

test('existing participant access and anonymous/missing identity behavior are preserved', async () => {
  const member = harness({ actor: 'p4', trip: carpool(), blocks: [block('driver', 'p4')] })
  assert.equal((await member.main({ id: 'trip' })).driverInfo.phone, 'fixture')
  assert.equal(member.blockReads().length, 0)
  const anonymous = harness({ actor: '', trip: carpool(), blocks: [block('driver', 'viewer')] })
  const result = await anonymous.main({ id: 'trip' })
  assert.equal(result.ok, true)
  assert.equal(result.driverInfo, null)
  assert.equal(anonymous.reads.length, 2) // trip plus public driver aggregates; no private contact read
  const missing = harness({ trip: { _id: 'trip', passengers: [null, {}, { _openid: '' }] } })
  assert.equal((await missing.main({ id: 'trip' })).ok, true)
  assert.equal(missing.blockReads().length, 0)
})

test('batching checks legacy routes beyond the first chunk without truncating participants', async () => {
  const trip = { _id: 'trip', _openid: 'driver', passengers: Array.from({ length: 45 }, (_, i) => ({ _openid: `p${i}` })) }
  const h = harness({ trip, blocks: [block('p44', 'viewer')] })
  assert.equal((await h.main({ id: 'trip' })).blocked, true)
  assert.equal(h.blockReads().length, 6)
  assert.ok(h.blockReads().every(read => read.count === 1))
})

test('a failed access lookup fails closed instead of exposing a route', async () => {
  const h = harness({ trip: carpool(), failBlocks: true })
  const result = await h.main({ id: 'trip' })
  assert.equal(result.ok, false)
  assert.equal(result.data, undefined)
  assert.equal(result.driverInfo, undefined)
})

test('ordinary and anonymous carpool viewers receive only driver aggregate counts and ratings from one projected profile read', async () => {
  const rideStats = {
    completedDriverTrips: 12, completedPassengerTrips: 999,
    driverRatingCount: 3, driverRatingAvg: 4.2, driverRatingWeightedAvg: 4.7,
    passengerRatingAvg: 2.1, privateModerationNote: 'private'
  }
  for (const actor of ['viewer', '']) {
    const h = harness({ actor, trip: carpool(), user: {
      _openid: 'driver', phone: 'private-phone', wechatID: 'private-wechat', rideStats
    } })
    const result = await h.main({ id: 'trip' })
    assert.equal(result.ok, true)
    assert.equal(result.driverInfo, null)
    assert.deepEqual(JSON.parse(JSON.stringify(result.driverStats)), {
      completedDriverTrips: 12, driverRatingCount: 3, driverRatingAvg: 4.2, driverRatingWeightedAvg: 4.7
    })
    const profileReads = h.reads.filter(read => read.name === 'userInfo')
    assert.equal(profileReads.length, 1)
    assert.equal(profileReads[0].condition._openid, 'driver')
    assert.equal(profileReads[0].count, 1)
    assert.ok(Object.keys(profileReads[0].fields).every(field => /^rideStats\.(completedDriverTrips|driverRatingCount|driverRatingWeightedAvg|driverRatingAvg)$/.test(field)))
    assert.ok(!JSON.stringify(result).includes('private'))
  }
})

test('a joined viewer gets driver statistics from the existing contact query without a duplicate read', async () => {
  const h = harness({ actor: 'p4', trip: carpool(), user: {
    _openid: 'driver', phone: 'fixture', rideStats: { completedDriverTrips: 0, driverRatingCount: 0 }
  } })
  const result = await h.main({ id: 'trip' })
  assert.equal(result.driverInfo.phone, 'fixture')
  assert.equal(result.driverStats.completedDriverTrips, 0)
  assert.equal(result.driverStats.driverRatingCount, 0)
  assert.equal(h.reads.filter(read => read.name === 'userInfo').length, 1)
})

test('carpool Zelle disclosure follows the published route choice rather than the current profile default', async () => {
  for (const actor of ['p4', 'driver']) {
    for (const defaultShowZelle of [true, false]) {
      for (const zelle of ['yes', 'no', undefined, true]) {
        const h = harness({ actor, trip: { ...carpool(), zelle }, user: {
          _openid: 'driver', phone: 'fixture', zelleName: 'Payment name',
          zelleAccount: 'payment-account', defaultShowZelle
        } })
        const result = await h.main({ id: 'trip' })
        assert.equal(result.ok, true)
        assert.equal(result.driverInfo.phone, 'fixture')
        assert.equal(result.driverInfo.zelleName, zelle === 'yes' ? 'Payment name' : undefined)
        assert.equal(result.driverInfo.zelleAccount, zelle === 'yes' ? 'payment-account' : undefined)
        const reads = h.reads.filter(read => read.name === 'userInfo')
        assert.equal(reads.length, 1)
        assert.equal(reads[0].fields.zelleName, zelle === 'yes' ? true : undefined)
        assert.equal(reads[0].fields.zelleAccount, zelle === 'yes' ? true : undefined)
      }
    }
  }
})

test('changing carpool disclosure projection does not remove Zelle from a later opted-in route or request', async () => {
  const trip = { ...carpool(), zelle: 'no' }
  const h = harness({ actor: 'p1', trip, user: {
    _openid: 'driver', zelleName: 'Payment name', zelleAccount: 'payment-account', defaultShowZelle: false
  } })
  assert.equal((await h.main({ id: 'trip' })).driverInfo.zelleAccount, undefined)
  trip.zelle = 'yes'
  assert.equal((await h.main({ id: 'trip' })).driverInfo.zelleAccount, 'payment-account')
  Object.assign(trip, request(), { zelle: 'no' })
  assert.equal((await h.main({ type: 'request', id: 'trip' })).driverInfo.zelleAccount, 'payment-account')
})

test('missing and failed driver statistics do not block route details or invent a zero completion count', async () => {
  for (const options of [{ user: null }, { user: { _openid: 'driver' } }, { failProfile: true }]) {
    const h = harness({ trip: carpool(), ...options })
    const result = await h.main({ id: 'trip' })
    assert.equal(result.ok, true)
    assert.equal(result.data._id, 'trip')
    assert.equal(result.driverStats, null)
  }
  for (const value of [null, '', 'bad', -1, 1.2, true]) {
    const h = harness({ trip: carpool(), user: {
      _openid: 'driver', rideStats: { completedDriverTrips: value, driverRatingCount: -1, driverRatingAvg: 99 }
    } })
    const result = await h.main({ id: 'trip' })
    assert.equal(result.ok, true)
    assert.equal(result.driverStats.completedDriverTrips, null)
    assert.equal(result.driverStats.driverRatingCount, 0)
    assert.equal(result.driverStats.driverRatingAvg, 0)
  }
})

test('assigned request driver receives each passenger contact for a full group, including a missing legacy creator ID', async () => {
  const trip = { ...request(), status: 'full', passengerCount: 4, passengerID: ['p1', 'p1', 'p2', 'driver'] }
  const users = [
    { _openid: 'creator', nickName: 'Organizer', wechatId: 'organizer-contact', phone: 'fixture-phone',
      address: 'fixture pickup', zelleAccount: 'private-payment', admin: true,
      rideStats: { completedPassengerTrips: 4, passengerRatingAvg: 4.8, passengerRatingCount: 2, privateNote: 'hidden' } },
    { _openid: 'p1', name: 'Passenger 1', wechatID: 'p1-contact' },
    { _openid: 'p2', name: 'Passenger 2', wechat: 'p2-contact' },
    { _openid: 'unrelated', wechatID: 'private-unrelated' }
  ]
  const h = harness({ actor: 'driver', trip, users })
  const result = await h.main({ type: 'request', id: 'trip' })
  assert.equal(result.ok, true)
  assert.equal(result.passengerProfilesError, false)
  assert.deepEqual(Array.from(result.passengerProfiles, p => p._openid), ['creator', 'p1', 'p2'])
  assert.deepEqual(Array.from(result.passengerProfiles, p => p.wechatID), ['organizer-contact', 'p1-contact', 'p2-contact'])
  assert.equal(result.passengerProfiles[0].rideStats.completedPassengerTrips, 4)
  assert.equal(result.passengerProfiles[0].address, 'fixture pickup')
  assert.ok(!JSON.stringify(result.passengerProfiles).includes('private'))
  assert.ok(!JSON.stringify(result.passengerProfiles).includes('hidden'))
  assert.ok(!JSON.stringify(result.passengerProfiles).includes('admin'))
  const contactReads = h.reads.filter(r => r.name === 'userInfo' && r.condition._openid.$in)
  assert.equal(contactReads.length, 1)
  assert.equal(contactReads[0].fields.zelleAccount, undefined)
})

test('request contacts are gated by the trusted assigned driver, never by supplied identities, full status or group membership', async () => {
  for (const actor of ['', 'viewer', 'creator', 'p1', 'former-driver']) {
    const h = harness({ actor, trip: { ...request(), status: 'full', passengerCount: 4 } })
    const result = await h.main({ type: 'request', id: 'trip', openid: 'driver', driverOpenid: 'driver' })
    assert.equal(result.ok, true)
    assert.deepEqual(Array.from(result.passengerProfiles), [])
    assert.equal(result.passengerProfilesError, false)
    assert.ok(!h.reads.some(r => r.name === 'userInfo' && r.condition._openid.$in))
  }
  const h = harness({ actor: 'driver', trip: { ...request(), driverOpenid: '', status: 'full' } })
  assert.deepEqual(Array.from((await h.main({ type: 'request', id: 'trip' })).passengerProfiles), [])
})

test('request profile lookup failures keep the route and surface a retryable contact error, not an empty passenger group', async () => {
  const h = harness({ actor: 'driver', trip: request(), failProfile: true })
  const result = await h.main({ type: 'request', id: 'trip' })
  assert.equal(result.ok, true)
  assert.equal(result.data._id, 'trip')
  assert.equal(result.passengerProfilesError, true)
  assert.deepEqual(Array.from(result.passengerProfiles), [])
})

test('group seat count does not fabricate passenger accounts and missing profiles retain a contact placeholder', async () => {
  const h = harness({ actor: 'driver', trip: { ...request(), passengerCount: 4, passengerID: ['creator'] }, users: [] })
  const result = await h.main({ type: 'request', id: 'trip' })
  assert.equal(result.passengerProfiles.length, 1)
  assert.equal(result.passengerProfiles[0]._openid, 'creator')
  assert.equal(result.passengerProfiles[0].wechatID, '')
  assert.equal(result.passengerProfilesError, false)
})
