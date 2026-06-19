// 云函数：updateMyTripStatusDriver
// 作用：刷新司机端 userInfo.tripDriver（Carpool）和 userInfo.tripDriverJoin（CarpoolRequest）
// 规则：以第一个 departures 的时间为准，超过 6 小时迁移到 history；
//      对过期记录统一写 status=past，不再自动写 close

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const TRIP_TIME_ZONE = 'America/New_York'

function getZonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TRIP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)

  const map = {}
  parts.forEach(part => {
    if (part.type !== 'literal') map[part.type] = Number(part.value)
  })

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second
  }
}

function getTimeZoneOffsetMs(date) {
  const p = getZonedParts(date)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0) - date.getTime()
}

function makeDate(dateStr, timeStr) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim())
  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || '').trim())
  if (!dateMatch || !timeMatch) return null

  const y = Number(dateMatch[1])
  const m = Number(dateMatch[2])
  const d = Number(dateMatch[3])
  const hh = Number(timeMatch[1])
  const mm = Number(timeMatch[2])
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null

  const localAsUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0)
  let utcMs = localAsUtcMs - getTimeZoneOffsetMs(new Date(localAsUtcMs))
  utcMs = localAsUtcMs - getTimeZoneOffsetMs(new Date(utcMs))
  const dt = new Date(utcMs)
  return isNaN(dt.getTime()) ? null : dt
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
  const ures = await userInfoColl
    .where({ _openid: openid })
    .field({
      _id: true,
      tripDriver: true,
      tripDriverJoin: true,
      tripDriverHistory: true,
      tripDriverJoinHistory: true
    })
    .limit(1)
    .get()
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

  // 收集：发车时间已过的 id，用于写入 past；超过 6 小时才迁移到 history
  const passedCarpoolIdsToUpdate = []
  const passedRequestIdsToUpdate = []

  // 处理 tripDriver（Carpool）
  for (const id of tripDriver) {
    const meta = carpoolTimeMap[id]
    const dt = meta ? meta.dt : null
    if (!dt) {
      newTripDriver.push(id)
      continue
    }
    const diffMs = now.getTime() - dt.getTime()
    if (diffMs > 0) passedCarpoolIdsToUpdate.push(id)
    if (diffMs > sixHoursMs) {
      movedTripDriver.push(id)
    } else {
      newTripDriver.push(id)
    }
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
    if (diffMs > 0) passedRequestIdsToUpdate.push(id)
    if (diffMs > sixHoursMs) {
      movedTripDriverJoin.push(id)
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

  // ========== 1) 更新 CarpoolRequest：expired -> past（仅针对过期的 tripDriverJoin） ==========
  let requestUpdatedCount = 0
  const uniqueExpiredRequest = Array.from(new Set(passedRequestIdsToUpdate))

  if (uniqueExpiredRequest.length) {
    const updates = await Promise.all(uniqueExpiredRequest.map(async (rid) => {
      try {
        const res = await db.collection('CarpoolRequest').doc(rid).get()
        const doc = res.data || {}
        const dt = getFirstDeparture(doc.departures || [])
        if (!dt) return { rid, updated: false, reason: 'no_time' }

        const diffMs = now.getTime() - dt.getTime()
        const oldStatus = doc.status || 'open'

        if (oldStatus !== 'past' && diffMs > 0) {
          const statusRes = await cloud.callFunction({
            name: 'updateCarpoolRequestStatus',
            data: { requestId: rid }
          })
          const updated = Number(statusRes && statusRes.result && statusRes.result.totalUpdatedCarpoolRequest || 0) > 0
          return { rid, updated }
        }
        return { rid, updated: false, reason: 'not_match' }
      } catch (e) {
        console.error('[Driver] update CarpoolRequest error:', rid, e)
        return { rid, updated: false, reason: 'error' }
      }
    }))

    requestUpdatedCount = updates.filter(x => x && x.updated).length
  }

  // ========== 2) 更新 Carpool：expired -> past（仅针对过期的 tripDriver） ==========
  let carpoolUpdatedCount = 0
  const uniqueExpiredCarpool = Array.from(new Set(passedCarpoolIdsToUpdate))

  if (uniqueExpiredCarpool.length) {
    const updates2 = await Promise.all(uniqueExpiredCarpool.map(async (cid) => {
      try {
        const res = await db.collection('Carpool').doc(cid).get()
        const doc = res.data || {}
        const dt = getFirstDeparture(doc.departures || [])
        if (!dt) return { cid, updated: false, reason: 'no_time' }

        const diffMs = now.getTime() - dt.getTime()
        const oldStatus = doc.status || 'open'

        if (oldStatus !== 'past' && diffMs > 0) {
          const statusRes = await cloud.callFunction({
            name: 'updateCarpoolStatus',
            data: { tripId: cid }
          })
          const updated = Number(statusRes && statusRes.result && statusRes.result.totalUpdatedCarpool || 0) > 0
          return { cid, updated }
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
