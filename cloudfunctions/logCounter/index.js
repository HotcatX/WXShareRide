const cloud = require("wx-server-sdk")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// event: { _id?: "LashAtelier", docId?: "LashAtelier", action: "enter" | "copyWechat" }
exports.main = async (event, context) => {
  const action = event?.action
  const docId = event?.docId || event?._id

  if (!action) return { ok: false, errMsg: "missing action" }

  const incData =
    action === "enter"
      ? { enterCount: _.inc(1) }
      : action === "copyWechat"
      ? { copyWechatCount: _.inc(1) }
      : action === "generateCoupon"
      ? { generateCouponCount: _.inc(1) }
      : null

  if (!incData) return { ok: false, errMsg: "invalid action" }

  const now = new Date()

  try {
    // 直接对指定 doc 自增
    await db.collection("Log").doc(docId).update({
      data: {
        ...incData,
        updatedAt: now
      }
    })
    return { ok: true }
  } catch (e) {
    // 如果文档不存在（或第一次），就创建
    try {
      await db.collection("Log").add({
        data: {
          _id: docId,
          enterCount: action === "enter" ? 1 : 0,
          copyWechatCount: action === "copyWechat" ? 1 : 0,
          updatedAt: now
        }
      })
      return { ok: true, created: true }
    } catch (e2) {
      return { ok: false, errMsg: e2.message || String(e2) }
    }
  }
}