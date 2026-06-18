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

    // ✅ 新规则：只要 status != close/past 就展示
    // 同时兼容老数据：没有 status 字段的也展示（避免历史数据“消失”）
    const cond = _.or([
      { status: _.nin(['close', 'past']) },
      { status: _.exists(false) },
      { status: '' },
      { status: null }
    ])

    let query = db.collection('CarpoolRequest')
      .where(cond)
      .orderBy('createdAt', 'desc')

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

