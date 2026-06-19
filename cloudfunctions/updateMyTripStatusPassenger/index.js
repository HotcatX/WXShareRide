// 云函数：updateMyTripStatusPassenger
// 作用：刷新乘客端 userInfo.tripPassenger（可能来自 Carpool 或 CarpoolRequest）
//      和 userInfo.tripPassengerCreate（CarpoolRequest）
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

// 乘客端：tripPassenger 可能来自 Carpool 或 CarpoolRequest
// 这里按“先查 Carpool，查不到再查 CarpoolRequest”的方式建立 timeMap
async function buildTimeMapFromCarpoolAndRequest(ids = []) {
  const timeMap = {}
  const validIds = (ids || []).filter(Boolean)
  if (!validIds.length) return timeMap

  await Promise.all(validIds.map(async (id) => {
    // 1) try Carpool
    try {
      const res1 = await db.collection('Carpool').doc(id).get()
      const doc1 = res1.data || {}
      const dt1 = getFirstDeparture(doc1.departures || [])
      if (dt1) {
        timeMap[id] = { dt: dt1, source: 'Carpool', status: doc1.status }
        return
      }
    } catch (e) {
      // ignore，继续查 CarpoolRequest
    }

    // 2) try CarpoolRequest
    try {
      const res2 = await db.collection('CarpoolRequest').doc(id).get()
      const doc2 = res2.data || {}
      const dt2 = getFirstDeparture(doc2.departures || [])
      if (dt2) {
        timeMap[id] = { dt: dt2, source: 'CarpoolRequest', status: doc2.status }
      }
    } catch (e) {
      console.error('[Passenger] fetch Carpool/Request error:', id, e)
    }
  }))

  return timeMap
}

// tripPassengerCreate 一定来自 CarpoolRequest
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
      console.error('[Passenger] fetch CarpoolRequest error:', id, e)
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
      tripPassenger: true,
      tripPassengerCreate: true,
      tripPassengerHistory: true,
      tripPassengerCreateHistory: true
    })
    .limit(1)
    .get()
  if (!ures.data || !ures.data.length) {
    return {
      ok: true,
      userInfoMsg: '当前用户没有 userInfo 文档',
      moved: 0,
      requestUpdated: 0,
      carpoolUpdated: 0
    }
  }

  const userDoc = ures.data[0]
  const userId = userDoc._id

  // 乘客端字段
  const tripPassenger = Array.isArray(userDoc.tripPassenger) ? userDoc.tripPassenger : []
  const tripPassengerCreate = Array.isArray(userDoc.tripPassengerCreate) ? userDoc.tripPassengerCreate : []

  const tripPassengerHistory = Array.isArray(userDoc.tripPassengerHistory) ? userDoc.tripPassengerHistory : []
  const tripPassengerCreateHistory = Array.isArray(userDoc.tripPassengerCreateHistory) ? userDoc.tripPassengerCreateHistory : []

  const passengerTimeMap = await buildTimeMapFromCarpoolAndRequest(tripPassenger)
  const createTimeMap = await buildTimeMapFromRequest(tripPassengerCreate)

  const newTripPassenger = []
  const movedTripPassenger = []

  const newTripPassengerCreate = []
  const movedTripPassengerCreate = []

  // 收集：发车时间已过的 id，用于写入 past；超过 6 小时才迁移到 history
  const passedRequestIdsToUpdate = []
  const passedCarpoolIdsToUpdate = []

  // 处理 tripPassenger（可能来自 Carpool / CarpoolRequest）
  for (const id of tripPassenger) {
    const meta = passengerTimeMap[id]
    const dt = meta ? meta.dt : null

    if (!dt) {
      newTripPassenger.push(id)
      continue
    }

    const diffMs = now.getTime() - dt.getTime()
    if (diffMs > 0) {
      if (meta && meta.source === 'CarpoolRequest') passedRequestIdsToUpdate.push(id)
      else if (meta && meta.source === 'Carpool') passedCarpoolIdsToUpdate.push(id)
    }
    if (diffMs > sixHoursMs) {
      movedTripPassenger.push(id)
    } else {
      newTripPassenger.push(id)
    }
  }

  // 处理 tripPassengerCreate（一定来自 CarpoolRequest）
  for (const id of tripPassengerCreate) {
    const meta = createTimeMap[id]
    const dt = meta ? meta.dt : null

    if (!dt) {
      newTripPassengerCreate.push(id)
      continue
    }

    const diffMs = now.getTime() - dt.getTime()
    if (diffMs > 0) passedRequestIdsToUpdate.push(id)
    if (diffMs > sixHoursMs) {
      movedTripPassengerCreate.push(id)
    } else {
      newTripPassengerCreate.push(id)
    }
  }

  const movedCount = movedTripPassenger.length + movedTripPassengerCreate.length

  // 写回 userInfo（只有有变动才写）
  if (movedCount) {
    await userInfoColl.doc(userId).update({
      data: {
        tripPassenger: newTripPassenger,
        tripPassengerCreate: newTripPassengerCreate,
        tripPassengerHistory: tripPassengerHistory.concat(movedTripPassenger),
        tripPassengerCreateHistory: tripPassengerCreateHistory.concat(movedTripPassengerCreate),
        updateTime: now
      }
    })
  }

  // ========== 1) 更新 CarpoolRequest：expired -> past ==========
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
        console.error('[Passenger] update CarpoolRequest error:', rid, e)
        return { rid, updated: false, reason: 'error' }
      }
    }))

    requestUpdatedCount = updates.filter(x => x && x.updated).length
  }

  // ========== 2) 更新 Carpool：expired -> past ==========
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
        console.error('[Passenger] update Carpool error:', cid, e)
        return { cid, updated: false, reason: 'error' }
      }
    }))

    carpoolUpdatedCount = updates2.filter(x => x && x.updated).length
  }

  return {
    ok: true,
    movedTripPassenger: movedTripPassenger.length,
    movedTripPassengerCreate: movedTripPassengerCreate.length,
    movedTotal: movedCount,
    requestUpdated: requestUpdatedCount,
    carpoolUpdated: carpoolUpdatedCount
  }
}
