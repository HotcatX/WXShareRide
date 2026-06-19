// 云函数：updateCarpoolRequestStatus（只更新 CarpoolRequest，时间 + passengerCount）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 纽约时间偏移（非夏令时 -5；如需夏令时可改 -4）
const TZ_OFFSET_HOURS = -5

function makeDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null

  const [y, m, d] = String(dateStr).split('-').map(Number)
  const [hh, mm] = String(timeStr).split(':').map(Number)

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

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return []

  const out = []
  const seen = new Set()
  ids.forEach(id => {
    const value = String(id || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  })

  return out.slice(0, 100)
}

function getTargetIds(event = {}) {
  const values = []
  if (Array.isArray(event.ids)) values.push(...event.ids)
  if (event.id) values.push(event.id)
  if (event.tripId) values.push(event.tripId)
  if (event.requestId) values.push(event.requestId)

  return normalizeIds(values)
}

// CarpoolRequest 状态计算：时间优先，其次人数 passengerCount
// 规则：
// - diffMs > 6h => close
// - diffMs > 0  => past （不管原来 open/full）
// - diffMs <= 0 => 未到发车时间：passengerCount >= 4 => full，否则 open
function computeCarpoolRequestStatus(doc, now, thresholdMs) {
  const latest = getLatestDeparture(doc.departures || [])
  if (!latest) return { ok: false, reason: 'no-valid-time', latest: null, newStatus: null }

  const diffMs = now.getTime() - latest.getTime()
  const oldStatus = doc.status || 'open'
  let newStatus = oldStatus

  if (diffMs > thresholdMs) {
    newStatus = 'close'
  } else if (diffMs > 0) {
    newStatus = 'past'
  } else {
    const passengerCount = Number(doc.passengerCount || 0)
    newStatus = (passengerCount >= 4) ? 'full' : 'open'
  }

  return { ok: true, latest, diffMs, oldStatus, newStatus }
}

async function updateCarpoolRequestDocs(list, now, thresholdMs) {
  const collName = 'CarpoolRequest'
  let totalUpdated = 0
  const debug = []

  const updateTasks = []

  list.forEach(doc => {
    const _id = doc._id
    const result = computeCarpoolRequestStatus(doc, now, thresholdMs)

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
      passengerCount: doc.passengerCount,
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

  return { totalUpdated, debug }
}

async function scanAndUpdateCarpoolRequest(now, thresholdMs, ids = [], allowFullScan = false) {
  const collName = 'CarpoolRequest'
  const pageSize = 100

  if (ids.length > 0) {
    const res = await db.collection(collName)
      .where({ _id: _.in(ids) })
      .limit(ids.length)
      .get()

    return updateCarpoolRequestDocs(res.data || [], now, thresholdMs)
  }

  if (!allowFullScan) {
    return {
      totalUpdated: 0,
      debug: [],
      skipped: true,
      reason: 'ids-required'
    }
  }

  // Only scheduled/admin maintenance should opt into this branch with fullScan: true.
  // User-facing pages must pass ids and should never trigger a full collection scan.
  let skip = 0
  let totalUpdated = 0
  const debug = []

  while (true) {
    const res = await db.collection(collName).skip(skip).limit(pageSize).get()
    const list = res.data || []
    if (!list.length) break

    const result = await updateCarpoolRequestDocs(list, now, thresholdMs)
    totalUpdated += result.totalUpdated
    debug.push(...(result.debug || []))
    skip += pageSize
  }

  return { totalUpdated, debug }
}

exports.main = async (event, context) => {
  const now = new Date()
  const thresholdMs = 0.5 * 60 * 60 * 1000 // 0.5小时
  const ids = getTargetIds(event || {})
  const allowFullScan = !!(event && event.fullScan === true)

  const res = await scanAndUpdateCarpoolRequest(now, thresholdMs, ids, allowFullScan)

  return {
    ok: true,
    now: now.toISOString(),
    scope: ids.length > 0 ? 'ids' : (allowFullScan ? 'full' : 'none'),
    skipped: !!res.skipped,
    reason: res.reason || '',
    totalUpdatedCarpoolRequest: res.totalUpdated,
    debugCarpoolRequest: (res.debug || []).slice(0, 30)
  }
}
