// cloudfunctions/updateUserAfterJoinTripPassenger/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const coll = db.collection('userInfo')

exports.main = async (event, context) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }

  const { tripId } = event || {}
  if (!tripId) return { ok: false, errorMsg: '缺少 tripId' }

  try {
    const res = await coll.where({ _openid: openid }).limit(1).get()

    // 这里保持你原逻辑：要求 userInfo 已存在（前端 join 前会检查）
    if (!res.data.length) {
      return { ok: false, errorMsg: '未找到用户信息，请先完善资料' }
    }

    const doc = res.data[0]

    // 已包含则直接返回，避免重复写入
    if (Array.isArray(doc.tripPassenger) && doc.tripPassenger.includes(tripId)) {
      return { ok: true, already: true }
    }

    const updateData = {
      updateTime: new Date(),
      role: 'passenger'
    }

    if (!Array.isArray(doc.tripPassenger)) {
      updateData.tripPassenger = [tripId]
    } else {
      updateData.tripPassenger = doc.tripPassenger.concat(tripId)
    }

    if (!Array.isArray(doc.tripDriver))           updateData.tripDriver = []
    if (!Array.isArray(doc.tripDriverHistory))    updateData.tripDriverHistory = []
    if (!Array.isArray(doc.tripPassengerHistory)) updateData.tripPassengerHistory = []

    await coll.doc(doc._id).update({ data: updateData })
    return { ok: true }

  } catch (e) {
    console.error('【updateUserAfterJoinTripPassenger】异常：', e)
    return { ok: false, errorMsg: e.message || '更新失败' }
  }
}
