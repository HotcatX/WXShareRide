// 云函数：editMyTripDetailDriver
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value === 'close' || value === 'closed' ? 'past' : value
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
