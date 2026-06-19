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

const TZ_OFFSET_HOURS = -5

function makeDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const [hh, mm] = String(timeStr).split(':').map(Number)
  if (!y || !m || !d) return null
  const utcMs = Date.UTC(y, m - 1, d, (Number.isFinite(hh) ? hh : 0) - TZ_OFFSET_HOURS, Number.isFinite(mm) ? mm : 0, 0)
  const dt = new Date(utcMs)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function getFirstDepartureTime(doc = {}) {
  const dep = Array.isArray(doc.departures) && doc.departures.length ? doc.departures[0] : null
  if (!dep) return null
  return makeDate(dep.date, dep.time)
}

function normalizeVisibleStatus(doc = {}) {
  const status = String(doc.status || 'open').toLowerCase()
  if (status !== 'close') return status

  const tripTime = getFirstDepartureTime(doc)
  if (!tripTime || tripTime.getTime() <= Date.now()) return status

  return Number(doc.availSeatNum || 0) <= 0 ? 'full' : 'open'
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
        status: _.in(['open', 'full', 'close'])   // close 兼容旧版本误写的满员路线，返回前会过滤
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
    const data = (res.data || [])
      .map(item => {
        const visibleStatus = normalizeVisibleStatus(item)
        return visibleStatus === item.status ? item : { ...item, status: visibleStatus }
      })
      .filter(item => item.status === 'open' || item.status === 'full')

    return { success: true, data }

  } catch (err) {
    console.error(err)
    return { success: false, error: err }
  }
}
