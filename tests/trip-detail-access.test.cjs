const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/getTripDetail/index.js'), 'utf8')

function harness({ actor = 'viewer', trip, blocks = [], failBlocks = false }) {
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
          reads.push({ name, condition, count })
          if (name === 'UserBlocks' && failBlocks) throw new Error('database unavailable')
          const rows = name === 'UserBlocks' ? blocks : name === 'userInfo' ? [{ _id: 'driver-profile', _openid: 'driver', phone: 'fixture' }] : []
          const selected = rows.filter(row => Object.entries(condition).every(([key, value]) =>
            value && value.$in ? value.$in.includes(row[key]) : row[key] === value)).slice(0, count)
          return { data: selected.map(row => fields ? Object.fromEntries(Object.entries(row).filter(([key]) => fields[key])) : row) }
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
  assert.equal(h.reads.length, 4) // trip, two directional block queries, ratings
})

test('existing participant access and anonymous/missing identity behavior are preserved', async () => {
  const member = harness({ actor: 'p4', trip: carpool(), blocks: [block('driver', 'p4')] })
  assert.equal((await member.main({ id: 'trip' })).driverInfo.phone, 'fixture')
  assert.equal(member.blockReads().length, 0)
  const anonymous = harness({ actor: '', trip: carpool(), blocks: [block('driver', 'viewer')] })
  const result = await anonymous.main({ id: 'trip' })
  assert.equal(result.ok, true)
  assert.equal(result.driverInfo, null)
  assert.equal(anonymous.reads.length, 1)
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
