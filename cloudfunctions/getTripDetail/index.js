const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const TYPE_CONFIG = {
  carpool: {
    collection: 'Carpool',
    notFoundText: '该路线不存在或已被删除'
  },
  request: {
    collection: 'CarpoolRequest',
    notFoundText: '该求车路线不存在或已被删除'
  }
}

const PUBLIC_DRIVER_FIELDS = {
  _id: true,
  _openid: true,
  openid: true,
  name: true,
  nickName: true,
  nickname: true,
  avatarUrl: true,
  wechatID: true,
  phone: true,
  carNumber: true,
  carBrand: true,
  carModel: true,
  carPlate: true,
  plateNumber: true,
  zelleName: true,
  zelleAccount: true,
  rideStats: true
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'request' || type === 'carpoolrequest') return 'request'
  return 'carpool'
}

function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('not exist') || msg.includes('not found')
}

function cleanText(value, max = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max)
}

function addId(set, value) {
  const id = cleanText(value, 80)
  if (id) set.add(id)
}

function getBlockedUsers(user = {}) {
  const out = new Set()
  ;(Array.isArray(user && user.blockedUsers) ? user.blockedUsers : []).forEach(id => addId(out, id))
  ;(Array.isArray(user && user.blockedUserDetails) ? user.blockedUserDetails : []).forEach(item => addId(out, item && item.openid))
  return out
}

async function getUser(openid) {
  if (!openid) return null
  const res = await db.collection('userInfo').where({ _openid: openid }).limit(1).get()
  return res.data && res.data[0] ? res.data[0] : null
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
  const [a, b] = await Promise.all([getUser(openidA), getUser(openidB)])
  const aBlocks = getBlockedUsers(a)
  const bBlocks = getBlockedUsers(b)
  if (aBlocks.has(openidB)) return { blocked: true, blocker: openidA, target: openidB }
  if (bBlocks.has(openidA)) return { blocked: true, blocker: openidB, target: openidA }
  const [aActiveBlock, bActiveBlock] = await Promise.all([
    hasActiveBlock(openidA, openidB),
    hasActiveBlock(openidB, openidA)
  ])
  if (aActiveBlock) return { blocked: true, blocker: openidA, target: openidB }
  if (bActiveBlock) return { blocked: true, blocker: openidB, target: openidA }
  return { blocked: false }
}

function getCarpoolPassengerOpenids(doc = {}) {
  const ids = new Set()
  ;(Array.isArray(doc.passengers) ? doc.passengers : []).forEach(item => {
    if (typeof item === 'string') addId(ids, item)
    else {
      addId(ids, item && item._openid)
      addId(ids, item && item.openid)
      addId(ids, item && item.passengerOpenid)
    }
  })
  ;(Array.isArray(doc.passengerID) ? doc.passengerID : []).forEach(id => addId(ids, id))
  ;(Array.isArray(doc.passengerIDs) ? doc.passengerIDs : []).forEach(id => addId(ids, id))
  return Array.from(ids)
}

function getRequestPassengerOpenids(doc = {}) {
  const ids = new Set()
  ;(Array.isArray(doc.passengerID) ? doc.passengerID : []).forEach(id => addId(ids, id))
  ;(Array.isArray(doc.passengerIDs) ? doc.passengerIDs : []).forEach(id => addId(ids, id))
  ;(Array.isArray(doc.passengers) ? doc.passengers : []).forEach(item => {
    if (typeof item === 'string') addId(ids, item)
    else {
      addId(ids, item && item._openid)
      addId(ids, item && item.openid)
      addId(ids, item && item.passengerOpenid)
    }
  })
  return Array.from(ids)
}

function getCarpoolDriverOpenid(doc = {}) {
  return cleanText(doc._openid || doc.driverOpenid || doc.driverID || doc.driverId, 80)
}

function getRequestCreatorOpenid(doc = {}) {
  return cleanText(doc._openid || doc.creatorOpenid || doc.passengerOpenid || doc.openid, 80)
}

function getRequestDriverOpenid(doc = {}) {
  return cleanText(doc.driverOpenid || doc.driverID || doc.driverId || doc.driver, 80)
}

function getTripParticipantOpenids(type, doc) {
  const ids = new Set()
  if (type === 'request') {
    addId(ids, getRequestCreatorOpenid(doc))
    addId(ids, getRequestDriverOpenid(doc))
    getRequestPassengerOpenids(doc).forEach(id => addId(ids, id))
  } else {
    addId(ids, getCarpoolDriverOpenid(doc))
    getCarpoolPassengerOpenids(doc).forEach(id => addId(ids, id))
  }
  return Array.from(ids)
}

function normalizeDriverInfo(user = {}, driverOpenid = '') {
  if (!user || !user._openid) return null
  return {
    ...user,
    _openid: driverOpenid || user._openid || user.openid || '',
    carNumber: user.carNumber || user.carPlate || user.plateNumber || '',
    carBrand: user.carBrand || '',
    carModel: user.carModel || ''
  }
}

function canExposeDriverInfo(actorOpenid, type, doc = {}) {
  const actor = cleanText(actorOpenid, 80)
  if (!actor) return false
  return getTripParticipantOpenids(type, doc).includes(actor)
}

async function getDriverInfo(type, doc = {}, actorOpenid = '') {
  if (!canExposeDriverInfo(actorOpenid, type, doc)) return null

  const driverOpenid = type === 'request'
    ? getRequestDriverOpenid(doc)
    : getCarpoolDriverOpenid(doc)
  if (!driverOpenid) return null

  const res = await db.collection('userInfo')
    .where({ _openid: driverOpenid })
    .field(PUBLIC_DRIVER_FIELDS)
    .limit(1)
    .get()

  const user = res.data && res.data[0] ? res.data[0] : null
  return normalizeDriverInfo(user, driverOpenid)
}

async function shouldBlockDetail(actorOpenid, type, doc) {
  const actor = cleanText(actorOpenid, 80)
  if (!actor) return false
  const participants = getTripParticipantOpenids(type, doc)
  if (participants.includes(actor)) return false
  for (const target of participants) {
    const result = await checkBlockBetween(actor, target)
    if (result.blocked) return true
  }
  return false
}

async function getRatedTargetOpenids(type, tripId, actorOpenid) {
  const actor = cleanText(actorOpenid, 80)
  const id = cleanText(tripId, 80)
  if (!actor || !id) return []

  const res = await db.collection('TripRatings')
    .where({
      tripId: id,
      type,
      raterOpenid: actor
    })
    .limit(100)
    .get()

  const ids = new Set()
  ;(res.data || []).forEach(item => addId(ids, item && item.targetOpenid))
  return Array.from(ids)
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  const id = String(event.id || event.tripId || event.requestId || '').trim()
  const type = normalizeType(event.type || event.sourceType || event.routeType)
  const config = TYPE_CONFIG[type]

  if (!id) {
    return {
      ok: false,
      success: false,
      notFound: true,
      errorMsg: '缺少路线ID',
      openid: wxContext.OPENID || ''
    }
  }

  try {
    const res = await db.collection(config.collection).doc(id).get()
    if (!res.data) {
      return {
        ok: false,
        success: false,
        notFound: true,
        errorMsg: config.notFoundText,
        openid: wxContext.OPENID || '',
        type
      }
    }

    const blocked = await shouldBlockDetail(wxContext.OPENID || '', type, res.data)
    if (blocked) {
      return {
        ok: false,
        success: false,
        blocked: true,
        errorMsg: '你和该路线成员之间存在拉黑关系，无法查看',
        openid: wxContext.OPENID || '',
        type
      }
    }

    const [ratedTargetOpenids, driverInfo] = await Promise.all([
      getRatedTargetOpenids(type, id, wxContext.OPENID || ''),
      getDriverInfo(type, res.data, wxContext.OPENID || '')
    ])

    return {
      ok: true,
      success: true,
      data: res.data,
      driverInfo,
      openid: wxContext.OPENID || '',
      type,
      from: config.collection,
      ratedTargetOpenids,
      ratingState: {
        ratedTargetOpenids
      }
    }
  } catch (e) {
    console.error('getTripDetail error:', e)
    if (isNotFoundError(e)) {
      return {
        ok: false,
        success: false,
        notFound: true,
        errorMsg: config.notFoundText,
        openid: wxContext.OPENID || '',
        type
      }
    }
    return {
      ok: false,
      success: false,
      errorMsg: '读取路线详情失败',
      openid: wxContext.OPENID || '',
      type
    }
  }
}
