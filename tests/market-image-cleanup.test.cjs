const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const NOW = Date.UTC(2026, 8, 26, 12)
const DAY = 24 * 60 * 60 * 1000
const fileID = (name, folder = 'market') => `cloud://fixture-env.bucket/${folder}/${name}.jpg`
const tracked = (name, patch = {}) => ({ _id: `file-${name}`, fileID: fileID(name), goodsId: 'missing-goods',
  type: 'image', folder: 'market', status: 'attached', createdAtMs: NOW - 10 * DAY, updatedAtMs: NOW - 10 * DAY, ...patch })

function fixture({ goods = [{ _id: 'unrelated-goods' }], files = [], read } = {}) {
  const calls = { deleted: [], updated: [], reads: [] }
  const tables = { market_goods: goods, MarketFiles: files }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'fixture-env', init() {},
    database: () => ({
      command: { gt: value => ({ $gt: value }) },
      serverDate: () => ({ $date: NOW }),
      collection(name) {
        let offset = 0, count = 100, afterId = null
        const readRows = () => tables[name]
          .filter(row => afterId === null || row._id > afterId)
          .slice().sort((left, right) => left._id < right._id ? -1 : left._id > right._id ? 1 : 0)
          .slice(offset, offset + count)
        const query = {
          field() { return query },
          where(condition) {
            assert.deepEqual(Object.keys(condition), ['_id'])
            assert.deepEqual(Object.keys(condition._id), ['$gt'])
            afterId = condition._id.$gt
            assert.equal(typeof afterId, 'string')
            return query
          },
          orderBy(field, direction) { assert.equal(field, '_id'); assert.equal(direction, 'asc'); return query },
          skip(value) { offset = value; return query },
          limit(value) { count = value; return query },
          async get() {
            calls.reads.push({ name, offset, count, afterId })
            const rows = readRows()
            return read ? read({ name, offset, count, afterId, rows, readRows }) : { data: rows }
          },
          doc(id) { return { async update({ data }) { calls.updated.push({ id, data }); return {} } } }
        }
        return query
      }
    }),
    async deleteFile({ fileList }) {
      calls.deleted.push(...fileList)
      return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }
    }
  }
  class Clock extends Date { static now() { return NOW } }
  const sandbox = { exports: {}, require(name) { assert.equal(name, 'wx-server-sdk'); return cloud },
    Date: Clock, console: { log() {}, error() {} } }
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/cleanupMarketImages/index.js'), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'cleanupMarketImages/index.js' })
  return { calls, run: event => sandbox.exports.main(event) }
}

test('shared original and thumbnail remain protected even when marked deleted or removed', async () => {
  const original = fileID('shared'), thumb = fileID('shared-thumb', 'market_thumb')
  // Mirrors the exported relationship: the same two objects appear on three
  // independent listings, while the single-file ledger names only one.
  const goods = Array.from({ length: 3 }, (_, i) => ({ _id: `goods-${i}`, imageFileID: original,
    imageFileIDs: [original], thumbFileID: thumb, thumbFileIDs: [thumb] }))
  const f = fixture({ goods, files: [tracked('shared', { goodsId: 'goods-0', status: 'deleted' }),
    tracked('shared-thumb', { fileID: thumb, folder: 'market_thumb', type: 'thumb', goodsId: 'goods-0', status: 'removed' })] })
  const result = await f.run({})
  assert.equal(result.ok, true)
  assert.equal(result.cleanupBlocked, false)
  assert.equal(result.referencedFileCount, 2)
  assert.equal(result.skipped.stillReferenced, 2)
  assert.equal(result.deletedCount, 0)
  assert.deepEqual(f.calls.deleted, [])
  assert.deepEqual(f.calls.updated, [])
})

test('legacy reference fields protect files regardless of deletion-intent status', async () => {
  for (const field of ['image', 'imageUrl', 'thumbUrl', 'images', 'imageUrls', 'thumbs', 'thumbUrls']) {
    const id = fileID('legacy'), multiple = ['images', 'imageUrls', 'thumbs', 'thumbUrls'].includes(field)
    const f = fixture({ goods: [{ _id: 'goods-legacy', [field]: multiple ? [id] : id }], files: [tracked('legacy', { status: 'cleanup' })] })
    const result = await f.run({})
    assert.equal(result.skipped.stillReferenced, 1, field)
    assert.deepEqual(f.calls.deleted, [], field)
  }
})

test('a goods scan hitting the limit blocks all deletion even when later goods own the proposed orphan', async () => {
  const goods = Array.from({ length: 101 }, (_, i) => ({ _id: `goods-${String(i).padStart(3, '0')}`, ...(i === 100 ? { imageFileID: fileID('later-reference') } : {}) }))
  const f = fixture({ goods, files: [tracked('later-reference', { goodsId: 'goods-100', status: 'deleted' }), tracked('unreferenced')] })
  const result = await f.run({ maxScanDocs: 100 })
  assert.equal(result.ok, false)
  assert.equal(result.cleanupBlocked, true)
  assert.equal(result.blockReason, 'goods_scan_incomplete')
  assert.equal(result.scanned.goodsHitScanLimit, true)
  assert.equal(result.selectedCount, 0)
  assert.deepEqual(f.calls.deleted, [])
  assert.deepEqual(f.calls.updated, [])
})

test('a ledger scan hitting its limit also blocks the entire cleanup', async () => {
  const files = Array.from({ length: 101 }, (_, i) => tracked(`orphan-${i}`))
  const f = fixture({ files })
  const result = await f.run({ maxScanDocs: 100 })
  assert.equal(result.cleanupBlocked, true)
  assert.equal(result.blockReason, 'files_scan_incomplete')
  assert.equal(result.scanned.marketFilesHitScanLimit, true)
  assert.deepEqual(f.calls.deleted, [])
  assert.deepEqual(f.calls.updated, [])
})

test('exactly reaching the scan cap does not establish that there is no following page', async () => {
  const f = fixture({ goods: Array.from({ length: 100 }, (_, i) => ({ _id: `goods-${i}` })), files: [tracked('orphan')] })
  assert.equal((await f.run({ maxScanDocs: 100 })).cleanupBlocked, true)
  assert.deepEqual(f.calls.deleted, [])
})

test('deleting an earlier goods row between pages cannot hide a surviving image reference', async () => {
  const goods = Array.from({ length: 101 }, (_, i) => ({ _id: `goods-${String(i).padStart(3, '0')}`,
    ...(i === 100 ? { imageFileID: fileID('still-used') } : {}) }))
  let removed = false
  const f = fixture({ goods, files: [tracked('still-used', { goodsId: 'goods-100', status: 'deleted' })],
    read({ name, afterId, offset, rows, readRows }) {
      if (name === 'market_goods' && (afterId !== null || offset > 0) && !removed) {
        goods.shift()
        removed = true
        return { data: readRows() }
      }
      return { data: rows }
    } })
  const result = await f.run({})
  assert.equal(removed, true)
  assert.equal(goods.length, 100)
  assert.equal(goods.filter(row => row.imageFileID === fileID('still-used')).length, 1)
  assert.equal(result.scanned.goodsComplete, true)
  assert.equal(result.skipped.stillReferenced, 1)
  assert.equal(result.deletedCount, 0)
  assert.deepEqual(f.calls.deleted, [])
  assert.deepEqual(f.calls.updated, [])
  assert.deepEqual(f.calls.reads.filter(row => row.name === 'market_goods').map(row => row.afterId), [null, 'goods-099'])
})

test('deleting an earlier ledger row between pages cannot skip the final candidate', async () => {
  const files = Array.from({ length: 101 }, (_, i) => tracked(String(i).padStart(3, '0')))
  let removed = false
  const f = fixture({ files, read({ name, afterId, offset, rows, readRows }) {
    if (name === 'MarketFiles' && (afterId !== null || offset > 0) && !removed) {
      files.shift()
      removed = true
      return { data: readRows() }
    }
    return { data: rows }
  } })
  const result = await f.run({ dryRun: true })
  assert.equal(removed, true)
  assert.equal(result.scanned.marketFilesComplete, true)
  assert.equal(result.candidateCount, 101)
  assert.deepEqual(f.calls.reads.filter(row => row.name === 'MarketFiles').map(row => row.afterId), [null, 'file-099'])
})

test('keyset scan boundaries require an empty follow-up page after a full final page', async () => {
  for (const collection of ['market_goods', 'MarketFiles']) {
    for (const length of [99, 100, 101, 200]) {
      const rows = Array.from({ length }, (_, i) => ({ _id: `row-${String(i).padStart(3, '0')}` }))
      const f = fixture(collection === 'market_goods' ? { goods: rows } : { files: rows })
      const result = await f.run({ dryRun: true })
      assert.equal(result.ok, true, `${collection}: ${length}`)
      const reads = f.calls.reads.filter(row => row.name === collection)
      assert.equal(reads.length, Math.floor(length / 100) + 1)
      assert.deepEqual(reads.map(row => row.afterId), Array.from({ length: reads.length }, (_, i) =>
        i === 0 ? null : `row-${String(i * 100 - 1).padStart(3, '0')}`))
      assert.ok(reads.every(row => row.offset === 0))
    }
  }
})

test('non-increasing IDs within or across pages block both collection scans', async () => {
  for (const collection of ['market_goods', 'MarketFiles']) {
    for (const kind of ['within-page', 'repeated-cursor', 'earlier-page']) {
      const rows = Array.from({ length: 101 }, (_, i) => ({ _id: `row-${String(i).padStart(3, '0')}` }))
      const f = fixture({ goods: collection === 'market_goods' ? rows : undefined,
        files: collection === 'MarketFiles' ? rows : [tracked('orphan')],
        read({ name, afterId, rows }) {
          if (name !== collection) return { data: rows }
          if (kind === 'within-page' && afterId === null) return { data: [rows[1], rows[0]] }
          if (kind !== 'within-page' && afterId !== null) {
            return { data: [{ _id: kind === 'repeated-cursor' ? afterId : 'row-000' }] }
          }
          return { data: rows }
        } })
      const result = await f.run({})
      assert.equal(result.cleanupBlocked, true, `${collection}: ${kind}`)
      assert.equal(result.blockReason, collection === 'market_goods' ? 'goods_scan_incomplete' : 'files_scan_incomplete')
      assert.deepEqual(f.calls.deleted, [])
      assert.deepEqual(f.calls.updated, [])
    }
  }
})

test('page failures on either collection are fail-closed after earlier pages succeeded', async () => {
  for (const collection of ['market_goods', 'MarketFiles']) {
    const goods = Array.from({ length: 101 }, (_, i) => ({ _id: `goods-${i}` }))
    const files = Array.from({ length: 101 }, (_, i) => tracked(`orphan-${i}`))
    const f = fixture({ goods, files, read({ name, afterId, rows }) {
      if (name === collection && afterId !== null) throw new Error('simulated read failure')
      return { data: rows }
    } })
    const result = await f.run({})
    assert.equal(result.cleanupBlocked, true)
    assert.equal(result.selectedCount, 0)
    assert.deepEqual(f.calls.deleted, [])
    assert.deepEqual(f.calls.updated, [])
  }
})

test('missing, malformed, duplicate or oversized page responses never authorize cleanup', async () => {
  for (const collection of ['market_goods', 'MarketFiles']) {
    for (const response of [null, {}, { data: null }, { data: {} }, { data: [null] },
      { data: [{}] }, { data: [{ _id: 'duplicate' }, { _id: 'duplicate' }] },
      { data: Array.from({ length: 101 }, (_, i) => ({ _id: `overflow-${i}` })) }]) {
      const f = fixture({ files: [tracked('orphan', { status: 'deleted' })],
        read({ name, rows }) { return name === collection ? response : { data: rows } } })
      const result = await f.run({})
      assert.equal(result.cleanupBlocked, true)
      assert.deepEqual(f.calls.deleted, [])
      assert.deepEqual(f.calls.updated, [])
    }
  }
})

test('malformed image references mean the goods scan is incomplete', async () => {
  for (const patch of [{ imageFileID: {} }, { images: 'not-an-array' }, { thumbFileIDs: [{}] }]) {
    const f = fixture({ goods: [{ _id: 'goods', ...patch }], files: [tracked('orphan')] })
    assert.equal((await f.run({})).cleanupBlocked, true)
    assert.deepEqual(f.calls.deleted, [])
  }
})

test('complete scans delete only unreferenced market objects after their existing grace periods', async () => {
  const files = [tracked('old-deleted', { status: 'deleted', updatedAtMs: NOW - DAY }),
    tracked('young-deleted', { status: 'deleted', updatedAtMs: NOW - DAY + 1 }),
    tracked('old-orphan', { updatedAtMs: NOW - 3 * DAY }),
    tracked('young-orphan', { updatedAtMs: NOW - 3 * DAY + 1 }),
    tracked('old-pending', { goodsId: '', status: 'pending' }),
    tracked('already-cleaned', { status: 'cleaned' }),
    tracked('community', { fileID: fileID('community', 'community') }),
    tracked('admin', { fileID: fileID('admin', 'web-admin') })]
  const f = fixture({ files }), result = await f.run({})
  assert.equal(result.ok, true)
  assert.equal(result.scanned.goodsComplete, true)
  assert.equal(result.scanned.marketFilesComplete, true)
  assert.deepEqual(f.calls.deleted.sort(), ['old-deleted', 'old-orphan', 'old-pending'].map(name => fileID(name)).sort())
  assert.equal(result.markedCleaned, 3)
  assert.equal(f.calls.updated.length, 3)
  assert.ok(f.calls.updated.every(row => row.data.status === 'cleaned'))
})

test('dry-run retains candidate and statistics output without deleting or marking records', async () => {
  const f = fixture({ files: [tracked('orphan')] }), result = await f.run({ dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.candidateCount, 1)
  assert.equal(result.selectedCount, 1)
  assert.equal(result.deletedCount, 0)
  assert.equal(result.markedCleaned, 0)
  assert.deepEqual(f.calls.deleted, [])
  assert.deepEqual(f.calls.updated, [])
})

test('empty goods scans keep the existing conservative protection for attached files', async () => {
  const f = fixture({ goods: [], files: [tracked('orphan')] })
  const result = await f.run({})
  assert.equal(result.cleanupBlocked, false)
  assert.equal(result.skipped.emptyGoodsScanSafety, 1)
  assert.deepEqual(f.calls.deleted, [])
  const allowed = fixture({ goods: [], files: [tracked('orphan')] })
  assert.equal((await allowed.run({ allowEmptyGoodsCleanup: true })).deletedCount, 1)
})
