// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

function getLimit(event) {
  const n = Number(event && event.limit)
  if (!Number.isFinite(n) || n <= 0) return 80
  return Math.max(20, Math.min(100, Math.floor(n)))
}

exports.main = async (event = {}, context) => {
  try {
    const db = cloud.database()
    const _ = db.command   // ← 需要这个才能用 _.in
    const limit = getLimit(event)
    const quick = event.quick !== false

    // 页面会按出发时间重新排序，这里不按 createdAt 排序，避免缺少组合索引时拖慢首屏。
    let query = db.collection('Carpool')
      .where({
        status: _.in(['open', 'full'])   // ← ⭐ 同时查 open + full
      })

    if (quick) {
      query = query.field({
        _id: true,
        status: true,
        departures: true,
        destinations: true,
        availSeatNum: true,
        passengerCount: true,
        createdAt: true
      })
    }

    const res = await query.limit(limit).get()

    return { success: true, data: res.data }

  } catch (err) {
    console.error(err)
    return { success: false, error: err }
  }
}
