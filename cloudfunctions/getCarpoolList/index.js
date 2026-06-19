// 云函数：getCarpoolList
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const COLLECTION = 'Carpool'
const VISIBLE_STATUSES = ['open', 'full']

function getLimit(event) {
  const n = Number(event && event.limit)
  if (!Number.isFinite(n) || n <= 0) return 80
  return Math.max(20, Math.min(100, Math.floor(n)))
}

function applyQuickFields(query, quick) {
  if (!quick) return query
  return query.field({
    _id: true,
    status: true,
    departures: true,
    destinations: true,
    availSeatNum: true,
    passengerCount: true,
    createdAt: true
  })
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value === 'close' || value === 'closed' ? 'past' : value
}

function mergeById(lists) {
  const map = new Map()
  ;(lists || []).forEach(list => {
    ;(list || []).forEach(item => {
      if (!item || !item._id) return
      if (!map.has(item._id)) map.set(item._id, item)
    })
  })
  return Array.from(map.values())
}

async function readList(query, errors, label) {
  try {
    const res = await query.get()
    return res.data || []
  } catch (e) {
    errors.push({
      label,
      errMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : 'query failed'
    })
    return []
  }
}

exports.main = async (event = {}) => {
  const db = cloud.database()
  const limit = getLimit(event)
  const quick = event.quick !== false
  const errors = []

  try {
    const orderedQueries = [
      ...VISIBLE_STATUSES.map(status => applyQuickFields(
        db.collection(COLLECTION)
          .where({ status })
          .orderBy('createdAt', 'desc')
          .limit(limit),
        quick
      )),
      applyQuickFields(
        db.collection(COLLECTION)
          .orderBy('createdAt', 'desc')
          .limit(limit),
        quick
      )
    ]

    let rows = mergeById(await Promise.all(
      orderedQueries.map((query, index) => readList(query, errors, `ordered_${index}`))
    ))

    // 如果 createdAt 排序因缺索引/旧数据失败，退回最基础的 status 等值查询。
    if (!rows.length) {
      const fallbackQueries = VISIBLE_STATUSES.map(status => applyQuickFields(
        db.collection(COLLECTION)
          .where({ status })
          .limit(limit),
        quick
      ))
      rows = mergeById(await Promise.all(
        fallbackQueries.map((query, index) => readList(query, errors, `fallback_${index}`))
      ))
    }

    const data = rows
      .map(item => {
        const status = normalizeTripStatus(item.status)
        return status === item.status ? item : { ...item, status }
      })
      .filter(item => {
        const status = normalizeTripStatus(item.status)
        return status === 'open' || status === 'full'
      })

    return {
      success: true,
      data,
      debug: event.debug ? {
        total: data.length,
        rawCount: rows.length,
        errors
      } : undefined
    }
  } catch (e) {
    console.error('getCarpoolList error:', e)
    return {
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '读取 Carpool 失败'
    }
  }
}
