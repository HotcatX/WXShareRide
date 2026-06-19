// 云函数：editMyTripDetailDriver
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const PUBLIC_STATS_COLLECTION = 'PublicStats'
const PUBLIC_STATS_DOC_ID = 'home'
const MAX_SERVED_DELTA = 5

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value === 'close' || value === 'closed' ? 'past' : value
}

function normalizeServedDelta(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_SERVED_DELTA, Math.max(1, Math.floor(n)))
}

function addId(set, value) {
  const id = String(value || '').trim()
  if (id) set.add(id)
}

function getCarpoolServedPeople(doc = {}) {
  const drivers = new Set()
  const passengers = new Set()
  addId(drivers, doc._openid)
  addId(drivers, doc.driverOpenid)

  ;(Array.isArray(doc.passengers) ? doc.passengers : []).forEach(p => {
    addId(passengers, p && p._openid)
  })
  ;(Array.isArray(doc.passengerID) ? doc.passengerID : []).forEach(id => addId(passengers, id))

  const capacity = Number(doc.passengerCount)
  const left = Number(doc.availSeatNum)
  const joinedBySeat = Number.isFinite(capacity) && Number.isFinite(left)
    ? Math.max(0, capacity - left)
    : 0
  const passengerSignals = Math.max(passengers.size, joinedBySeat)
  const hasDriver = drivers.size > 0 || !!(doc.driverID || doc.driverId)
  return normalizeServedDelta((hasDriver ? 1 : 0) + passengerSignals)
}

async function bumpServedTrips(delta, source, tripId, collection) {
  const amount = normalizeServedDelta(delta)
  if (amount <= 0) return false

  const now = db.serverDate()
  const data = {
    servedTrips: _.inc(amount),
    servedTripsLastDelta: amount,
    servedTripsLastSource: source,
    servedTripsLastTripId: tripId,
    servedTripsLastCollection: collection,
    lastServedAt: now,
    updatedAt: now
  }

  try {
    await db.collection(PUBLIC_STATS_COLLECTION).doc(PUBLIC_STATS_DOC_ID).update({ data })
    return true
  } catch (e) {
    try {
      await db.collection(PUBLIC_STATS_COLLECTION).add({
        data: {
          _id: PUBLIC_STATS_DOC_ID,
          servedTrips: amount,
          servedTripsLastDelta: amount,
          servedTripsLastSource: source,
          servedTripsLastTripId: tripId,
          servedTripsLastCollection: collection,
          coverageText: 'NY / NJ',
          lastServedAt: now,
          createdAt: now,
          updatedAt: now
        }
      })
      return true
    } catch (addErr) {
      try {
        await db.collection(PUBLIC_STATS_COLLECTION).doc(PUBLIC_STATS_DOC_ID).update({ data })
        return true
      } catch (retryErr) {
        return false
      }
    }
  }
}

async function completeTripAndCount(tripId, carpoolDoc, updateData) {
  const delta = getCarpoolServedPeople(carpoolDoc)
  const countedAt = db.serverDate()
  const data = {
    ...updateData,
    servedStatsCounted: true,
    servedStatsDelta: delta,
    servedStatsSource: 'driverCompleteTrip',
    servedStatsCountedAt: countedAt
  }

  const res = await db.collection('Carpool')
    .where({ _id: tripId, servedStatsCounted: _.neq(true) })
    .update({ data })

  const updated = Number((res && res.stats && res.stats.updated) || (res && res.updated) || 0)
  if (updated > 0) {
    const counted = await bumpServedTrips(delta, 'driverCompleteTrip', tripId, 'Carpool')
    return { updated: true, counted, delta }
  }

  const fresh = await db.collection('Carpool').doc(tripId).get().catch(() => null)
  if (fresh && fresh.data && normalizeTripStatus(fresh.data.status) !== 'past') {
    await db.collection('Carpool').doc(tripId).update({ data: updateData })
    return { updated: true, counted: false, delta: 0 }
  }

  return { updated: false, counted: false, delta: 0 }
}

/**
 * 往 Notifications 集合写通知
 */
async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) {
    return
  }
  try {
    await db.collection('Notifications').add({
      data: {
        _openid: toOpenid,
        type,
        title,
        content,
        carpoolId: carpoolId || '',
        extra,
        read: false,
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    console.error('[sendNotification] 写入通知失败：', e)
  }
}

/**
 * 从某个用户的 MyTrips 中删掉指定 tripId（按 _openid 查）
 */
async function removeTripFromMyTrips(openidToClean, tripId) {
  const coll = db.collection('MyTrips')
  const res = await coll.where({ _openid: openidToClean }).limit(1).get()

  if (!res.data.length) {
    return
  }

  const doc = res.data[0]
  const oldTrips = Array.isArray(doc.trips) ? doc.trips : []
  const newTrips = oldTrips.filter(t => t.tripId !== tripId)

  if (newTrips.length === oldTrips.length) {
    return
  }

  await coll.doc(doc._id).update({
    data: {
      trips: newTrips,
      updatedAt: new Date()
    }
  })
}

/**
 * 从 userInfo 中删除某个 tripId（fieldName: tripDriver / tripPassenger）
 */
async function removeTripFromUserInfo(openidToClean, tripId, fieldName) {
  const coll = db.collection('userInfo')
  const res = await coll.where({ _openid: openidToClean }).limit(1).get()

  if (!res.data.length) {
    return
  }

  const doc = res.data[0]
  const oldList = Array.isArray(doc[fieldName]) ? doc[fieldName] : []
  const newList = oldList.filter(id => id !== tripId)

  if (newList.length === oldList.length) {
    return
  }

  await coll.doc(doc._id).update({
    data: {
      [fieldName]: newList,
      updatedAt: new Date()
    }
  })
}

async function moveTripInUserInfo(openidToClean, tripId, activeField, historyField) {
  const coll = db.collection('userInfo')
  const res = await coll.where({ _openid: openidToClean }).limit(1).get()

  if (!res.data.length) {
    return
  }

  const doc = res.data[0]
  const activeList = Array.isArray(doc[activeField]) ? doc[activeField] : []
  const historyList = Array.isArray(doc[historyField]) ? doc[historyField] : []

  const nextActive = activeList.filter(id => id !== tripId)
  const nextHistory = historyList.includes(tripId) ? historyList : [tripId, ...historyList]

  await coll.doc(doc._id).update({
    data: {
      [activeField]: nextActive,
      [historyField]: nextHistory,
      updatedAt: new Date()
    }
  })
}

function isTripOwner(carpoolDoc, driverOpenid) {
  return !!(carpoolDoc && driverOpenid && carpoolDoc._openid === driverOpenid)
}

function buildRouteInfo(carpoolDoc = {}) {
  const dep = (carpoolDoc.departures || [])[0] || {}
  const des = (carpoolDoc.destinations || [])[0] || {}
  const dateStr = dep.date || ''
  const timeStr = dep.time || ''
  const routeStr = (dep.address && des.address) ? `${dep.address} -> ${des.address}` : '本次行程'
  return { dateStr, timeStr, routeStr }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const driverOpenid = wxContext.OPENID

  const { tripId, action, targetOpenid } = event || {}

  if (!driverOpenid) return { ok: false, errorMsg: '未获取到 openid' }
  if (!tripId) return { ok: false, errorMsg: '缺少 tripId 参数' }

  /*********** 司机：剔除单个乘客（不删整条路线） ***********/
  if (action === 'kickPassenger') {
    if (!targetOpenid) return { ok: false, errorMsg: '缺少乘客 openid' }

    try {
      // 先把该行程读出来，便于通知内容
      const carpoolRes = await db.collection('Carpool').doc(tripId).get()
      const carpoolDoc = carpoolRes.data || {}
      if (!isTripOwner(carpoolDoc, driverOpenid)) {
        return { ok: false, errorMsg: '你不是该路线司机，无法操作' }
      }

      // 1) Carpool 中移除该乘客，并把可用座位 +1
      const kickUpdateData = {
        passengers: _.pull({ _openid: targetOpenid }),
        availSeatNum: _.inc(1),
        updatedAt: new Date()
      }
      const curStatus = normalizeTripStatus(carpoolDoc.status)
      if (curStatus !== 'past') {
        kickUpdateData.status = 'open'
      }

      await db.collection('Carpool').doc(tripId).update({
        data: kickUpdateData
      })

      // 2) 乘客 MyTrips 删除
      await removeTripFromMyTrips(targetOpenid, tripId)

      // 3) 乘客 userInfo.tripPassenger 删除
      await removeTripFromUserInfo(targetOpenid, tripId, 'tripPassenger')

      // 4) 给被剔除乘客发通知
      const { dateStr, timeStr, routeStr } = buildRouteInfo(carpoolDoc)

      await sendNotification(
        targetOpenid,
        'DRIVER_KICK',
        '你被移出行程',
        `你被移出了 ${dateStr} ${timeStr} ${routeStr} 的行程`,
        tripId,
        { role: 'passenger', driverOpenid }
      )

      return { ok: true, action: 'kick_passenger' }
    } catch (e) {
      console.error('【editMyTripDetailDriver】kickPassenger 失败：', e)
      return { ok: false, errorMsg: e.message || '剔除失败' }
    }
  }

  /**********************
   * 司机：主动结束路线（不删除）
   **********************/
  if (action === 'completeTrip') {
    try {
      const carpoolRes = await db.collection('Carpool').doc(tripId).get()
      const carpoolDoc = carpoolRes.data
      if (!carpoolDoc) return { ok: false, errorMsg: '未找到该路线' }
      if (!isTripOwner(carpoolDoc, driverOpenid)) {
        return { ok: false, errorMsg: '你不是该路线司机，无法结束' }
      }

      const oldStatus = normalizeTripStatus(carpoolDoc.status)
      if (oldStatus === 'past') {
        return { ok: true, action: 'complete_trip', alreadyCompleted: true }
      }

      const passengersArr = Array.isArray(carpoolDoc.passengers) ? carpoolDoc.passengers : []
      const passengerOpenids = [...new Set(passengersArr.map(p => p && p._openid).filter(Boolean))]
      const { dateStr, timeStr, routeStr } = buildRouteInfo(carpoolDoc)

      const completeResult = await completeTripAndCount(tripId, carpoolDoc, {
        status: 'past',
        completedAt: db.serverDate(),
        completedBy: driverOpenid,
        updatedAt: db.serverDate()
      })

      const tasks = [
        moveTripInUserInfo(driverOpenid, tripId, 'tripDriver', 'tripDriverHistory'),
        ...passengerOpenids.map(pid => Promise.all([
          moveTripInUserInfo(pid, tripId, 'tripPassenger', 'tripPassengerHistory'),
          sendNotification(
            pid,
            'DRIVER_COMPLETE',
            '行程已结束',
            `${dateStr} ${timeStr} ${routeStr} 的行程已由司机标记为结束`,
            tripId,
            { role: 'passenger', driverOpenid, action: 'complete_trip' }
          )
        ]))
      ]

      const results = await Promise.all(tasks.map(task => task
        .then(() => ({ ok: true }))
        .catch(reason => ({ ok: false, reason }))
      ))
      const failed = results.filter(r => !r.ok)
      if (failed.length) {
      }

      return {
        ok: true,
        action: 'complete_trip',
        passengerCount: passengerOpenids.length,
        servedStatsDelta: completeResult.delta || 0,
        servedStatsCounted: !!completeResult.counted,
        partialFailed: failed.length
      }
    } catch (e) {
      console.error('【editMyTripDetailDriver】结束路线失败：', e)
      return { ok: false, errorMsg: e.message || '结束路线失败' }
    }
  }

  if (action && action !== 'deleteTrip') {
    return { ok: false, errorMsg: '不支持的操作' }
  }

  /**********************
   * 司机：删除整条路线
   **********************/
  try {
    // 0) 先把 Carpool 文档查出来，拿到所有 passengers openid
    const carpoolRes = await db.collection('Carpool').doc(tripId).get()
    const carpoolDoc = carpoolRes.data
    if (!carpoolDoc) return { ok: false, errorMsg: '未找到该路线' }
    if (!isTripOwner(carpoolDoc, driverOpenid)) {
      return { ok: false, errorMsg: '你不是该路线司机，无法删除' }
    }

    const passengersArr = Array.isArray(carpoolDoc.passengers) ? carpoolDoc.passengers : []
    const passengerOpenids = passengersArr.map(p => p && p._openid).filter(Boolean)

    // 拼接通知用信息
    const { dateStr, timeStr, routeStr } = buildRouteInfo(carpoolDoc)

    // 1) 删除 Carpool 整条路线
    await db.collection('Carpool').doc(tripId).remove()

    // 2) 清理司机和乘客关联数据。路线已删除，后续清理失败不应阻断主结果。
    const cleanupTasks = [
      removeTripFromMyTrips(driverOpenid, tripId),
      removeTripFromUserInfo(driverOpenid, tripId, 'tripDriver'),
      ...passengerOpenids.map(pid => Promise.all([
        removeTripFromMyTrips(pid, tripId),
        removeTripFromUserInfo(pid, tripId, 'tripPassenger'),
        sendNotification(
          pid,
          'DRIVER_DELETE',
          '行程已被司机取消',
          `${dateStr} ${timeStr} ${routeStr} 的行程已被司机取消`,
          tripId,
          { role: 'passenger', driverOpenid }
        )
      ]))
    ]

    const cleanupResults = await Promise.all(cleanupTasks.map(task => task
      .then(() => ({ ok: true }))
      .catch(reason => ({ ok: false, reason }))
    ))
    const cleanupFailed = cleanupResults.filter(r => !r.ok)
    if (cleanupFailed.length > 0) {
    }

    return { ok: true, action: 'delete_trip_as_driver' }
  } catch (e) {
    console.error('【editMyTripDetailDriver】删除路线失败：', e)
    return { ok: false, errorMsg: e.message || '操作失败' }
  }
}
