const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const MARKET_FILES_COLLECTION = 'MarketFiles'
const MAX_PICKUP_MONTHS = 2

function normalizeFileID(fileID) {
  const value = String(fileID || '').trim()
  return value.startsWith('cloud://') ? value : ''
}

function uniqFileIDs(fileIDs) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function collectFileIDs(payload = {}) {
  return uniqFileIDs([
    payload.imageFileID,
    payload.thumbFileID,
    ...(Array.isArray(payload.imageFileIDs) ? payload.imageFileIDs : []),
    ...(Array.isArray(payload.thumbFileIDs) ? payload.thumbFileIDs : [])
  ])
}

function collectMarketFiles(payload = {}) {
  const files = []
  uniqFileIDs([payload.imageFileID, ...(Array.isArray(payload.imageFileIDs) ? payload.imageFileIDs : [])]).forEach(fileID => {
    files.push({ fileID, type: 'image', folder: 'market' })
  })
  uniqFileIDs([payload.thumbFileID, ...(Array.isArray(payload.thumbFileIDs) ? payload.thumbFileIDs : [])]).forEach(fileID => {
    files.push({ fileID, type: 'thumb', folder: 'market_thumb' })
  })
  const seen = new Set()
  return files.filter(file => {
    if (!file.fileID || seen.has(file.fileID)) return false
    seen.add(file.fileID)
    return true
  })
}

function marketFileDocId(fileID) {
  return crypto.createHash('sha1').update(String(fileID)).digest('hex')
}

async function attachMarketFiles(files, goodsId, openid) {
  if (!files.length || !goodsId || !openid) return
  const col = db.collection(MARKET_FILES_COLLECTION)
  const nowMs = Date.now()
  await Promise.all(files.map(file => {
    return col.doc(marketFileDocId(file.fileID)).set({
      data: {
        fileID: file.fileID,
        type: file.type || 'image',
        folder: file.folder || '',
        goodsId,
        status: 'attached',
        _openid: openid,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        attachedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    }).catch(e => {
      console.error('[updateMarketItem] attach MarketFiles failed:', e)
    })
  }))
}

async function markFilesDeleted(fileIDs, openid, goodsId) {
  if (!fileIDs.length) return
  try {
    for (let i = 0; i < fileIDs.length; i += 50) {
      const chunk = fileIDs.slice(i, i + 50)
      await db.collection(MARKET_FILES_COLLECTION).where({
        fileID: _.in(chunk),
        _openid: openid
      }).update({
        data: {
          status: 'deleted',
          deletedGoodsId: goodsId,
          deletedAt: db.serverDate(),
          updatedAt: db.serverDate(),
          updatedAtMs: Date.now()
        }
      })
    }
  } catch (e) {
    console.error('[updateMarketItem] mark MarketFiles deleted failed:', e)
  }
}

async function deleteRemovedFiles(fileIDs) {
  const deleted = []
  const failed = []
  for (let i = 0; i < fileIDs.length; i += 50) {
    const chunk = fileIDs.slice(i, i + 50)
    try {
      const res = await cloud.deleteFile({ fileList: chunk })
      ;(res.fileList || []).forEach(row => {
        if (row.status === 0) deleted.push(row.fileID)
        else failed.push({ fileID: row.fileID, status: row.status, errMsg: row.errMsg || '' })
      })
    } catch (e) {
      chunk.forEach(fileID => failed.push({ fileID, errMsg: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : 'delete_failed' }))
    }
  }
  return { deleted, failed }
}

function parseDateOnly(value) {
  const text = String(value || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

function formatDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== day) d.setDate(0)
  return d
}

function validatePickupWindow(patch = {}, oldItem = {}) {
  const today = startOfDay(new Date())
  const maxEnd = addMonths(today, MAX_PICKUP_MONTHS)
  const start = parseDateOnly(patch.pickupStartDate || oldItem.pickupStartDate) || today
  const end = parseDateOnly(patch.pickupEndDate || oldItem.pickupEndDate) || maxEnd

  if (end < start) return { ok: false, error: 'pickup_end_before_start' }
  if (end > maxEnd) return { ok: false, error: 'pickup_range_over_2_months' }

  const pickupStartDate = formatDateOnly(start)
  const pickupEndDate = formatDateOnly(end)
  return {
    ok: true,
    pickupStartDate,
    pickupEndDate,
    pickupRangeText: `${pickupStartDate} 至 ${pickupEndDate}`,
    expireTime: endOfDay(end).getTime(),
    expiresAtText: pickupEndDate
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { id, patch } = event || {}

  if (!id) return { ok: false, error: 'missing_id' }
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'missing_patch' }

  const oldRes = await db.collection('market_goods').doc(id).get().catch(() => null)
  const oldItem = oldRes && oldRes.data
  if (!oldItem || !oldItem._id) return { ok: false, error: 'not_found' }
  if (oldItem._openid !== OPENID) return { ok: false, error: 'forbidden' }

  const ALLOWED = new Set([
    'title',
    'price',
    'category',
    'region',
    'location',
    'condition',
    'desc',
    'imageFileID',
    'thumbFileID',
    'imageFileIDs',
    'thumbFileIDs',
    'hasImage',
    'pickupStartDate',
    'pickupEndDate',
    'pickupRangeText',
    'expireTime',
    'expiresAtText',
    'status'
  ])

  const safePatch = {}
  Object.keys(patch).forEach(k => {
    if (ALLOWED.has(k)) safePatch[k] = patch[k]
  })

  if (safePatch.price !== undefined) {
    const priceNum = Number(safePatch.price)
    if (Number.isNaN(priceNum) || priceNum < 0) return { ok: false, error: 'invalid_price' }
    safePatch.price = priceNum
  }

  if (safePatch.title !== undefined) safePatch.title = String(safePatch.title || '').trim()
  if (safePatch.title !== undefined && !safePatch.title) return { ok: false, error: 'missing_title' }

  const pickupWindow = validatePickupWindow(safePatch, oldItem)
  if (!pickupWindow.ok) return { ok: false, error: pickupWindow.error }

  Object.assign(safePatch, pickupWindow)

  const nextItem = { ...oldItem, ...safePatch }
  const nextImageFiles = uniqFileIDs([nextItem.imageFileID, ...(Array.isArray(nextItem.imageFileIDs) ? nextItem.imageFileIDs : [])])
  const nextThumbFiles = uniqFileIDs([nextItem.thumbFileID, ...(Array.isArray(nextItem.thumbFileIDs) ? nextItem.thumbFileIDs : [])])
  safePatch.imageFileID = nextImageFiles[0] || ''
  safePatch.imageFileIDs = nextImageFiles
  safePatch.thumbFileID = nextThumbFiles[0] || ''
  safePatch.thumbFileIDs = nextThumbFiles
  safePatch.hasImage = nextImageFiles.length > 0

  if (Object.keys(safePatch).length === 0) {
    return { ok: false, error: 'empty_patch' }
  }

  const oldFileIDs = collectFileIDs(oldItem)
  const nextFileIDs = collectFileIDs({ ...oldItem, ...safePatch })
  const nextSet = new Set(nextFileIDs)
  const removedFileIDs = oldFileIDs.filter(fileID => !nextSet.has(fileID))

  const res = await db.collection('market_goods').doc(id).update({
    data: {
      ...safePatch,
      updateTime: db.serverDate()
    }
  })

  await attachMarketFiles(collectMarketFiles({ ...oldItem, ...safePatch }), id, OPENID)
  const deleteResult = await deleteRemovedFiles(removedFileIDs)
  await markFilesDeleted(removedFileIDs, OPENID, id)

  return {
    ok: true,
    updated: res.stats.updated,
    removedFiles: removedFileIDs.length,
    deletedFiles: deleteResult.deleted.length,
    failedFiles: deleteResult.failed
  }
}
