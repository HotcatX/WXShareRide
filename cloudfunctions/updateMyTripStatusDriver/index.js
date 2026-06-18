// 云函数：updateMyTripStatusDriver
// 作用：刷新司机端 userInfo.tripDriver（Carpool）和 userInfo.tripDriverJoin（CarpoolRequest）
// 规则：以第一个 departures 的时间为准，超过 6 小时迁移到 history；
//      对过期且 status=open 的记录：
//        - CarpoolRequest：open -> close
//        - Carpool：open -> close

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 纽约时间（UTC-5）
const TZ_OFFSET_HOURS = -5

function makeDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null
  const parts1 = String(dateStr).split('-').map(Number)
  const parts2 = String(timeStr).split(':').map(Number)
  if (parts1.length !== 3 || parts2.length < 2) return null

  const [y, m, d] = parts1
  const [hh, mm] = parts2

  const utcMs = Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm, 0)
  const dt = new Date(utcMs)
  if (isNaN(dt.getTime())) return null
  return dt
}

function getFirstDeparture(departures = []) {
  if (!Array.isArray(departures) || !departures.length) return null
  const first = departures[0] || {}
  return makeDate(first.date, first.time)
}

// 只查 Carpool
async function buildTimeMapFromCarpool(ids = []) {
  const timeMap = {}
  const validIds = (ids || []).filter(Boolean)
  if (!validIds.length) return timeMap

  await Promise.all(validIds.map(async (id) => {
    try {
      const res = await db.collection('Carpool').doc(id).get()
      const doc = res.data || {}
      const dt = getFirstDeparture(doc.departures || [])
      if (dt) timeMap[id] = { dt, source: 'Carpool', status: doc.status }
    } catch (e) {
      console.error('[Driver] fetch Carpool error:', id, e)
    }
  }))

  return timeMap
}

// 只查 CarpoolRequest
async function buildTimeMapFromRequest(ids = []) {
  const timeMap = {}
  const validIds = (ids || []).filter(Boolean)
  if (!validIds.length) return timeMap

  await Promise.all(validIds.map(async (id) => {
    try {
      const res = await db.collection('CarpoolRequest').doc(id).get()
      const doc = res.data || {}
      const dt = getFirstDeparture(doc.departures || [])
      if (dt) timeMap[id] = { dt, source: 'CarpoolRequest', status: doc.status }
    } catch (e) {
      console.error('[Driver] fetch CarpoolRequest error:', id, e)
    }
  }))

  return timeMap
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }

  const now = new Date()
  const sixHoursMs = 6 * 60 * 60 * 1000

  const userInfoColl = db.collection('userInfo')
  const ures = await userInfoColl.where({ _openid: openid }).limit(1).get()
  if (!ures.data || !ures.data.length) {
    return { ok: true, userInfoMsg: '当前用户没有 userInfo 文档', moved: 0, requestUpdated: 0, carpoolUpdated: 0 }
  }

  const userDoc = ures.data[0]
  const userId = userDoc._id

  // 司机端：tripDriver 属于 Carpool；tripDriverJoin 属于 CarpoolRequest
  const tripDriver = Array.isArray(userDoc.tripDriver) ? userDoc.tripDriver : []
  const tripDriverJoin = Array.isArray(userDoc.tripDriverJoin) ? userDoc.tripDriverJoin : []

  const tripDriverHistory = Array.isArray(userDoc.tripDriverHistory) ? userDoc.tripDriverHistory : []
  const tripDriverJoinHistory = Array.isArray(userDoc.tripDriverJoinHistory) ? userDoc.tripDriverJoinHistory : []

  // 分别构建时间映射
  const carpoolTimeMap = await buildTimeMapFromCarpool(tripDriver)
  const requestTimeMap = await buildTimeMapFromRequest(tripDriverJoin)

  const newTripDriver = []
  const movedTripDriver = []

  const newTripDriverJoin = []
  const movedTripDriverJoin = []

  // 收集：过期且来自 CarpoolRequest 的 id，用于 open->close 更新
  const expiredRequestIdsToUpdate = []

  // 处理 tripDriver（Carpool）
  for (const id of tripDriver) {
    const meta = carpoolTimeMap[id]
    const dt = meta ? meta.dt : null
    if (!dt) {
      newTripDriver.push(id)
      continue
    }
    const diffMs = now.getTime() - dt.getTime()
    if (diffMs > sixHoursMs) movedTripDriver.push(id)
    else newTripDriver.push(id)
  }

  // 处理 tripDriverJoin（CarpoolRequest）
  for (const id of tripDriverJoin) {
    const meta = requestTimeMap[id]
    const dt = meta ? meta.dt : null
    if (!dt) {
      newTripDriverJoin.push(id)
      continue
    }
    const diffMs = now.getTime() - dt.getTime()
    if (diffMs > sixHoursMs) {
      movedTripDriverJoin.push(id)
      expiredRequestIdsToUpdate.push(id)
    } else {
      newTripDriverJoin.push(id)
    }
  }

  const movedCount = movedTripDriver.length + movedTripDriverJoin.length

  // 写回 userInfo（只有有变动才写）
  if (movedCount) {
    await userInfoColl.doc(userId).update({
      data: {
        tripDriver: newTripDriver,
        tripDriverJoin: newTripDriverJoin,
        tripDriverHistory: tripDriverHistory.concat(movedTripDriver),
        tripDriverJoinHistory: tripDriverJoinHistory.concat(movedTripDriverJoin),
        updateTime: now
      }
    })
  }

  // ========== 1) 更新 CarpoolRequest：open -> close（仅针对过期的 tripDriverJoin） ==========
  let requestUpdatedCount = 0
  const uniqueExpiredRequest = Array.from(new Set(expiredRequestIdsToUpdate))

  if (uniqueExpiredRequest.length) {
    const updates = await Promise.all(uniqueExpiredRequest.map(async (rid) => {
      try {
        const res = await db.collection('CarpoolRequest').doc(rid).get()
        const doc = res.data || {}
        const dt = getFirstDeparture(doc.departures || [])
        if (!dt) return { rid, updated: false, reason: 'no_time' }

        const diffMs = now.getTime() - dt.getTime()
        const oldStatus = doc.status || 'open'

        if (oldStatus === 'open' && diffMs > sixHoursMs) {
          await db.collection('CarpoolRequest').doc(rid).update({
            data: { status: 'close', updatedAt: now }
          })
          return { rid, updated: true }
        }
        return { rid, updated: false, reason: 'not_match' }
      } catch (e) {
        console.error('[Driver] update CarpoolRequest error:', rid, e)
        return { rid, updated: false, reason: 'error' }
      }
    }))

    requestUpdatedCount = updates.filter(x => x && x.updated).length
  }

  // ========== 2) 更新 Carpool：open -> close（仅针对过期的 tripDriver） ==========
  let carpoolUpdatedCount = 0
  const uniqueExpiredCarpool = Array.from(new Set(movedTripDriver))

  if (uniqueExpiredCarpool.length) {
    const updates2 = await Promise.all(uniqueExpiredCarpool.map(async (cid) => {
      try {
        const res = await db.collection('Carpool').doc(cid).get()
        const doc = res.data || {}
        const dt = getFirstDeparture(doc.departures || [])
        if (!dt) return { cid, updated: false, reason: 'no_time' }

        const diffMs = now.getTime() - dt.getTime()
        const oldStatus = doc.status || 'open'

        if (oldStatus === 'open' && diffMs > sixHoursMs) {
          await db.collection('Carpool').doc(cid).update({
            data: { status: 'close', updatedAt: now }
          })
          return { cid, updated: true }
        }
        return { cid, updated: false, reason: 'not_match' }
      } catch (e) {
        console.error('[Driver] update Carpool error:', cid, e)
        return { cid, updated: false, reason: 'error' }
      }
    }))

    carpoolUpdatedCount = updates2.filter(x => x && x.updated).length
  }

  return {
    ok: true,
    movedTripDriver: movedTripDriver.length,
    movedTripDriverJoin: movedTripDriverJoin.length,
    movedTotal: movedCount,
    requestUpdated: requestUpdatedCount,
    carpoolUpdated: carpoolUpdatedCount
  }
}
