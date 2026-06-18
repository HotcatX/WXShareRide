// 云函数：updateCarpoolStatus（只更新 Carpool）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 纽约时间偏移（非夏令时 -5；如需夏令时可改 -4）
const TZ_OFFSET_HOURS = -5

function makeDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null

  const [y, m, d] = String(dateStr).split('-').map(Number)
  const [hh, mm] = String(timeStr).split(':').map(Number)

  // 本地时间 = UTC + offset => UTC = 本地时间 - offset
  const utcMs = Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm, 0)
  const dt = new Date(utcMs)
  if (isNaN(dt.getTime())) return null
  return dt
}

function getLatestDeparture(departures = []) {
  let latest = null
  departures.forEach(d => {
    const dt = makeDate(d.date, d.time)
    if (!dt) return
    if (!latest || dt > latest) latest = dt
  })
  return latest
}

// Carpool 状态计算：时间优先，其次座位
function computeCarpoolStatus(doc, now, thresholdMs) {
  const latest = getLatestDeparture(doc.departures || [])
  if (!latest) return { ok: false, reason: 'no-valid-time', latest: null, newStatus: null }

  const diffMs = now.getTime() - latest.getTime()
  const oldStatus = doc.status || 'open'
  let newStatus = oldStatus

  // 1) 时间驱动（强制覆盖）
  if (diffMs > thresholdMs) {
    newStatus = 'close'
  } else if (diffMs > 0) {
    newStatus = 'past'
  } else {
    // 2) 未到时间：座位驱动
    const availSeatNum = Number(doc.availSeatNum || 0)
    newStatus = (availSeatNum <= 0) ? 'full' : 'open'
  }

  return { ok: true, latest, diffMs, oldStatus, newStatus }
}

async function scanAndUpdateCarpool(now, thresholdMs) {
  const collName = 'Carpool'
  const pageSize = 100
  let skip = 0

  let totalUpdated = 0
  const debug = []

  while (true) {
    const res = await db.collection(collName).skip(skip).limit(pageSize).get()
    const list = res.data || []
    if (!list.length) break

    const updateTasks = []

    list.forEach(doc => {
      const _id = doc._id
      const result = computeCarpoolStatus(doc, now, thresholdMs)

      if (!result.ok) {
        debug.push({
          coll: collName,
          id: _id,
          reason: result.reason,
          departures: doc.departures || []
        })
        return
      }

      const { latest, diffMs, oldStatus, newStatus } = result
      debug.push({
        coll: collName,
        id: _id,
        now: now.toISOString(),
        latest: latest.toISOString(),
        diffMs,
        diffHour: diffMs / (1000 * 60 * 60),
        availSeatNum: doc.availSeatNum,
        oldStatus,
        newStatus
      })

      if (newStatus === oldStatus) return

      updateTasks.push(
        db.collection(collName).doc(_id).update({
          data: { status: newStatus, updatedAt: now }
        })
      )
    })

    const updateRes = await Promise.all(updateTasks)
    totalUpdated += updateRes.length
    skip += pageSize
  }

  return { totalUpdated, debug }
}

exports.main = async (event, context) => {
  const now = new Date()
  const thresholdMs = 0.5 * 60 * 60 * 1000 // 0.5小时

  const res = await scanAndUpdateCarpool(now, thresholdMs)

  return {
    ok: true,
    now: now.toISOString(),
    totalUpdatedCarpool: res.totalUpdated,
    debugCarpool: (res.debug || []).slice(0, 30)
  }
}