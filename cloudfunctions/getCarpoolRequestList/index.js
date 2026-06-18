// 云函数：getCarpoolRequestList
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function getLimit(event) {
  const n = Number(event && event.limit)
  if (!Number.isFinite(n) || n <= 0) return 80
  return Math.max(20, Math.min(100, Math.floor(n)))
}

exports.main = async (event = {}, context) => {
  try {
    const limit = getLimit(event)
    const quick = event.quick !== false

    // 页面会按出发时间重新排序；这里只取仍可展示的状态，避免复杂 or/nin + orderBy 查询超时。
    let query = db.collection('CarpoolRequest')
      .where({
        status: _.in(['open', 'full'])
      })

    if (quick) {
      query = query.field({
        _id: true,
        status: true,
        departures: true,
        destinations: true,
        passengerCount: true,
        requestPassengerCount: true,
        createdAt: true
      })
    }

    const res = await query.limit(limit).get()

    return {
      success: true,
      data: res.data || []
    }
  } catch (e) {
    console.error('getCarpoolRequestList error:', e)
    return { success: false, errorMsg: '读取 CarpoolRequest 失败' }
  }
}
