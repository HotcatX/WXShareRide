const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MAX_REQUEST_PASSENGERS = 4

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'request') return 'request'
  return 'carpool'
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value
}

async function sendNotification(toOpenid, type, title, content, carpoolId, extra) {
  if (!toOpenid) return false
  try {
    await db.collection('Notifications').add({
      data: {
        _openid: toOpenid,
        type,
        title,
        content,
        carpoolId: carpoolId || '',
        extra: extra || {},
        read: false,
        createdAt: db.serverDate()
      }
    })
    return true
  } catch (e) {
    console.error('joinTrip sendNotification error:', e)
    return false
  }
}

function getDisplayName(user) {
  return (user && (user.name || user.nickName || user.nickname)) || '一位乘客'
}

async function hasActiveBlock(blockerOpenid, targetOpenid) {
  if (!blockerOpenid || !targetOpenid || blockerOpenid === targetOpenid) return false
  const res = await db.collection('UserBlocks')
    .where({
      _openid: blockerOpenid,
      targetOpenid,
      active: true
    })
    .limit(1)
    .get()
  return !!(res.data && res.data.length)
}

async function checkBlockBetween(openidA, openidB) {
  if (!openidA || !openidB || openidA === openidB) return { blocked: false }
  const [aActiveBlock, bActiveBlock] = await Promise.all([
    hasActiveBlock(openidA, openidB),
    hasActiveBlock(openidB, openidA)
  ])
  if (aActiveBlock) return { blocked: true, blocker: openidA, target: openidB }
  if (bActiveBlock) return { blocked: true, blocker: openidB, target: openidA }
  return { blocked: false }
}

async function checkBlockWithMany(actorOpenid, targetOpenids) {
  const targets = Array.from(new Set((targetOpenids || []).filter(Boolean))).filter(id => id !== actorOpenid)
  for (const target of targets) {
    const res = await checkBlockBetween(actorOpenid, target)
    if (res.blocked) return res
  }
  return { blocked: false }
}

function buildRouteText(doc, fallback) {
  const dep = (doc && doc.departures || [])[0] || {}
  const des = (doc && doc.destinations || [])[0] || {}
  const dateStr = dep.date || ''
  const timeStr = dep.time || ''
  const routeStr = dep.address && des.address ? `${dep.address} -> ${des.address}` : fallback
  return { dateStr, timeStr, routeStr }
}

function cleanOpenid(value) {
  return String(value || '').trim()
}

function getCarpoolDriverOpenid(doc = {}) {
  return cleanOpenid(doc._openid)
}

function getRequestCreatorOpenid(doc = {}) {
  return cleanOpenid(doc._openid)
}

function getRequestDriverOpenid(doc = {}) {
  return cleanOpenid(doc.driverOpenid)
}

async function upsertPassengerUser(transaction, openid, tripId) {
  const res = await transaction.collection('userInfo').where({ _openid: openid }).limit(1).get()
  const now = new Date()

  if (!res.data.length) {
    await transaction.collection('userInfo').add({
      data: {
        _openid: openid,
        role: 'passenger',
        status: 'normal',
        profileCompleted: false,
        tripPassenger: [tripId],
        tripDriver: [],
        tripDriverHistory: [],
        tripPassengerHistory: [],
        createdTime: now,
        updateTime: now
      }
    })
    return
  }

  await transaction.collection('userInfo').doc(res.data[0]._id).update({
    data: {
      role: 'passenger',
      tripPassenger: _.addToSet(tripId),
      updateTime: now
    }
  })
}

async function joinCarpool(event, openid) {
  const tripId = String(event.tripId || event.id || '').trim()
  if (!tripId) return { ok: false, success: false, errorMsg: '缺少 tripId' }

  const preTripRes = await db.collection('Carpool').doc(tripId).get().catch(() => null)
  const preTrip = preTripRes && preTripRes.data
  if (preTrip) {
    const prePassengers = Array.isArray(preTrip.passengers) ? preTrip.passengers.filter(Boolean) : []
    const alreadyInPre = prePassengers.some(p => p && p._openid === openid)
    if (!alreadyInPre) {
      const existingPassengerOpenids = prePassengers
        .map(p => (typeof p === 'string' ? p : p && p._openid))
        .filter(Boolean)
      const blockCheck = await checkBlockWithMany(openid, [getCarpoolDriverOpenid(preTrip)].concat(existingPassengerOpenids))
      if (blockCheck.blocked) {
        return { ok: false, success: false, errorMsg: '你和该路线成员之间存在拉黑关系，无法加入' }
      }
    }
  }

  let tripSnapshot = null
  let passengerForMsg = null
  let alreadyJoined = false

  const transactionResult = await db.runTransaction(async (transaction) => {
    const tripRef = transaction.collection('Carpool').doc(tripId)
    const tripRes = await tripRef.get()
    const trip = tripRes && tripRes.data
    if (!trip) return { ok: false, success: false, errorMsg: '路线不存在' }

    const status = normalizeTripStatus(trip.status)
    const availSeatNum = Number(trip.availSeatNum == null ? trip.passengerCount : trip.availSeatNum)
    if (status === 'past' || availSeatNum <= 0) {
      return { ok: false, success: false, errorMsg: '该路线已结束或已满员' }
    }
    const driverOpenid = getCarpoolDriverOpenid(trip)
    if (driverOpenid && driverOpenid === openid) {
      return { ok: false, success: false, errorMsg: '无法加入自己发布的路线' }
    }

    const passengers = Array.isArray(trip.passengers) ? trip.passengers.filter(Boolean) : []
    alreadyJoined = passengers.some(p => p && p._openid === openid)
    if (alreadyJoined) {
      await upsertPassengerUser(transaction, openid, tripId)
      tripSnapshot = trip
      return { ok: true, success: true, alreadyJoined: true }
    }

    const passengerInfo = event.passengerInfo || {}
    const pickupAddress = String(passengerInfo.pickupAddress || event.pickupAddress || '').trim()
    const dropoffAddress = String(passengerInfo.dropoffAddress || event.dropoffAddress || '').trim()
    const fixedPassenger = {
      name: passengerInfo.name,
      nickName: passengerInfo.nickName,
      nickname: passengerInfo.nickname,
      avatarUrl: passengerInfo.avatarUrl,
      _openid: openid,
      joinedAt: new Date(),
      pickupAddress,
      dropoffAddress
    }

    const nextAvail = availSeatNum - 1
    await tripRef.update({
      data: {
        availSeatNum: _.inc(-1),
        passengers: _.push(fixedPassenger),
        status: nextAvail <= 0 ? 'full' : 'open',
        updatedAt: new Date()
      }
    })

    await upsertPassengerUser(transaction, openid, tripId)
    tripSnapshot = trip
    passengerForMsg = fixedPassenger
    return { ok: true, success: true, newAvail: nextAvail }
  })

  if (!transactionResult || !transactionResult.success || alreadyJoined) return transactionResult

  const driverOpenid = tripSnapshot && tripSnapshot._openid
  const route = buildRouteText(tripSnapshot, '本次行程')
  const passengerName = getDisplayName(passengerForMsg)
  await sendNotification(
    driverOpenid,
    'PASSENGER_JOIN',
    '有乘客加入你的行程',
    `${passengerName} 加入了 ${route.dateStr} ${route.timeStr} ${route.routeStr} 的行程`,
    tripId,
    {
      role: 'driver',
      passengerOpenid: openid
    }
  )

  return transactionResult
}

async function joinRequest(event, openid) {
  const requestId = String(event.requestId || event.tripId || event.id || '').trim()
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }

  const preReqRes = await db.collection('CarpoolRequest').doc(requestId).get().catch(() => null)
  const preReq = preReqRes && preReqRes.data
  if (preReq) {
    const passengerIds = Array.isArray(preReq.passengerID) ? preReq.passengerID.filter(Boolean) : []
    const preCreatorOpenid = getRequestCreatorOpenid(preReq)
    const preDriverOpenid = getRequestDriverOpenid(preReq)
    if (preCreatorOpenid && preCreatorOpenid === openid) {
      return { ok: false, success: false, errorMsg: '不能加入自己发布的求车' }
    }
    if (preDriverOpenid && preDriverOpenid === openid) {
      return { ok: false, success: false, errorMsg: '你已是该路线司机，无法作为乘客加入' }
    }
    if (!passengerIds.includes(openid)) {
      const blockCheck = await checkBlockWithMany(openid, [preCreatorOpenid, preDriverOpenid].concat(passengerIds))
      if (blockCheck.blocked) {
        return { ok: false, success: false, errorMsg: '你和该路线成员之间存在拉黑关系，无法加入' }
      }
    }
  }

  let reqForMsg = null
  let notifyTargets = []
  let alreadyJoined = false

  const result = await db.runTransaction(async (transaction) => {
    const reqRef = transaction.collection('CarpoolRequest').doc(requestId)
    const reqDoc = await reqRef.get()
    const req = reqDoc && reqDoc.data
    if (!req) return { ok: false, success: false, errorMsg: '未找到该路线' }

    const status = normalizeTripStatus(req.status)
    if (status !== 'open') {
      return { ok: false, success: false, errorMsg: '该路线不可加入（已关闭或已结束）' }
    }
    const creatorOpenid = getRequestCreatorOpenid(req)
    const driverOpenid = getRequestDriverOpenid(req)
    if (creatorOpenid && creatorOpenid === openid) {
      return { ok: false, success: false, errorMsg: '不能加入自己发布的求车' }
    }
    if (driverOpenid && driverOpenid === openid) {
      return { ok: false, success: false, errorMsg: '你已是该路线司机，无法作为乘客加入' }
    }

    const passengerIds = Array.isArray(req.passengerID) ? req.passengerID.filter(Boolean) : []
    alreadyJoined = passengerIds.includes(openid)
    const passengerCountRaw = Number(req.passengerCount)
    const baseCount = Number.isFinite(passengerCountRaw) ? passengerCountRaw : passengerIds.length
    const nextCount = alreadyJoined ? baseCount : baseCount + 1

    if (!alreadyJoined && nextCount > MAX_REQUEST_PASSENGERS) {
      return { ok: false, success: false, errorMsg: '该路线已满员' }
    }

    if (!alreadyJoined) {
      await reqRef.update({
        data: {
          passengerID: _.addToSet(openid),
          passengerCount: nextCount,
          status: nextCount >= MAX_REQUEST_PASSENGERS ? 'full' : 'open',
          updatedAt: new Date()
        }
      })
    }

    await upsertPassengerUser(transaction, openid, requestId)

    const targets = [creatorOpenid, driverOpenid]
      .filter(Boolean)
      .filter(target => target !== openid)
    notifyTargets = Array.from(new Set(targets))
    reqForMsg = req

    return { ok: true, success: true, alreadyJoined }
  })

  if (!result || !result.success || alreadyJoined) return result

  const route = buildRouteText(reqForMsg, '该求车路线')
  const title = '有乘客加入求车路线'
  const content = `有新乘客加入：${route.dateStr} ${route.timeStr} ${route.routeStr}。`

  await Promise.all(notifyTargets.map(toOpenid =>
    sendNotification(
      toOpenid,
      'PASSENGER_JOIN_REQUEST',
      title,
      content,
      requestId,
      {
        requestId,
        passengerOpenid: openid,
        action: 'passenger_join'
      }
    )
  ))

  return result
}

exports.main = async (event = {}) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, success: false, errorMsg: '未获取到 openid' }

  try {
    const type = normalizeType(event.type)
    return type === 'request'
      ? await joinRequest(event, openid)
      : await joinCarpool(event, openid)
  } catch (e) {
    console.error('joinTrip error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '加入失败'
    }
  }
}
