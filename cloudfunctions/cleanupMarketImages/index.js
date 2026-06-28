const cloud = require("wx-server-sdk")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const GOODS_COLLECTION = "market_goods"
const FILES_COLLECTION = "MarketFiles"
const MARKET_FOLDERS = new Set(["market", "market_thumb"])
const PAGE_SIZE = 100
const DEFAULT_ORPHAN_RETENTION_DAYS = 3
const DEFAULT_DELETED_RETENTION_DAYS = 1
const DEFAULT_MAX_DELETE = 200
const MAX_DELETE_LIMIT = 500

function normalizeText(value) {
  return String(value || "").trim()
}

function normalizeBoolean(value) {
  if (value === true || value === 1 || value === "1") return true
  return normalizeText(value).toLowerCase() === "true"
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function normalizeFileID(fileID) {
  const value = normalizeText(fileID)
  return value.startsWith("cloud://") ? value : ""
}

function getCloudPath(fileID) {
  const value = normalizeFileID(fileID)
  if (!value) return ""
  const index = value.indexOf("/", "cloud://".length)
  return index >= 0 ? value.slice(index + 1) : ""
}

function getStorageFolder(fileID) {
  const path = getCloudPath(fileID)
  const slash = path.indexOf("/")
  return slash >= 0 ? path.slice(0, slash) : ""
}

function isMarketImageFile(fileID) {
  return MARKET_FOLDERS.has(getStorageFolder(fileID))
}

function addFileID(set, value) {
  const fileID = normalizeFileID(value)
  if (fileID && isMarketImageFile(fileID)) set.add(fileID)
}

function addFileIDList(set, list) {
  ;(Array.isArray(list) ? list : []).forEach(item => addFileID(set, item))
}

function collectReferencedFileIDs(item = {}) {
  const set = new Set()
  addFileID(set, item.imageFileID)
  addFileID(set, item.thumbFileID)
  addFileIDList(set, item.imageFileIDs)
  addFileIDList(set, item.thumbFileIDs)

  // Legacy fields from older market implementations. Keep these references
  // protected if they still contain cloud storage IDs.
  addFileID(set, item.image)
  addFileID(set, item.imageUrl)
  addFileID(set, item.thumbUrl)
  addFileIDList(set, item.images)
  addFileIDList(set, item.imageUrls)
  addFileIDList(set, item.thumbs)
  addFileIDList(set, item.thumbUrls)

  return Array.from(set)
}

function readTimeMs(value) {
  if (!value) return 0
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === "object") {
    if (value.$date) return Number(value.$date) || 0
    if (typeof value.getTime === "function") return value.getTime()
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function getFileRecordTimeMs(row = {}) {
  const direct = Number(row.updatedAtMs || row.createdAtMs || row.createTimeMs)
  if (Number.isFinite(direct) && direct > 0) return direct

  const fromDate = readTimeMs(row.updatedAt || row.createdAt || row.updateTime || row.createTime)
  if (fromDate > 0) return fromDate

  const path = getCloudPath(row.fileID)
  const name = path.split("/").pop() || ""
  const prefix = Number((name.match(/^(\d{10,})/) || [])[1])
  return Number.isFinite(prefix) && prefix > 0 ? prefix : 0
}

function isOlderThan(row, nowMs, days) {
  const ts = getFileRecordTimeMs(row)
  if (!ts) return false
  return nowMs - ts >= days * 24 * 60 * 60 * 1000
}

async function readAllGoodsRefs(maxScanDocs) {
  const referenced = new Set()
  const goodsIds = new Set()
  let scanned = 0
  let skip = 0

  while (scanned < maxScanDocs) {
    const limit = Math.min(PAGE_SIZE, maxScanDocs - scanned)
    const res = await db.collection(GOODS_COLLECTION)
      .field({
        _id: true,
        imageFileID: true,
        thumbFileID: true,
        imageFileIDs: true,
        thumbFileIDs: true,
        image: true,
        imageUrl: true,
        thumbUrl: true,
        images: true,
        imageUrls: true,
        thumbs: true,
        thumbUrls: true
      })
      .skip(skip)
      .limit(limit)
      .get()

    const rows = res.data || []
    rows.forEach(item => {
      if (item && item._id) goodsIds.add(item._id)
      collectReferencedFileIDs(item).forEach(fileID => referenced.add(fileID))
    })

    scanned += rows.length
    if (rows.length < limit) break
    skip += rows.length
  }

  return { referenced, goodsIds, scanned, hitScanLimit: scanned >= maxScanDocs }
}

async function readTrackedFiles(maxScanDocs) {
  const rows = []
  let scanned = 0
  let skip = 0

  while (scanned < maxScanDocs) {
    const limit = Math.min(PAGE_SIZE, maxScanDocs - scanned)
    const res = await db.collection(FILES_COLLECTION)
      .field({
        _id: true,
        fileID: true,
        type: true,
        folder: true,
        goodsId: true,
        status: true,
        createdAtMs: true,
        updatedAtMs: true,
        createTimeMs: true,
        createdAt: true,
        updatedAt: true,
        createTime: true,
        updateTime: true
      })
      .skip(skip)
      .limit(limit)
      .get()

    const batch = res.data || []
    rows.push(...batch)
    scanned += batch.length
    if (batch.length < limit) break
    skip += batch.length
  }

  return { rows, scanned, hitScanLimit: scanned >= maxScanDocs }
}

function chooseCleanupCandidates(fileRows, context, options) {
  const nowMs = options.nowMs
  const referenced = context.referenced
  const goodsIds = context.goodsIds
  const canUseGoodsRefs = context.goodsScanned > 0 || normalizeBoolean(options.allowEmptyGoodsCleanup)
  const candidates = []
  const skipped = {
    nonMarketFile: 0,
    stillReferenced: 0,
    tooNew: 0,
    emptyGoodsScanSafety: 0,
    alreadyCleaned: 0
  }

  fileRows.forEach(row => {
    const fileID = normalizeFileID(row && row.fileID)
    if (!fileID || !isMarketImageFile(fileID)) {
      skipped.nonMarketFile += 1
      return
    }

    const status = normalizeText(row.status).toLowerCase()
    if (status === "cleaned") {
      skipped.alreadyCleaned += 1
      return
    }

    const deletedLike = status === "deleted" || status === "removed" || status === "cleanup"
    const retentionDays = deletedLike ? options.deletedRetentionDays : options.orphanRetentionDays
    if (!isOlderThan(row, nowMs, retentionDays)) {
      skipped.tooNew += 1
      return
    }

    let reason = ""
    if (deletedLike) {
      reason = "marked_deleted"
    } else if (referenced.has(fileID)) {
      skipped.stillReferenced += 1
      return
    } else if (!canUseGoodsRefs && status === "attached") {
      skipped.emptyGoodsScanSafety += 1
      return
    } else if (row.goodsId && goodsIds.has(row.goodsId)) {
      reason = "removed_from_goods"
    } else if (row.goodsId) {
      reason = "missing_goods"
    } else {
      reason = "unattached_orphan"
    }

    candidates.push({
      _id: row._id,
      fileID,
      status,
      goodsId: row.goodsId || "",
      reason,
      ageSourceMs: getFileRecordTimeMs(row)
    })
  })

  return { candidates, skipped }
}

async function deleteFiles(fileIDs) {
  const deleted = []
  const failed = []

  for (let i = 0; i < fileIDs.length; i += 50) {
    const chunk = fileIDs.slice(i, i + 50)
    try {
      const res = await cloud.deleteFile({ fileList: chunk })
      ;(res.fileList || []).forEach(row => {
        if (row.status === 0) deleted.push(row.fileID)
        else failed.push({ fileID: row.fileID, status: row.status, errMsg: row.errMsg || "" })
      })
    } catch (e) {
      chunk.forEach(fileID => {
        failed.push({ fileID, errMsg: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "delete_failed" })
      })
    }
  }

  return { deleted, failed }
}

async function markCleaned(candidates, deletedFileIDs) {
  const deletedSet = new Set(deletedFileIDs)
  const nowMs = Date.now()
  let updated = 0

  for (const item of candidates) {
    if (!item._id || !deletedSet.has(item.fileID)) continue
    await db.collection(FILES_COLLECTION).doc(item._id).update({
      data: {
        status: "cleaned",
        cleanupReason: item.reason,
        cleanedAt: db.serverDate(),
        updatedAt: db.serverDate(),
        updatedAtMs: nowMs
      }
    }).then(() => {
      updated += 1
    }).catch(e => {
      console.error("[cleanupMarketImages] mark cleaned failed:", item.fileID, e)
    })
  }

  return updated
}

exports.main = async (event = {}) => {
  const dryRun = normalizeBoolean(event.dryRun)
  const nowMs = Date.now()
  const orphanRetentionDays = clampNumber(event.orphanRetentionDays, DEFAULT_ORPHAN_RETENTION_DAYS, 1, 365)
  const deletedRetentionDays = clampNumber(event.deletedRetentionDays, DEFAULT_DELETED_RETENTION_DAYS, 0, 365)
  const maxDelete = clampNumber(event.maxDelete, DEFAULT_MAX_DELETE, 1, MAX_DELETE_LIMIT)
  const maxScanDocs = clampNumber(event.maxScanDocs, 5000, 100, 50000)

  const goods = await readAllGoodsRefs(maxScanDocs)
  const tracked = await readTrackedFiles(maxScanDocs)
  const picked = chooseCleanupCandidates(tracked.rows, {
    referenced: goods.referenced,
    goodsIds: goods.goodsIds,
    goodsScanned: goods.scanned
  }, {
    nowMs,
    orphanRetentionDays,
    deletedRetentionDays,
    allowEmptyGoodsCleanup: event.allowEmptyGoodsCleanup
  })

  const candidates = picked.candidates.slice(0, maxDelete)
  const fileIDs = candidates.map(item => item.fileID)
  const deleteResult = dryRun ? { deleted: [], failed: [] } : await deleteFiles(fileIDs)
  const markedCleaned = dryRun ? 0 : await markCleaned(candidates, deleteResult.deleted)

  const summary = {
    ok: true,
    dryRun,
    scanned: {
      goods: goods.scanned,
      marketFiles: tracked.scanned,
      goodsHitScanLimit: goods.hitScanLimit,
      marketFilesHitScanLimit: tracked.hitScanLimit
    },
    referencedFileCount: goods.referenced.size,
    candidateCount: picked.candidates.length,
    selectedCount: candidates.length,
    deletedCount: deleteResult.deleted.length,
    failedCount: deleteResult.failed.length,
    markedCleaned,
    retentionDays: {
      orphan: orphanRetentionDays,
      deleted: deletedRetentionDays
    },
    skipped: picked.skipped,
    candidates: candidates.slice(0, 20).map(item => ({
      fileID: item.fileID,
      status: item.status,
      goodsId: item.goodsId,
      reason: item.reason,
      ageSourceMs: item.ageSourceMs
    })),
    failed: deleteResult.failed.slice(0, 20)
  }

  console.log("[cleanupMarketImages] summary:", JSON.stringify(summary))
  return summary
}
