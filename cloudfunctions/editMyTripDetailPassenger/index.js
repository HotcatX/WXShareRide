// 云函数：editMyTripDetailPassenger（无事务版，兼容 Carpool / CarpoolRequest）
// 乘客退出：
// 1) 若 tripId 属于 Carpool：从 passengers(对象数组) 或 passengerID(字符串数组) 移除，维护 passengerCount/availSeatNum（仅在确实移除时维护）
// 2) 若 tripId 属于 CarpoolRequest：从 passengerID 中移除，维护 passengerCount（仅在确实移除时维护）
// 3) 清理 userInfo.tripPassenger / tripPassengerCreate（尽力而为，不阻断主流程）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ✅ 保留一份 sendNotification（删除重复声明，避免 “already been declared”）
async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) return
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

function buildRouteText(req) {
  const dep = (req && req.departures && req.departures[0]) ? req.departures[0] : {}
  const des = (req && req.destinations && req.destinations[0]) ? req.destinations[0] : {}
  const dateStr = dep.date || ''
  const timeStr = dep.time || ''
  const routeStr = (dep.address && des.address) ? (dep.address + ' -> ' + des.address) : '该求车路线'
  return { dateStr, timeStr, routeStr }
}

async function getUserInfoDocIdByOpenid(openid) {
  const res = await db.collection('userInfo').where({ _openid: openid }).limit(1).get()
  const u = res && res.data && res.data[0] ? res.data[0] : null
  return u && u._id ? u._id : ''
}

function isPassengerObjArray(arr) {
  return Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const tripId = event.tripId || event.id || ''

  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }
  if (!tripId) return { ok: false, errorMsg: '缺少 tripId' }

  const carpoolRef = db.collection('Carpool').doc(tripId)
  const requestRef = db.collection('CarpoolRequest').doc(tripId)

  try {
    // ===== A) 先尝试 Carpool =====
    let carpool = null
    try {
      const s1 = await carpoolRef.get()
      carpool = s1 && s1.data ? s1.data : null
    } catch (e) {
      carpool = null
    }

    if (carpool) {
      const updateData = {}

      // 标记是否真的移除了乘客（用于决定是否维护 passengerCount/availSeatNum）
      let removed = false

      // 1) 处理 passengers：对象数组 [{_openid, joinedAt,...}] 或兼容字符串数组
      if (Array.isArray(carpool.passengers)) {
        if (carpool.passengers.length === 0) {
          // nothing
        } else if (isPassengerObjArray(carpool.passengers)) {
          const beforeLen = carpool.passengers.length
          const nextPassengers = carpool.passengers.filter(p => !(p && p._openid === openid))
          const afterLen = nextPassengers.length
          if (afterLen !== beforeLen) removed = true
          updateData.passengers = nextPassengers
        } else {
          const beforeLen = carpool.passengers.length
          const nextPassengers = carpool.passengers.filter(x => x !== openid)
          if (nextPassengers.length !== beforeLen) removed = true
          updateData.passengers = nextPassengers
        }
      }

      // 2) 兼容 passengerID：字符串数组
      if (Array.isArray(carpool.passengerID)) {
        const beforeLen = carpool.passengerID.length
        const nextPassengerID = carpool.passengerID.filter(x => x !== openid)
        if (nextPassengerID.length !== beforeLen) removed = true
        updateData.passengerID = nextPassengerID
      }

      // 3) 数量维护：仅在确实移除时维护（避免误减/误加）
      if (removed) {
        if (typeof carpool.passengerCount === 'number') {
          updateData.passengerCount = Math.max(0, carpool.passengerCount - 1)
        }
        if (typeof carpool.availSeatNum === 'number') {
          updateData.availSeatNum = carpool.availSeatNum + 1
        }
      }

      const keys = Object.keys(updateData)
      if (keys.length > 0) {
        await carpoolRef.update({ data: updateData })
      }

      // ✅ 通知拼车路线司机（仅在确实移除时）
      if (removed) {
        try {
          const driverOpenid = carpool._openid
          if (driverOpenid && driverOpenid !== openid) {
            const dep = (carpool.departures || [])[0] || {}
            const des = (carpool.destinations || [])[0] || {}
            const dateStr = dep.date || ''
            const timeStr = dep.time || ''
            const routeStr = (dep.address && des.address)
              ? `${dep.address} -> ${des.address}`
              : '该拼车行程'

            const title = '有乘客退出拼车行程'
            const content = `有乘客退出：${dateStr} ${timeStr} ${routeStr}。`

            await sendNotification(driverOpenid, 'PASSENGER_QUIT_CARPOOL', title, content, tripId, {
              tripId,
              passengerOpenid: openid,
              action: 'passenger_quit'
            })
          }
        } catch (eNotify) {
          console.warn('【editMyTripDetailPassenger】carpool notify failed:', eNotify)
        }
      }

      // 清理 userInfo 引用（尽力）
      try {
        const uid = await getUserInfoDocIdByOpenid(openid)
        if (uid) {
          await db.collection('userInfo').doc(uid).update({
            data: {
              tripPassenger: _.pull(tripId),
              tripPassengerCreate: _.pull(tripId)
            }
          })
        }
      } catch (e2) {
        console.warn('【editMyTripDetailPassenger】clean userInfo (carpool) failed:', e2)
      }

      return {
        ok: true,
        sourceType: 'carpool',
        removed
      }
    }

    // ===== B) 再尝试 CarpoolRequest =====
    let req = null
    try {
      const s2 = await requestRef.get()
      req = s2 && s2.data ? s2.data : null
    } catch (e) {
      req = null
    }

    if (!req) {
      return { ok: false, errorMsg: '未找到该路线' }
    }

    const updateReq = {}
    let removedReq = false

    // CarpoolRequest：passengerID（字符串数组）
    if (Array.isArray(req.passengerID)) {
      const beforeLen = req.passengerID.length
      const nextPassengerID = req.passengerID.filter(x => x !== openid)
      if (nextPassengerID.length !== beforeLen) removedReq = true
      updateReq.passengerID = nextPassengerID
    }

    if (removedReq && typeof req.passengerCount === 'number') {
      updateReq.passengerCount = Math.max(0, req.passengerCount - 1)
    }

    const reqKeys = Object.keys(updateReq)
    if (reqKeys.length > 0) {
      await requestRef.update({ data: updateReq })
    }

    // ✅ 通知求车路线创建者 + 司机（仅在确实移除时；不通知所有乘客）
    if (removedReq) {
      try {
        const ownerOpenid = req._openid || ''
        const driverOpenid = req.driverOpenid || req.driverID || ''

        const targets = [ownerOpenid, driverOpenid]
          .filter(Boolean)
          .filter(x => x !== openid) // 不给退出者自己发
        const uniqTargets = [...new Set(targets)]

        if (uniqTargets.length > 0) {
          // 保留原逻辑：手动拼 dep/des（buildRouteText 保留但不强制使用）
          const dep = (req.departures || [])[0] || {}
          const des = (req.destinations || [])[0] || {}
          const dateStr = dep.date || ''
          const timeStr = dep.time || ''
          const routeStr = (dep.address && des.address)
            ? `${dep.address} -> ${des.address}`
            : '该求车路线'

          const title = '有乘客退出求车路线'
          const content = `有乘客退出：${dateStr} ${timeStr} ${routeStr}。`

          await Promise.all(
            uniqTargets.map(toOpenid =>
              sendNotification(toOpenid, 'PASSENGER_QUIT_REQUEST', title, content, tripId, {
                requestId: tripId,
                passengerOpenid: openid,
                action: 'passenger_quit'
              })
            )
          )
        }
      } catch (eNotify2) {
        console.warn('【editMyTripDetailPassenger】request notify failed:', eNotify2)
      }
    }

    // 清理 userInfo 引用（尽力）
    try {
      const uid = await getUserInfoDocIdByOpenid(openid)
      if (uid) {
        await db.collection('userInfo').doc(uid).update({
          data: {
            tripPassenger: _.pull(tripId),
            tripPassengerCreate: _.pull(tripId)
          }
        })
      }
    } catch (e3) {
      console.warn('【editMyTripDetailPassenger】clean userInfo (request) failed:', e3)
    }

    return {
      ok: true,
      sourceType: 'request',
      removed: removedReq
    }
  } catch (e) {
    console.error('【editMyTripDetailPassenger】error:', e)
    return {
      ok: false,
      errorMsg: '操作失败（云函数异常）',
      debug: { errMsg: e && e.errMsg, message: e && e.message, stack: e && e.stack }
    }
  }
}