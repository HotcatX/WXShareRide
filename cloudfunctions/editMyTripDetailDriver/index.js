// 云函数：editMyTripDetailDriver
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/**
 * 往 Notifications 集合写通知
 */
async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) {
    console.warn('[sendNotification] 缺少 toOpenid，跳过发送')
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
    console.log('[sendNotification] 已发送通知给', toOpenid, type)
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
    console.log('【removeTripFromMyTrips】没有找到 MyTrips 文档, _openid =', openidToClean)
    return
  }

  const doc = res.data[0]
  const oldTrips = Array.isArray(doc.trips) ? doc.trips : []
  const newTrips = oldTrips.filter(t => t.tripId !== tripId)

  console.log(
    '【removeTripFromMyTrips】_openid =', openidToClean,
    'trip 数:', oldTrips.length, '→', newTrips.length,
    'tripId =', tripId
  )

  if (newTrips.length === oldTrips.length) {
    console.log('【removeTripFromMyTrips】没有找到要删除的 tripId，保持不变')
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
    console.log('【removeTripFromUserInfo】没有找到 userInfo 文档, _openid =', openidToClean)
    return
  }

  const doc = res.data[0]
  const oldList = Array.isArray(doc[fieldName]) ? doc[fieldName] : []
  const newList = oldList.filter(id => id !== tripId)

  console.log(
    '【removeTripFromUserInfo】_openid =', openidToClean,
    'field =', fieldName,
    '数量:', oldList.length, '→', newList.length,
    'tripId =', tripId
  )

  if (newList.length === oldList.length) {
    console.log('【removeTripFromUserInfo】没有找到要删除的 tripId，保持不变')
    return
  }

  await coll.doc(doc._id).update({
    data: {
      [fieldName]: newList,
      updatedAt: new Date()
    }
  })
}

/**
 * 可选：在云函数内触发 updateCarpoolStatus（即使页面漏调用，也尽量不出错）
 */
async function callUpdateCarpoolStatus(tripId) {
  if (!tripId) return
  try {
    await cloud.callFunction({
      name: 'updateCarpoolStatus',
      data: { ids: [tripId] }
    })
    console.log('[callUpdateCarpoolStatus] 已触发 updateCarpoolStatus tripId=', tripId)
  } catch (e) {
    // 不阻断主流程（避免 updateCarpoolStatus 不存在导致整个操作失败）
    console.warn('[callUpdateCarpoolStatus] 触发失败（不影响主流程）：', e && e.message ? e.message : e)
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const driverOpenid = wxContext.OPENID

  const { tripId, action, targetOpenid } = event || {}
  console.log('【editMyTripDetailDriver】driverOpenid=', driverOpenid, 'tripId=', tripId, 'action=', action)

  if (!driverOpenid) return { ok: false, errorMsg: '未获取到 openid' }
  if (!tripId) return { ok: false, errorMsg: '缺少 tripId 参数' }

  /*********** 司机：剔除单个乘客（不删整条路线） ***********/
  if (action === 'kickPassenger') {
    if (!targetOpenid) return { ok: false, errorMsg: '缺少乘客 openid' }

    try {
      // 先把该行程读出来，便于通知内容
      const carpoolRes = await db.collection('Carpool').doc(tripId).get()
      const carpoolDoc = carpoolRes.data || {}

      // 1) Carpool 中移除该乘客，并把可用座位 +1
      await db.collection('Carpool').doc(tripId).update({
        data: {
          passengers: _.pull({ _openid: targetOpenid }),
          availSeatNum: _.inc(1),
          updatedAt: new Date()
        }
      })

      // 2) 乘客 MyTrips 删除
      await removeTripFromMyTrips(targetOpenid, tripId)

      // 3) 乘客 userInfo.tripPassenger 删除
      await removeTripFromUserInfo(targetOpenid, tripId, 'tripPassenger')

      // 4) 给被剔除乘客发通知
      const dep = (carpoolDoc.departures || [])[0] || {}
      const des = (carpoolDoc.destinations || [])[0] || {}
      const dateStr = dep.date || ''
      const timeStr = dep.time || ''
      const routeStr = (dep.address && des.address) ? `${dep.address} -> ${des.address}` : '本次行程'

      await sendNotification(
        targetOpenid,
        'DRIVER_KICK',
        '你被移出行程',
        `你被移出了 ${dateStr} ${timeStr} ${routeStr} 的行程`,
        tripId,
        { role: 'passenger', driverOpenid }
      )

      // 5) 触发状态刷新（可选兜底）
      await callUpdateCarpoolStatus(tripId)

      console.log('【editMyTripDetailDriver】已剔除乘客:', targetOpenid, 'from trip:', tripId)
      return { ok: true, action: 'kick_passenger' }
    } catch (e) {
      console.error('【editMyTripDetailDriver】kickPassenger 失败：', e)
      return { ok: false, errorMsg: e.message || '剔除失败' }
    }
  }

  /**********************
   * 司机：删除整条路线
   **********************/
  try {
    // 0) 先把 Carpool 文档查出来，拿到所有 passengers openid
    const carpoolRes = await db.collection('Carpool').doc(tripId).get()
    const carpoolDoc = carpoolRes.data
    if (!carpoolDoc) return { ok: false, errorMsg: '未找到该路线' }

    const passengersArr = Array.isArray(carpoolDoc.passengers) ? carpoolDoc.passengers : []
    const passengerOpenids = passengersArr.map(p => p && p._openid).filter(Boolean)

    console.log('【editMyTripDetailDriver】本路线乘客 openid 列表 =', passengerOpenids)

    // 拼接通知用信息
    const dep = (carpoolDoc.departures || [])[0] || {}
    const des = (carpoolDoc.destinations || [])[0] || {}
    const dateStr = dep.date || ''
    const timeStr = dep.time || ''
    const routeStr = (dep.address && des.address) ? `${dep.address} -> ${des.address}` : '本次行程'

    // 1) 删除 Carpool 整条路线
    await db.collection('Carpool').doc(tripId).remove()
    console.log('【editMyTripDetailDriver】已删除 Carpool 记录:', tripId)

    // 2) 删除司机 MyTrips 中对应 trip
    await removeTripFromMyTrips(driverOpenid, tripId)

    // 3) 删除司机 userInfo.tripDriver 中 tripId
    await removeTripFromUserInfo(driverOpenid, tripId, 'tripDriver')

    // 4) 清理所有乘客 MyTrips + userInfo，并发通知
    for (const pid of passengerOpenids) {
      await removeTripFromMyTrips(pid, tripId)
      await removeTripFromUserInfo(pid, tripId, 'tripPassenger')

      await sendNotification(
        pid,
        'DRIVER_DELETE',
        '行程已被司机取消',
        `${dateStr} ${timeStr} ${routeStr} 的行程已被司机取消`,
        tripId,
        { role: 'passenger', driverOpenid }
      )
    }

    // 5) 删除后一般无需刷新该 trip 的 Carpool 状态（因为 doc 已不存在）
    // 但为了保持一致性（以及你可能在状态函数里清理关联字段），仍可尝试触发（失败不影响）
    await callUpdateCarpoolStatus(tripId)

    return { ok: true, action: 'delete_trip_as_driver' }
  } catch (e) {
    console.error('【editMyTripDetailDriver】删除路线失败：', e)
    return { ok: false, errorMsg: e.message || '操作失败' }
  }
}
