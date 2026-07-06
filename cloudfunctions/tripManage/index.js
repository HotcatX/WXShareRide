const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MAX_REQUEST_PASSENGERS = 4
const RATING_PRIOR = 4.7
const RATING_PRIOR_WEIGHT = 3

const ROLE_RATING_FIELDS = {
  driver: {
    sum: 'driverRatingSum',
    count: 'driverRatingCount',
    avg: 'driverRatingAvg',
    weightedAvg: 'driverRatingWeightedAvg'
  },
  passenger: {
    sum: 'passengerRatingSum',
    count: 'passengerRatingCount',
    avg: 'passengerRatingAvg',
    weightedAvg: 'passengerRatingWeightedAvg'
  }
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)))
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'request') return 'request'
  return 'carpool'
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value
}

function cleanText(value, max = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max)
}

function getReason(event) {
  return cleanText(event && (event.reason || event.message || event.content), 180)
}

function requireReason(event, label) {
  const reason = getReason(event)
  if (!reason) {
    return { ok: false, errorMsg: `${label || '该操作'}需要填写理由` }
  }
  return { ok: true, reason }
}

function buildRouteInfo(doc = {}, fallback = '本次行程') {
  const dep = (Array.isArray(doc.departures) ? doc.departures : [])[0] || {}
  const des = (Array.isArray(doc.destinations) ? doc.destinations : [])[0] || {}
  const dateStr = dep.date || ''
  const timeStr = dep.time || ''
  const routeStr = dep.address && des.address ? `${dep.address} -> ${des.address}` : fallback
  return { dateStr, timeStr, routeStr }
}

function withReason(content, reason) {
  const text = cleanText(reason, 180)
  return text ? `${content}。理由：${text}` : content
}

function addId(set, value) {
  const id = cleanText(value, 80)
  if (id) set.add(id)
}

function getCarpoolPassengerOpenids(doc = {}) {
  const ids = new Set()
  ;(Array.isArray(doc.passengers) ? doc.passengers : []).forEach(p => {
    addId(ids, p && p._openid)
  })
  return Array.from(ids)
}

function getRequestPassengerOpenids(doc = {}) {
  const ids = new Set()
  ;(Array.isArray(doc.passengerID) ? doc.passengerID : []).forEach(id => addId(ids, id))
  return Array.from(ids)
}

function getRequestDriverOpenid(doc = {}) {
  return cleanText(doc.driverOpenid, 80)
}

function getRequestCreatorOpenid(doc = {}) {
  return cleanText(doc._openid, 80)
}

function getCarpoolDriverOpenid(doc = {}) {
  return cleanText(doc._openid, 80)
}

async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) return false
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
    return true
  } catch (e) {
    console.error('tripManage sendNotification error:', e)
    return false
  }
}

async function logAction(data) {
  try {
    await db.collection('TripActions').add({
      data: Object.assign({}, data, {
        createdAt: db.serverDate()
      })
    })
  } catch (e) {
    console.error('tripManage logAction error:', e)
  }
}

async function getUser(openid) {
  if (!openid) return null
  const res = await db.collection('userInfo').where({ _openid: openid }).limit(1).get()
  return res.data && res.data[0] ? res.data[0] : null
}

async function updateUserByOpenid(openid, data, createData = {}) {
  if (!openid) return { ok: false, errorMsg: '缺少 openid' }
  const user = await getUser(openid)
  if (!user) {
    await db.collection('userInfo').add({
      data: Object.assign({
        _openid: openid,
        status: 'normal',
        profileCompleted: false,
        tripDriver: [],
        tripPassenger: [],
        tripDriverHistory: [],
        tripPassengerHistory: [],
        createdTime: new Date(),
        updateTime: new Date()
      }, createData)
    })
    return { ok: true, created: true }
  }
  await db.collection('userInfo').doc(user._id).update({ data })
  return { ok: true, created: false }
}

async function patchExistingUserByOpenid(openid, data) {
  const user = await getUser(openid)
  if (!user || !user._id) return false
  await db.collection('userInfo').doc(user._id).update({ data })
  return true
}

async function removeIdFromUserArray(openid, fieldName, id) {
  if (!openid || !fieldName || !id) return false
  try {
    await patchExistingUserByOpenid(openid, {
      [fieldName]: _.pull(id),
      updateTime: db.serverDate(),
      updatedAt: db.serverDate()
    })
    return true
  } catch (e) {
    console.error('tripManage removeIdFromUserArray error:', e)
    return false
  }
}

async function userArrayHas(openid, fieldName, id) {
  const user = await getUser(openid)
  if (!user) return false
  const value = user[fieldName]
  return Array.isArray(value) && value.includes(id)
}

function computeWeightedRating(sum, count) {
  const c = Number(count)
  const s = Number(sum)
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(s)) return 0
  const value = (s + RATING_PRIOR * RATING_PRIOR_WEIGHT) / (c + RATING_PRIOR_WEIGHT)
  return Math.min(5, Math.max(0, Number(value.toFixed(1))))
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
  const targets = uniq(targetOpenids).filter(id => id !== actorOpenid)
  for (const target of targets) {
    const res = await checkBlockBetween(actorOpenid, target)
    if (res.blocked) return res
  }
  return { blocked: false }
}

function buildClearDriverFields(req) {
  const next = {}
  if (Object.prototype.hasOwnProperty.call(req, 'driverOpenid')) next.driverOpenid = ''
  if (!Object.keys(next).length) {
    next.driverOpenid = ''
  }
  return next
}

async function kickPassengerFromCarpool(event, actorOpenid) {
  const tripId = cleanText(event.tripId || event.id, 80)
  const targetOpenid = cleanText(event.targetOpenid, 80)
  if (!tripId) return { ok: false, success: false, errorMsg: '缺少 tripId' }
  if (!targetOpenid) return { ok: false, success: false, errorMsg: '缺少乘客 openid' }
  const reasonCheck = requireReason(event, '剔除乘客')
  if (!reasonCheck.ok) return reasonCheck

  const snap = await db.collection('Carpool').doc(tripId).get()
  const trip = snap && snap.data
  if (!trip) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const driverOpenid = getCarpoolDriverOpenid(trip)
  if (driverOpenid !== actorOpenid) return { ok: false, success: false, errorMsg: '你不是该路线司机，无法操作' }

  const passengerIds = getCarpoolPassengerOpenids(trip)
  if (!passengerIds.includes(targetOpenid)) return { ok: false, success: false, errorMsg: '该乘客不在路线中' }

  const updateData = {
    availSeatNum: _.inc(1),
    updatedAt: db.serverDate()
  }
  if (Array.isArray(trip.passengers)) {
    updateData.passengers = trip.passengers.filter(item => {
      if (typeof item === 'string') return item !== targetOpenid
      return !(item && item._openid === targetOpenid)
    })
  }
  if (normalizeTripStatus(trip.status) !== 'past') updateData.status = 'open'

  await db.collection('Carpool').doc(tripId).update({ data: updateData })
  await Promise.all([
    removeIdFromUserArray(targetOpenid, 'tripPassenger', tripId),
    removeIdFromUserArray(targetOpenid, 'tripPassengerCreate', tripId)
  ])

  const route = buildRouteInfo(trip, '该行程')
  await sendNotification(
    targetOpenid,
    'DRIVER_KICK',
    '你被移出行程',
    withReason(`你被移出了 ${route.dateStr} ${route.timeStr} ${route.routeStr} 的行程`, reasonCheck.reason),
    tripId,
    { role: 'passenger', driverOpenid, action: 'kickPassenger', reason: reasonCheck.reason }
  )
  await logAction({ action: 'kickPassenger', type: 'carpool', tripId, actorOpenid, targetOpenid, reason: reasonCheck.reason })
  return { ok: true, success: true, action: 'kickPassenger' }
}

async function deleteCarpool(event, actorOpenid) {
  const tripId = cleanText(event.tripId || event.id, 80)
  if (!tripId) return { ok: false, success: false, errorMsg: '缺少 tripId' }
  const reasonCheck = requireReason(event, '删除路线')
  if (!reasonCheck.ok) return reasonCheck

  const snap = await db.collection('Carpool').doc(tripId).get()
  const trip = snap && snap.data
  if (!trip) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const driverOpenid = getCarpoolDriverOpenid(trip)
  if (driverOpenid !== actorOpenid) return { ok: false, success: false, errorMsg: '你不是该路线司机，无法删除' }

  const passengerOpenids = getCarpoolPassengerOpenids(trip)
  const route = buildRouteInfo(trip, '该行程')

  await db.collection('Carpool').doc(tripId).remove()

  await Promise.all([
    removeIdFromUserArray(driverOpenid, 'tripDriver', tripId),
    ...passengerOpenids.map(pid => removeIdFromUserArray(pid, 'tripPassenger', tripId)),
    ...passengerOpenids.map(pid => sendNotification(
      pid,
      'DRIVER_DELETE',
      '行程已被司机取消',
      withReason(`${route.dateStr} ${route.timeStr} ${route.routeStr} 的行程已被司机取消`, reasonCheck.reason),
      tripId,
      { role: 'passenger', driverOpenid, action: 'deleteTrip', reason: reasonCheck.reason }
    ))
  ])

  await logAction({ action: 'deleteTrip', type: 'carpool', tripId, actorOpenid, reason: reasonCheck.reason, targets: passengerOpenids })
  return { ok: true, success: true, action: 'deleteTrip' }
}

async function quitCarpoolPassenger(event, actorOpenid) {
  const tripId = cleanText(event.tripId || event.id, 80)
  if (!tripId) return { ok: false, success: false, errorMsg: '缺少 tripId' }
  const reason = getReason(event)

  const snap = await db.collection('Carpool').doc(tripId).get()
  const trip = snap && snap.data
  if (!trip) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const passengerOpenids = getCarpoolPassengerOpenids(trip)
  if (!passengerOpenids.includes(actorOpenid)) return { ok: false, success: false, errorMsg: '你不在该路线中' }

  const updateData = {
    availSeatNum: _.inc(1),
    updatedAt: db.serverDate()
  }
  if (Array.isArray(trip.passengers)) {
    updateData.passengers = trip.passengers.filter(item => {
      if (typeof item === 'string') return item !== actorOpenid
      return !(item && item._openid === actorOpenid)
    })
  }
  if (normalizeTripStatus(trip.status) !== 'past') updateData.status = 'open'

  await db.collection('Carpool').doc(tripId).update({ data: updateData })
  await removeIdFromUserArray(actorOpenid, 'tripPassenger', tripId)

  const driverOpenid = getCarpoolDriverOpenid(trip)
  const route = buildRouteInfo(trip, '该行程')
  await sendNotification(
    driverOpenid,
    'PASSENGER_QUIT_CARPOOL',
    '有乘客退出行程',
    withReason(`有乘客退出：${route.dateStr} ${route.timeStr} ${route.routeStr}`, reason),
    tripId,
    { tripId, passengerOpenid: actorOpenid, action: 'passenger_quit', reason }
  )

  await logAction({ action: 'quitTrip', type: 'carpool', tripId, actorOpenid, reason })
  return { ok: true, success: true, action: 'quitTrip', type: 'carpool' }
}

async function kickDriverFromRequest(event, actorOpenid) {
  const requestId = cleanText(event.requestId || event.tripId || event.id, 80)
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }
  const reasonCheck = requireReason(event, '剔除司机')
  if (!reasonCheck.ok) return reasonCheck

  const snap = await db.collection('CarpoolRequest').doc(requestId).get()
  const req = snap && snap.data
  if (!req) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const creatorOpenid = getRequestCreatorOpenid(req)
  if (creatorOpenid !== actorOpenid) return { ok: false, success: false, errorMsg: '仅创建者可执行该操作' }
  const driverOpenid = getRequestDriverOpenid(req)
  if (!driverOpenid) return { ok: false, success: false, errorMsg: '当前无司机' }

  const updateData = Object.assign(buildClearDriverFields(req), { updatedAt: db.serverDate() })
  if (normalizeTripStatus(req.status) !== 'past') updateData.status = 'open'
  await db.collection('CarpoolRequest').doc(requestId).update({ data: updateData })
  await removeIdFromUserArray(driverOpenid, 'tripDriverJoin', requestId)

  const route = buildRouteInfo(req, '该求车路线')
  await sendNotification(
    driverOpenid,
    'KICKED_FROM_REQUEST',
    '你已被移出该求车路线',
    withReason(`你已被创建者移出：${route.dateStr} ${route.timeStr} ${route.routeStr}`, reasonCheck.reason),
    requestId,
    { action: 'kickDriver', requestId, by: actorOpenid, reason: reasonCheck.reason }
  )
  await logAction({ action: 'kickDriver', type: 'request', tripId: requestId, actorOpenid, targetOpenid: driverOpenid, reason: reasonCheck.reason })
  return { ok: true, success: true, action: 'kickDriver' }
}

async function kickPassengerFromRequest(event, actorOpenid) {
  const requestId = cleanText(event.requestId || event.tripId || event.id, 80)
  const targetOpenid = cleanText(event.targetOpenid, 80)
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }
  if (!targetOpenid) return { ok: false, success: false, errorMsg: '缺少乘客 openid' }
  const reasonCheck = requireReason(event, '剔除乘客')
  if (!reasonCheck.ok) return reasonCheck

  const snap = await db.collection('CarpoolRequest').doc(requestId).get()
  const req = snap && snap.data
  if (!req) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const creatorOpenid = getRequestCreatorOpenid(req)
  if (creatorOpenid !== actorOpenid) return { ok: false, success: false, errorMsg: '仅创建者可执行该操作' }
  if (targetOpenid === creatorOpenid) return { ok: false, success: false, errorMsg: '不能剔除创建者' }
  const passengerOpenids = getRequestPassengerOpenids(req)
  if (!passengerOpenids.includes(targetOpenid)) return { ok: false, success: false, errorMsg: '该乘客不在队列中' }

  const updateData = {
    passengerID: _.pull(targetOpenid),
    updatedAt: db.serverDate()
  }
  if (typeof req.passengerCount === 'number') updateData.passengerCount = Math.max(0, req.passengerCount - 1)
  if (normalizeTripStatus(req.status) !== 'past') updateData.status = 'open'

  await db.collection('CarpoolRequest').doc(requestId).update({ data: updateData })
  await removeIdFromUserArray(targetOpenid, 'tripPassenger', requestId)

  const route = buildRouteInfo(req, '该求车路线')
  await sendNotification(
    targetOpenid,
    'KICKED_FROM_REQUEST',
    '你已被移出该求车路线',
    withReason(`你已被创建者移出：${route.dateStr} ${route.timeStr} ${route.routeStr}`, reasonCheck.reason),
    requestId,
    { action: 'kickPassenger', requestId, by: actorOpenid, reason: reasonCheck.reason }
  )
  await logAction({ action: 'kickPassenger', type: 'request', tripId: requestId, actorOpenid, targetOpenid, reason: reasonCheck.reason })
  return { ok: true, success: true, action: 'kickPassenger' }
}

async function deleteRequest(event, actorOpenid) {
  const requestId = cleanText(event.requestId || event.tripId || event.id, 80)
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }
  const reasonCheck = requireReason(event, '删除路线')
  if (!reasonCheck.ok) return reasonCheck

  const snap = await db.collection('CarpoolRequest').doc(requestId).get()
  const req = snap && snap.data
  if (!req) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const creatorOpenid = getRequestCreatorOpenid(req)
  if (creatorOpenid !== actorOpenid) return { ok: false, success: false, errorMsg: '仅创建者可执行该操作' }

  const driverOpenid = getRequestDriverOpenid(req)
  const passengerOpenids = getRequestPassengerOpenids(req)
  const notifyTargets = uniq([driverOpenid].concat(passengerOpenids)).filter(id => id && id !== actorOpenid)
  const route = buildRouteInfo(req, '该求车路线')

  await Promise.all([
    removeIdFromUserArray(creatorOpenid, 'tripPassengerCreate', requestId),
    driverOpenid ? removeIdFromUserArray(driverOpenid, 'tripDriverJoin', requestId) : Promise.resolve(false),
    ...passengerOpenids.map(pid => removeIdFromUserArray(pid, 'tripPassenger', requestId))
  ])

  const remain = []
  if (await userArrayHas(creatorOpenid, 'tripPassengerCreate', requestId)) {
    remain.push({ openid: creatorOpenid, field: 'tripPassengerCreate' })
  }
  for (const pid of passengerOpenids) {
    if (await userArrayHas(pid, 'tripPassenger', requestId)) remain.push({ openid: pid, field: 'tripPassenger' })
  }
  if (driverOpenid && await userArrayHas(driverOpenid, 'tripDriverJoin', requestId)) {
    remain.push({ openid: driverOpenid, field: 'tripDriverJoin' })
  }
  if (remain.length) {
    return {
      ok: false,
      success: false,
      errorMsg: '成员记录清理未完成，已阻止删除路线，请重试',
      remain
    }
  }

  await db.collection('CarpoolRequest').doc(requestId).remove()

  await Promise.all(notifyTargets.map(to => sendNotification(
      to,
      'REQUEST_DELETED',
      '求车路线已被删除',
      withReason(`该路线已被创建者删除：${route.dateStr} ${route.timeStr} ${route.routeStr}`, reasonCheck.reason),
      requestId,
      { action: 'deleteTrip', requestId, by: actorOpenid, reason: reasonCheck.reason }
    )))

  await logAction({ action: 'deleteTrip', type: 'request', tripId: requestId, actorOpenid, reason: reasonCheck.reason, targets: notifyTargets })
  return { ok: true, success: true, action: 'deleteTrip' }
}

async function quitRequestDriver(event, actorOpenid) {
  const requestId = cleanText(event.requestId || event.tripId || event.id, 80)
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }

  const snap = await db.collection('CarpoolRequest').doc(requestId).get()
  const req = snap && snap.data
  if (!req) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const driverOpenid = getRequestDriverOpenid(req)
  if (driverOpenid !== actorOpenid) return { ok: false, success: false, errorMsg: '你不是该路线司机，无法退出' }

  const updateData = Object.assign(buildClearDriverFields(req), { updatedAt: db.serverDate() })
  if (normalizeTripStatus(req.status) !== 'past') updateData.status = 'open'
  await db.collection('CarpoolRequest').doc(requestId).update({ data: updateData })
  await removeIdFromUserArray(actorOpenid, 'tripDriverJoin', requestId)

  const route = buildRouteInfo(req, '该求车路线')
  const passengerOpenids = getRequestPassengerOpenids(req)
  await Promise.all(passengerOpenids
    .filter(id => id !== actorOpenid)
    .map(id => sendNotification(
      id,
      'DRIVER_QUIT_REQUEST',
      '司机已退出该求车路线',
      `司机已退出你加入的 ${route.dateStr} ${route.timeStr} ${route.routeStr}，该路线已恢复为可接单状态。`,
      requestId,
      { requestId, driverOpenid: actorOpenid, action: 'driver_quit' }
    )))

  await logAction({ action: 'quitDriver', type: 'request', tripId: requestId, actorOpenid })
  return { ok: true, success: true, action: 'quitDriver' }
}

async function quitRequestPassenger(event, actorOpenid) {
  const requestId = cleanText(event.requestId || event.tripId || event.id, 80)
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }
  const reason = getReason(event)

  const snap = await db.collection('CarpoolRequest').doc(requestId).get()
  const req = snap && snap.data
  if (!req) return { ok: false, success: false, errorMsg: '未找到该路线' }
  const creatorOpenid = getRequestCreatorOpenid(req)
  if (creatorOpenid === actorOpenid) return { ok: false, success: false, errorMsg: '创建者请使用删除路线' }
  const passengerOpenids = getRequestPassengerOpenids(req)
  if (!passengerOpenids.includes(actorOpenid)) return { ok: false, success: false, errorMsg: '你不在该路线中' }

  const updateData = {
    passengerID: _.pull(actorOpenid),
    updatedAt: db.serverDate()
  }
  if (typeof req.passengerCount === 'number') updateData.passengerCount = Math.max(0, req.passengerCount - 1)
  if (normalizeTripStatus(req.status) !== 'past') updateData.status = 'open'

  await db.collection('CarpoolRequest').doc(requestId).update({ data: updateData })
  await removeIdFromUserArray(actorOpenid, 'tripPassenger', requestId)

  const driverOpenid = getRequestDriverOpenid(req)
  const targets = uniq([creatorOpenid, driverOpenid]).filter(id => id && id !== actorOpenid)
  const route = buildRouteInfo(req, '该求车路线')
  await Promise.all(targets.map(id => sendNotification(
    id,
    'PASSENGER_QUIT_REQUEST',
    '有乘客退出求车路线',
    withReason(`有乘客退出：${route.dateStr} ${route.timeStr} ${route.routeStr}`, reason),
    requestId,
    { requestId, passengerOpenid: actorOpenid, action: 'passenger_quit', reason }
  )))

  await logAction({ action: 'quitTrip', type: 'request', tripId: requestId, actorOpenid, reason })
  return { ok: true, success: true, action: 'quitTrip', type: 'request' }
}

async function acceptRequest(event, actorOpenid) {
  const requestId = cleanText(event.requestId || event.tripId || event.id, 80)
  if (!requestId) return { ok: false, success: false, errorMsg: '缺少 requestId' }

  let passengersToNotify = []
  let reqSnapshotForMsg = null

  const preSnap = await db.collection('CarpoolRequest').doc(requestId).get()
  const preReq = preSnap && preSnap.data
  if (!preReq) return { ok: false, success: false, errorMsg: '未找到该求车记录' }
  const preOwnerOpenid = getRequestCreatorOpenid(preReq)
  const prePassengerIds = getRequestPassengerOpenids(preReq)
  const preBlockCheck = await checkBlockWithMany(actorOpenid, [preOwnerOpenid].concat(prePassengerIds))
  if (preBlockCheck.blocked) {
    return { ok: false, success: false, errorMsg: '你和该路线成员之间存在拉黑关系，无法接单' }
  }

  const result = await db.runTransaction(async (transaction) => {
    const reqRef = transaction.collection('CarpoolRequest').doc(requestId)
    const snap = await reqRef.get()
    const req = snap && snap.data
    if (!req) return { ok: false, success: false, errorMsg: '未找到该求车记录' }

    const ownerOpenid = getRequestCreatorOpenid(req)
    if (ownerOpenid && ownerOpenid === actorOpenid) {
      return { ok: false, success: false, errorMsg: '不能接自己发布的求车' }
    }

    const passengerIds = getRequestPassengerOpenids(req)
    if (passengerIds.includes(actorOpenid)) {
      return { ok: false, success: false, errorMsg: '你已作为乘客加入该路线，无法再接单' }
    }

    const existingDriver = getRequestDriverOpenid(req)
    if (existingDriver) {
      if (existingDriver === actorOpenid) return { ok: true, success: true, alreadyAccepted: true }
      return { ok: false, success: false, errorMsg: '该求车已被其他司机接单' }
    }

    if (normalizeTripStatus(req.status) !== 'open') {
      return { ok: false, success: false, errorMsg: `当前状态不可接单：${req.status || 'unknown'}` }
    }

    await reqRef.update({
      data: {
        driverOpenid: actorOpenid,
        updatedAt: new Date()
      }
    })

    const userInfoQueryRes = await transaction.collection('userInfo').where({ _openid: actorOpenid }).limit(1).get()
    const list = (userInfoQueryRes && userInfoQueryRes.data) ? userInfoQueryRes.data : []
    if (list.length === 0) {
      await transaction.collection('userInfo').add({
        data: {
          _openid: actorOpenid,
          openid: actorOpenid,
          role: 'driver',
          tripDriverJoin: [requestId],
          tripDriver: [],
          tripPassenger: [],
          tripDriverHistory: [],
          tripPassengerHistory: [],
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
    } else {
      await transaction.collection('userInfo').doc(list[0]._id).update({
        data: {
          tripDriverJoin: _.addToSet(requestId),
          updatedAt: new Date()
        }
      })
    }

    passengersToNotify = passengerIds
    reqSnapshotForMsg = req
    return { ok: true, success: true }
  })

  if (!result || !result.success || result.alreadyAccepted) return result

  const uniqPassengers = uniq(passengersToNotify).filter(id => id !== actorOpenid)
  if (uniqPassengers.length && reqSnapshotForMsg) {
    const route = buildRouteInfo(reqSnapshotForMsg, '该求车路线')
    await Promise.all(uniqPassengers.map(id => sendNotification(
      id,
      'DRIVER_ACCEPT_REQUEST',
      '已有司机接单',
      `已有司机接单：${route.dateStr} ${route.timeStr} ${route.routeStr}。你可以在“我的求车/路线详情”里查看。`,
      requestId,
      { requestId, driverOpenid: actorOpenid, action: 'driver_accept' }
    )))
  }

  await logAction({ action: 'acceptRequest', type: 'request', tripId: requestId, actorOpenid })
  return result
}

async function blockUser(event, actorOpenid) {
  const targetOpenid = cleanText(event.targetOpenid, 80)
  if (!targetOpenid) return { ok: false, success: false, errorMsg: '缺少拉黑对象' }
  if (targetOpenid === actorOpenid) return { ok: false, success: false, errorMsg: '不能拉黑自己' }

  const reason = getReason(event)
  const existingBlockRes = await db.collection('UserBlocks')
    .where({
      _openid: actorOpenid,
      targetOpenid,
      active: true
    })
    .limit(1)
    .get()
  const existingBlock = existingBlockRes.data && existingBlockRes.data[0]
  if (existingBlock && existingBlock._id) {
    await db.collection('UserBlocks').doc(existingBlock._id).update({
      data: {
        blockerOpenid: actorOpenid,
        reason,
        updatedAt: db.serverDate()
      }
    })
  } else {
    await db.collection('UserBlocks').add({
      data: {
        _openid: actorOpenid,
        blockerOpenid: actorOpenid,
        targetOpenid,
        reason,
        active: true,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
  }
  await logAction({ action: 'blockUser', type: normalizeType(event.type), tripId: cleanText(event.tripId || event.requestId || event.id, 80), actorOpenid, targetOpenid, reason })
  return { ok: true, success: true, action: 'blockUser' }
}

async function getBlockList(event, actorOpenid) {
  const blockedIds = new Set()
  let activeBlocks = []

  try {
    const blockRes = await db.collection('UserBlocks')
      .where({
        _openid: actorOpenid,
        active: true
      })
      .limit(100)
      .get()
    activeBlocks = blockRes.data || []
    activeBlocks.forEach(item => addId(blockedIds, item && item.targetOpenid))
  } catch (e) {
    console.error('tripManage getBlockList UserBlocks error:', e)
  }

  const ids = Array.from(blockedIds)
  if (!ids.length) return { ok: true, success: true, action: 'getBlockList', list: [], count: 0 }

  const userMap = {}
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    try {
      const res = await db.collection('userInfo')
        .where({ _openid: _.in(chunk) })
        .limit(20)
        .get()
      ;(res.data || []).forEach(item => {
        if (item && item._openid) userMap[item._openid] = item
      })
    } catch (e) {
      console.error('tripManage getBlockList userInfo error:', e)
    }
  }

  const blockMetaMap = {}
  activeBlocks.forEach(item => {
    const id = cleanText(item && item.targetOpenid, 80)
    if (!id || blockMetaMap[id]) return
    blockMetaMap[id] = item
  })

  const list = ids.map(id => {
    const info = userMap[id] || {}
    const meta = blockMetaMap[id] || {}
    return {
      openid: id,
      targetOpenid: id,
      name: info.name || info.nickName || '未设置昵称',
      avatarUrl: info.avatarUrl || '',
      wechatID: info.wechatID || '',
      reason: meta.reason || '',
      blockedAt: meta.createdAt || '',
      updatedAt: meta.updatedAt || ''
    }
  })

  return { ok: true, success: true, action: 'getBlockList', list, count: list.length }
}

async function unblockUser(event, actorOpenid) {
  const targetOpenid = cleanText(event.targetOpenid, 80)
  if (!targetOpenid) return { ok: false, success: false, errorMsg: '缺少解除对象' }
  try {
    await db.collection('UserBlocks')
      .where({
        _openid: actorOpenid,
        targetOpenid,
        active: true
      })
      .update({
        data: {
          active: false,
          updatedAt: db.serverDate()
        }
      })
  } catch (e) {
    console.error('tripManage unblockUser UserBlocks update error:', e)
  }
  await logAction({ action: 'unblockUser', type: normalizeType(event.type), tripId: cleanText(event.tripId || event.requestId || event.id, 80), actorOpenid, targetOpenid })
  return { ok: true, success: true, action: 'unblockUser' }
}

async function getTripForParticipantCheck(type, tripId) {
  const collection = type === 'request' ? 'CarpoolRequest' : 'Carpool'
  const snap = await db.collection(collection).doc(tripId).get()
  const doc = snap && snap.data
  if (!doc) return null
  const participants = type === 'request'
    ? uniq([getRequestCreatorOpenid(doc), getRequestDriverOpenid(doc)].concat(getRequestPassengerOpenids(doc)))
    : uniq([getCarpoolDriverOpenid(doc)].concat(getCarpoolPassengerOpenids(doc)))
  return { doc, collection, participants }
}

function getParticipantRole(type, doc, openid) {
  if (!openid || !doc) return ''
  const driverOpenid = type === 'request' ? getRequestDriverOpenid(doc) : getCarpoolDriverOpenid(doc)
  if (driverOpenid && driverOpenid === openid) return 'driver'
  const passengerOpenids = type === 'request' ? getRequestPassengerOpenids(doc) : getCarpoolPassengerOpenids(doc)
  return passengerOpenids.includes(openid) || getRequestCreatorOpenid(doc) === openid ? 'passenger' : ''
}

async function updateRatingSummary(targetOpenid, targetRole, scoreDelta, countDelta) {
  const role = targetRole === 'driver' ? 'driver' : 'passenger'
  const fields = ROLE_RATING_FIELDS[role]
  const user = await getUser(targetOpenid)
  const stats = (user && user.rideStats) || {}
  const nextSum = Math.max(0, Number(stats[fields.sum] || 0) + scoreDelta)
  const nextCount = Math.max(0, Number(stats[fields.count] || 0) + countDelta)
  const nextAvg = nextCount > 0 ? Number((nextSum / nextCount).toFixed(1)) : 0
  const nextWeightedAvg = computeWeightedRating(nextSum, nextCount)

  const totalRatingSum = Math.max(0, Number(stats.ratingSum || 0) + scoreDelta)
  const totalRatingCount = Math.max(0, Number(stats.ratingCount || 0) + countDelta)
  const totalRatingAvg = totalRatingCount > 0 ? Number((totalRatingSum / totalRatingCount).toFixed(1)) : 0
  const totalWeightedAvg = computeWeightedRating(totalRatingSum, totalRatingCount)

  await updateUserByOpenid(targetOpenid, {
    [`rideStats.${fields.sum}`]: nextSum,
    [`rideStats.${fields.count}`]: nextCount,
    [`rideStats.${fields.avg}`]: nextAvg,
    [`rideStats.${fields.weightedAvg}`]: nextWeightedAvg,
    'rideStats.ratingSum': totalRatingSum,
    'rideStats.ratingCount': totalRatingCount,
    'rideStats.ratingAvg': totalRatingAvg,
    'rideStats.ratingWeightedAvg': totalWeightedAvg,
    'rideStats.lastRatedAt': db.serverDate(),
    updateTime: db.serverDate(),
    updatedAt: db.serverDate()
  }, {
    rideStats: {
      completedTrips: 0,
      completedDriverTrips: 0,
      completedPassengerTrips: 0,
      [fields.sum]: nextSum,
      [fields.count]: nextCount,
      [fields.avg]: nextAvg,
      [fields.weightedAvg]: nextWeightedAvg,
      ratingSum: totalRatingSum,
      ratingCount: totalRatingCount,
      ratingAvg: totalRatingAvg,
      ratingWeightedAvg: totalWeightedAvg,
      lastRatedAt: new Date()
    }
  })
}

async function rateUser(event, actorOpenid) {
  const targetOpenid = cleanText(event.targetOpenid, 80)
  const tripId = cleanText(event.tripId || event.requestId || event.id, 80)
  const type = normalizeType(event.type)
  const score = Math.floor(Number(event.score || event.rating))
  const comment = ''

  if (!targetOpenid) return { ok: false, success: false, errorMsg: '缺少评分对象' }
  if (targetOpenid === actorOpenid) return { ok: false, success: false, errorMsg: '不能给自己评分' }
  if (!tripId) return { ok: false, success: false, errorMsg: '缺少路线ID' }
  if (!Number.isFinite(score) || score < 1 || score > 5) return { ok: false, success: false, errorMsg: '评分必须是 1 到 5 分' }

  const trip = await getTripForParticipantCheck(type, tripId)
  if (!trip) return { ok: false, success: false, errorMsg: '未找到该路线' }
  if (normalizeTripStatus(trip.doc.status) !== 'past') {
    return { ok: false, success: false, errorMsg: '只能评价过往行程' }
  }
  if (!trip.participants.includes(actorOpenid) || !trip.participants.includes(targetOpenid)) {
    return { ok: false, success: false, errorMsg: '只能评价同一行程中的成员' }
  }
  const actorRole = getParticipantRole(type, trip.doc, actorOpenid)
  const targetRole = getParticipantRole(type, trip.doc, targetOpenid)
  const rolePairAllowed =
    (actorRole === 'driver' && targetRole === 'passenger') ||
    (actorRole === 'passenger' && targetRole === 'driver')
  if (!rolePairAllowed) {
    return { ok: false, success: false, errorMsg: '只能在司机和乘客之间互评' }
  }

  const existing = await db.collection('TripRatings')
    .where({ tripId, type, raterOpenid: actorOpenid, targetOpenid })
    .limit(1)
    .get()
  const oldRating = existing.data && existing.data[0] ? existing.data[0] : null

  if (oldRating) {
    return { ok: false, success: false, alreadyRated: true, errorMsg: '已经评价过' }
  }

  await db.collection('TripRatings').add({
    data: {
      _openid: actorOpenid,
      tripId,
      type,
      collection: trip.collection,
      raterOpenid: actorOpenid,
      targetOpenid,
      raterRole: actorRole,
      targetRole,
      score,
      comment,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
  await updateRatingSummary(targetOpenid, targetRole, score, 1)

  await sendNotification(
    targetOpenid,
    'TRIP_RATING',
    '你收到一条行程评价',
    comment ? `你收到 ${score} 分评价：${comment}` : `你收到 ${score} 分评价`,
    tripId,
    { action: 'rateUser', type, score, raterOpenid: actorOpenid, raterRole: actorRole, targetRole }
  )
  await logAction({ action: 'rateUser', type, tripId, actorOpenid, targetOpenid, score, raterRole: actorRole, targetRole })
  return { ok: true, success: true, action: 'rateUser' }
}

async function routeAction(event, actorOpenid) {
  const action = String(event.action || '').trim()
  const type = normalizeType(event.type)

  if (action === 'blockUser') return blockUser(event, actorOpenid)
  if (action === 'getBlockList') return getBlockList(event, actorOpenid)
  if (action === 'unblockUser') return unblockUser(event, actorOpenid)
  if (action === 'rateUser') return rateUser(event, actorOpenid)

  if (type === 'request') {
    if (action === 'acceptRequest') return acceptRequest(event, actorOpenid)
    if (action === 'kickDriver') return kickDriverFromRequest(event, actorOpenid)
    if (action === 'kickPassenger') return kickPassengerFromRequest(event, actorOpenid)
    if (action === 'deleteTrip') return deleteRequest(event, actorOpenid)
    if (action === 'quitDriver') return quitRequestDriver(event, actorOpenid)
    if (action === 'quitTrip') return quitRequestPassenger(event, actorOpenid)
  }

  if (action === 'kickPassenger') return kickPassengerFromCarpool(event, actorOpenid)
  if (action === 'deleteTrip') return deleteCarpool(event, actorOpenid)
  if (action === 'quitTrip') return quitCarpoolPassenger(event, actorOpenid)

  return { ok: false, success: false, errorMsg: '不支持的操作' }
}

exports.main = async (event = {}) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, success: false, errorMsg: '未获取到 openid' }

  try {
    return await routeAction(event, openid)
  } catch (e) {
    console.error('tripManage error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '操作失败'
    }
  }
}
