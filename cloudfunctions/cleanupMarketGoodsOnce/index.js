const cloud = require("wx-server-sdk")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const GOODS_COLLECTION = "market_goods"
const FILES_COLLECTION = "MarketFiles"

function normalizeFileID(fileID) {
  const value = String(fileID || "").trim()
  return value.startsWith("cloud://") ? value : ""
}

function collectFileIDs(item = {}) {
  return Array.from(new Set([
    item.imageFileID,
    item.thumbFileID,
    ...(Array.isArray(item.imageFileIDs) ? item.imageFileIDs : []),
    ...(Array.isArray(item.thumbFileIDs) ? item.thumbFileIDs : [])
  ].map(normalizeFileID).filter(Boolean)))
}

async function deleteFiles(fileIDs, dryRun) {
  if (dryRun) return { deleted: [], failed: [] }
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
      chunk.forEach(fileID => failed.push({ fileID, errMsg: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "delete_failed" }))
    }
  }
  return { deleted, failed }
}

async function markFilesDeleted(fileIDs, dryRun, reason = "expired") {
  if (dryRun || !fileIDs.length) return
  try {
    for (let i = 0; i < fileIDs.length; i += 50) {
      const chunk = fileIDs.slice(i, i + 50)
      await db.collection(FILES_COLLECTION).where({ fileID: _.in(chunk) }).update({
        data: {
          status: "deleted",
          deleteReason: reason,
          deletedAt: db.serverDate(),
          updatedAt: db.serverDate(),
          updatedAtMs: Date.now()
        }
      })
    }
  } catch (e) {
    console.error("[cleanupMarketGoodsOnce] mark files deleted failed:", e)
  }
}

async function cleanupExpiredGoods({ nowMs, limit, dryRun }) {
  const res = await db.collection(GOODS_COLLECTION)
    .where({
      expireTime: _.lte(nowMs),
      status: _.neq("deleted")
    })
    .limit(limit)
    .get()

  const rows = res.data || []
  const fileIDs = Array.from(new Set(rows.flatMap(collectFileIDs)))

  const fileResult = await deleteFiles(fileIDs, dryRun)

  if (!dryRun) {
    for (const row of rows) {
      await db.collection(GOODS_COLLECTION).doc(row._id).remove().catch(e => {
        console.error("[cleanupMarketGoodsOnce] remove expired item failed:", row._id, e)
      })
    }
    await markFilesDeleted(fileIDs, dryRun, "expired_goods")
  }

  return {
    matched: rows.length,
    itemIds: rows.map(row => row._id),
    fileIDs,
    deletedFiles: fileResult.deleted.length,
    failedFiles: fileResult.failed
  }
}

function normalizeDateText(value) {
  const text = String(value || "").trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ""
}

async function cleanupLegacyGoods({ beforeDate, limit, dryRun }) {
  const dateText = normalizeDateText(beforeDate)
  if (!dateText) {
    return { matched: 0, itemIds: [], fileIDs: [], deletedFiles: 0, failedFiles: [], skipped: "legacyBeforeDate not set" }
  }

  const res = await db.collection(GOODS_COLLECTION)
    .where({
      postDate: _.lte(dateText)
    })
    .limit(limit)
    .get()

  const rows = (res.data || []).filter(row => {
    const status = String(row.status || "online").toLowerCase()
    return status !== "deleted" && status !== "sold"
  })
  const fileIDs = Array.from(new Set(rows.flatMap(collectFileIDs)))
  const fileResult = await deleteFiles(fileIDs, dryRun)

  if (!dryRun) {
    for (const row of rows) {
      await db.collection(GOODS_COLLECTION).doc(row._id).remove().catch(e => {
        console.error("[cleanupMarketGoodsOnce] remove legacy item failed:", row._id, e)
      })
    }
    await markFilesDeleted(fileIDs, dryRun, "legacy_goods")
  }

  return {
    beforeDate: dateText,
    matched: rows.length,
    itemIds: rows.map(row => row._id),
    fileIDs,
    deletedFiles: fileResult.deleted.length,
    failedFiles: fileResult.failed
  }
}

async function cleanupUnattachedFiles({ olderThanMs, limit, dryRun }) {
  let res
  try {
    res = await db.collection(FILES_COLLECTION)
      .where({
        status: "uploaded",
        createdAtMs: _.lte(olderThanMs)
      })
      .limit(limit)
      .get()
  } catch (e) {
    return { matched: 0, fileIDs: [], deletedFiles: 0, failedFiles: [], skipped: "MarketFiles collection not found or unreadable" }
  }

  const rows = res.data || []
  const fileIDs = Array.from(new Set(rows.map(row => normalizeFileID(row.fileID)).filter(Boolean)))
  const fileResult = await deleteFiles(fileIDs, dryRun)
  await markFilesDeleted(fileIDs, dryRun, "unattached_upload")

  return {
    matched: rows.length,
    fileIDs,
    deletedFiles: fileResult.deleted.length,
    failedFiles: fileResult.failed
  }
}

exports.main = async (event = {}) => {
  const dryRun = event.dryRun !== false
  const confirmed = event.confirm === "DELETE_EXPIRED_MARKET_GOODS"
  const limit = Math.max(1, Math.min(100, Number(event.limit) || 50))
  const unattachedHours = Math.max(1, Math.min(720, Number(event.unattachedHours) || 24))

  if (!dryRun && !confirmed) {
    return {
      ok: false,
      error: "missing_confirm",
      message: "Set confirm to DELETE_EXPIRED_MARKET_GOODS when dryRun is false."
    }
  }

  const nowMs = Date.now()
  const expiredGoods = await cleanupExpiredGoods({ nowMs, limit, dryRun })
  const legacyGoods = await cleanupLegacyGoods({
    beforeDate: event.legacyBeforeDate,
    limit,
    dryRun
  })
  const unattachedFiles = await cleanupUnattachedFiles({
    olderThanMs: nowMs - unattachedHours * 60 * 60 * 1000,
    limit,
    dryRun
  })

  return {
    ok: true,
    dryRun,
    nowMs,
    expiredGoods,
    legacyGoods,
    unattachedFiles,
    note: "This function only deletes files referenced by market_goods or MarketFiles. Old storage files that were never registered cannot be safely discovered by wx-server-sdk."
  }
}
