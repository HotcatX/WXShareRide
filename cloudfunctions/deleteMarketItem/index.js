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
  const fileIDs = [
    item.imageFileID,
    item.thumbFileID,
    ...(Array.isArray(item.imageFileIDs) ? item.imageFileIDs : []),
    ...(Array.isArray(item.thumbFileIDs) ? item.thumbFileIDs : [])
  ].map(normalizeFileID).filter(Boolean)
  return Array.from(new Set(fileIDs))
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
      chunk.forEach(fileID => failed.push({ fileID, errMsg: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "delete_failed" }))
    }
  }
  return { deleted, failed }
}

async function markFilesDeleted(fileIDs, openid, goodsId) {
  if (!fileIDs.length) return
  try {
    for (let i = 0; i < fileIDs.length; i += 50) {
      const chunk = fileIDs.slice(i, i + 50)
      await db.collection(FILES_COLLECTION).where({
        fileID: _.in(chunk),
        _openid: openid
      }).update({
        data: {
          status: "deleted",
          deletedGoodsId: goodsId,
          deletedAt: db.serverDate(),
          updatedAt: db.serverDate(),
          updatedAtMs: Date.now()
        }
      })
    }
  } catch (e) {
    console.error("[deleteMarketItem] mark MarketFiles deleted failed:", e)
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const id = String((event && event.id) || "").trim()

  if (!id) return { ok: false, error: "missing_id" }

  const doc = await db.collection(GOODS_COLLECTION).doc(id).get().catch(() => null)
  const item = doc && doc.data
  if (!item || !item._id) return { ok: false, error: "not_found" }
  if (item._openid !== OPENID) return { ok: false, error: "forbidden" }

  const fileIDs = collectFileIDs(item)
  const fileResult = await deleteFiles(fileIDs)
  await markFilesDeleted(fileIDs, OPENID, id)

  await db.collection(GOODS_COLLECTION).doc(id).remove()

  return {
    ok: true,
    id,
    deletedFiles: fileResult.deleted.length,
    failedFiles: fileResult.failed
  }
}
