const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/getAddressList/index.js'), 'utf8')

function harness(rows = []) {
  const reads = []
  const cloud = {
    init() {},
    database: () => ({
      collection(name) {
        reads.push(name)
        return { async get() { return { data: structuredClone(rows) } } }
      }
    })
  }
  const context = { exports: {}, require(name) { assert.equal(name, 'wx-server-sdk'); return cloud }, console: { error() {} } }
  vm.runInNewContext(source, context)
  return { main: context.exports.main, reads }
}

test('address lookup rejects missing or malformed envelopes without querying a collection', async () => {
  const h = harness()
  for (const event of [undefined, null, {}, [], 'Departure', 1, false, { type: '' }, { type: null }]) {
    const result = await h.main(event)
    assert.equal(result.success, false)
    assert.equal(result.addressList, undefined)
  }
  assert.deepEqual(h.reads, [])
})

test('address lookup cannot read private or unknown collections through type', async () => {
  const h = harness([{ _id: 'private', secret: 'must-not-be-read' }])
  for (const type of ['userInfo', 'OperationReceipts', 'Notifications', 'market_goods', '__proto__', 'departure', 'Arrival ', {}, [], 7, true]) {
    const result = await h.main({ type })
    assert.equal(result.success, false)
    assert.equal(result.addressList, undefined)
  }
  assert.deepEqual(h.reads, [])
})

test('supported public address collections keep the original success and empty response shapes', async () => {
  for (const type of ['Departure', 'Arrival', 'Departure_Request', 'Arrival_Request']) {
    const h = harness([{ _id: 'addresses', first: 'Fort Lee', second: 'Columbia University' }])
    assert.deepEqual(JSON.parse(JSON.stringify(await h.main({ type }))), {
      success: true, id: 'addresses', addressList: ['Fort Lee', 'Columbia University']
    })
    assert.deepEqual(h.reads, [type])
    const empty = harness()
    assert.deepEqual(JSON.parse(JSON.stringify(await empty.main({ type }))), { success: false, message: `集合 ${type} 为空` })
    assert.deepEqual(empty.reads, [type])
  }
})
