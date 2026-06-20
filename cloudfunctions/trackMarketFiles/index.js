const cloud = require("wx-server-sdk")
const crypto = require("crypto")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COLLECTION = "MarketFiles"

function normalizeFileID(fileID) {
  const value = String(fileID || "").trim()
  return value.startsWith("cloud://") ? value : ""
}

function fileDocId(fileID) {
  return crypto.createHash("sha1").update(String(fileID)).digest("hex")
}

function normalizeFiles(files) {
  const seen = new Set()
  return (Array.isArray(files) ? files : [])
    .map(file => {
      if (typeof file === "string") return { fileID: normalizeFileID(file), type: "image" }
      return {
        fileID: normalizeFileID(file && file.fileID),
        type: String((file && file.type) || "image"),
        folder: String((file && file.folder) || "")
      }
    })
    .filter(file => {
      if (!file.fileID || seen.has(file.fileID)) return false
      seen.add(file.fileID)
      return true
    })
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const files = normalizeFiles(event && event.files)
  const status = String((event && event.status) || "uploaded")
  const goodsId = String((event && event.goodsId) || "")
  const nowMs = Date.now()

  if (!files.length) return { ok: true, count: 0 }

  const col = db.collection(COLLECTION)
  let successCount = 0
  const errors = []

  for (const file of files) {
    try {
      const docId = fileDocId(file.fileID)
      if (status === "uploaded") {
        const existing = await col.doc(docId).get().catch(() => null)
        const existingStatus = existing && existing.data && existing.data.status
        if (existingStatus === "attached" || existingStatus === "deleted") {
          successCount += 1
          continue
        }
      }

      await col.doc(docId).set({
        data: {
          fileID: file.fileID,
          type: file.type || "image",
          folder: file.folder || "",
          goodsId,
          status,
          _openid: OPENID,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      successCount += 1
    } catch (e) {
      errors.push({ fileID: file.fileID, message: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "unknown" })
    }
  }

  return { ok: errors.length === 0, count: successCount, errors }
}
