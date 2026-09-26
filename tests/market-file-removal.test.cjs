const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const NOW = Date.parse('2026-09-26T16:00:00Z')
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])) }
  static now() { return NOW }
}
const image = 'cloud://test.bucket/market/shared.png'
const thumb = 'cloud://test.bucket/market_thumb/shared.png'
const replacement = 'cloud://test.bucket/market/new.png'

function fixture(options = {}) {
  const state = new Map(), writes = [], deletions = []
  const key = (collection, id) => `${collection}/${id}`
  const seed = (collection, id, data) => state.set(key(collection, id), structuredClone({ ...data, _id: id }))
  const read = (collection, id) => structuredClone(state.get(key(collection, id)))
  seed('market_goods', 'first', { _openid: 'seller', listingType: 'goods', title: 'Desk', price: 20,
    category: '家具', status: 'online', pickupStartDate: '2026-09-26', pickupEndDate: '2026-10-01',
    imageFileID: image, imageFileIDs: [image], thumbFileID: thumb, thumbFileIDs: [thumb] })
  seed('market_goods', 'second', { ...read('market_goods', 'first') })
  seed('MarketFiles', 'image', { _openid: 'seller', fileID: image, status: 'attached', goodsId: 'first' })
  seed('MarketFiles', 'thumb', { _openid: 'seller', fileID: thumb, status: 'attached', goodsId: 'first' })
  function collection(name) {
    return {
      doc(id) { return {
        async get() { return { data: read(name, id) || null } },
        async set({ data }) { seed(name, id, data); writes.push({ name, id, op: 'set' }); return {} },
        async update({ data }) {
          if (options.failListingWrite && name === 'market_goods') throw new Error('synthetic write failure')
          seed(name, id, { ...read(name, id), ...data }); writes.push({ name, id, op: 'update' })
          return { stats: { updated: 1 } }
        },
        async remove() {
          if (options.failListingWrite) throw new Error('synthetic write failure')
          state.delete(key(name, id)); writes.push({ name, id, op: 'remove' }); return { stats: { removed: 1 } }
        }
      } },
      where(condition) { return {
        async update({ data }) {
          if (options.failLedgerWrite) throw new Error('synthetic ledger failure')
          for (const [id, row] of state) {
            if (!id.startsWith(name + '/') || row._openid !== condition._openid || !condition.fileID.values.includes(row.fileID)) continue
            state.set(id, { ...row, ...structuredClone(data) }); writes.push({ name, id: row._id, op: 'mark' })
          }
          return {}
        }
      } }
    }
  }
  const db = { collection, command: { in: values => ({ values }) }, serverDate: () => new Date(NOW) }
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: options.openid ?? 'seller' }),
    async deleteFile(input) { deletions.push(input); return { fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) } }
  }
  const filename = path.resolve(__dirname, '../cloudfunctions/marketApi/index.js')
  const exports = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, require(name) {
      if (name === 'wx-server-sdk') return cloud
      if (name.startsWith('./')) return require(path.resolve(path.dirname(filename), name))
      return require(name)
    }, console: { error() {}, log() {} }, Date: Clock, Intl, Map, Set, Buffer, process
  }, { filename })
  return { main: exports.main, seed, read, writes, deletions }
}

test('deleting one of two listings preserves their shared original and thumbnail', async () => {
  const f = fixture(), remaining = f.read('market_goods', 'second')
  const result = await f.main({ action: 'delete', id: 'first' })
  assert.equal(result.ok, true)
  assert.equal(result.deletedFiles, 0)
  assert.equal(result.failedFiles.length, 0)
  assert.equal(f.read('market_goods', 'first'), undefined)
  assert.deepEqual(f.read('market_goods', 'second'), remaining)
  assert.deepEqual(f.deletions, [])
  assert.equal(f.read('MarketFiles', 'image').status, 'deleted')
  assert.equal(f.read('MarketFiles', 'thumb').status, 'deleted')
  assert.equal(f.writes[0].op, 'remove')
})

test('replacing images records removed references without deleting shared objects', async () => {
  const f = fixture(), remaining = f.read('market_goods', 'second')
  const result = await f.main({ action: 'update', id: 'first', patch: {
    imageFileID: replacement, imageFileIDs: [replacement], thumbFileID: '', thumbFileIDs: []
  } })
  assert.equal(result.ok, true)
  assert.equal(result.removedFiles, 2)
  assert.equal(result.deletedFiles, 0)
  assert.equal(result.failedFiles.length, 0)
  assert.equal(f.read('market_goods', 'first').imageFileID, replacement)
  assert.deepEqual(f.read('market_goods', 'second'), remaining)
  assert.deepEqual(f.deletions, [])
  assert.equal(f.read('MarketFiles', 'image').status, 'deleted')
  assert.equal(f.read('MarketFiles', 'thumb').status, 'deleted')
})

test('failed listing writes leave image records untouched', async () => {
  for (const action of ['delete', 'update']) {
    const f = fixture({ failListingWrite: true })
    await assert.rejects(f.main({ action, id: 'first', patch: {
      imageFileID: '', imageFileIDs: [], thumbFileID: '', thumbFileIDs: []
    } }), /synthetic write failure/)
    assert.ok(f.read('market_goods', 'first'))
    assert.equal(f.read('MarketFiles', 'image').status, 'attached')
    assert.equal(f.read('MarketFiles', 'thumb').status, 'attached')
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.deletions, [])
  }
})

test('ledger failure cannot turn a successful listing removal into physical deletion', async () => {
  const f = fixture({ failLedgerWrite: true })
  assert.equal((await f.main({ action: 'delete', id: 'first' })).ok, true)
  assert.equal(f.read('market_goods', 'first'), undefined)
  assert.ok(f.read('market_goods', 'second'))
  assert.equal(f.read('MarketFiles', 'image').status, 'attached')
  assert.deepEqual(f.deletions, [])
})

test('anonymous or other users cannot remove listings or mutate their file ledger', async () => {
  for (const openid of ['', 'other']) {
    for (const action of ['delete', 'update']) {
      const f = fixture({ openid })
      const result = await f.main({ action, id: 'first', patch: { title: 'Changed' } })
      assert.equal(result.ok, false)
      assert.equal(result.error, openid ? 'forbidden' : 'not_logged_in')
      assert.deepEqual(f.writes, [])
      assert.deepEqual(f.deletions, [])
    }
  }
})
