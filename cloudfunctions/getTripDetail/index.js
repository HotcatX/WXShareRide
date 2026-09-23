const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const BLOCK_QUERY_CHUNK_SIZE = 20

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
  wechatId: true,
  wechat: true,
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

const DRIVER_STATS_FIELDS = {
  'rideStats.completedDriverTrips': true,
  'rideStats.driverRatingCount': true,
  'rideStats.driverRatingWeightedAvg': true,
  'rideStats.driverRatingAvg': true
}

const REQUEST_PASSENGER_FIELDS = {
  _openid: true, name: true, nickName: true, nickname: true, avatarUrl: true,
  wechatID: true, wechatId: true, wechat: true, phone: true, address: true,
  'rideStats.completedPassengerTrips': true,
  'rideStats.passengerRatingCount': true,
  'rideStats.passengerRatingWeightedAvg': true,
  'rideStats.passengerRatingAvg': true
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'request') return 'request'
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

async function getUser(openid) {
  if (!openid) return null
  const res = await db.collection('userInfo').where({ _openid: openid }).limit(1).get()
  return res.data && res.data[0] ? res.data[0] : null
}

function getCarpoolPassengerOpenids(doc = {}) {
  const ids = new Set()
  ;(Array.isArray(doc.passengers) ? doc.passengers : []).forEach(item => {
    addId(ids, item && item._openid)
  })
  return Array.from(ids)
}

function getRequestPassengerOpenids(doc = {}) {
  const ids = new Set()
  ;(Array.isArray(doc.passengerID) ? doc.passengerID : []).forEach(id => addId(ids, id))
  return Array.from(ids)
}

function getCarpoolDriverOpenid(doc = {}) {
  return cleanText(doc._openid, 80)
}

function getRequestCreatorOpenid(doc = {}) {
  return cleanText(doc._openid, 80)
}

function getRequestDriverOpenid(doc = {}) {
  return cleanText(doc.driverOpenid, 80)
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
    name: cleanText(user.name || user.nickName || user.nickname),
    wechatID: cleanText(user.wechatID || user.wechatId || user.wechat),
    carNumber: user.carNumber || user.carPlate || user.plateNumber || '',
    carBrand: user.carBrand || '',
    carModel: user.carModel || ''
  }
}

function sanitizeTripDoc(doc = {}) {
  const item = { ...doc }
  delete item.driverID
  delete item.driverId
  delete item.driverOpenId
  delete item.passengerIDs
  delete item.passengerIds
  delete item.creatorOpenid
  delete item.passengerOpenid
  delete item.openid
  delete item.routeCityKey
  delete item.routeCityLabel
  return item
}

function canExposeDriverInfo(actorOpenid, type, doc = {}) {
  const actor = cleanText(actorOpenid, 80)
  if (!actor) return false
  return getTripParticipantOpenids(type, doc).includes(actor)
}

function normalizeDriverStats(user = {}) {
  const stats = user.rideStats
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null

  const count = value => {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }
  const score = value => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : 0
  }
  // Only these aggregate fields are public; never forward the whole profile or rideStats.
  return {
    completedDriverTrips: count(stats.completedDriverTrips),
    driverRatingCount: count(stats.driverRatingCount) || 0,
    driverRatingWeightedAvg: score(stats.driverRatingWeightedAvg),
    driverRatingAvg: score(stats.driverRatingAvg)
  }
}

async function getDriverData(type, doc = {}, actorOpenid = '') {
  const empty = { driverInfo: null, driverStats: null }
  const canExposeInfo = canExposeDriverInfo(actorOpenid, type, doc)
  if (!canExposeInfo && type !== 'carpool') return empty

  const driverOpenid = type === 'request'
    ? getRequestDriverOpenid(doc)
    : getCarpoolDriverOpenid(doc)
  if (!driverOpenid) return empty

  try {
    const fields = { ...(canExposeInfo ? PUBLIC_DRIVER_FIELDS : DRIVER_STATS_FIELDS) }
    // A profile preference applies to future publications. Existing carpools
    // retain the disclosure choice recorded when that route was published.
    if (type === 'carpool' && doc.zelle !== 'yes') {
      delete fields.zelleName
      delete fields.zelleAccount
    }
    const res = await db.collection('userInfo')
      .where({ _openid: driverOpenid })
      .field(fields)
      .limit(1)
      .get()

    const user = res.data && res.data[0] ? res.data[0] : null
    if (!user) return empty
    return {
      driverInfo: canExposeInfo ? normalizeDriverInfo(user, driverOpenid) : null,
      driverStats: normalizeDriverStats(user)
    }
  } catch (e) {
    console.error('getTripDetail driver profile lookup failed:', e)
    return empty
  }
}

async function getRequestPassengerData(type, doc = {}, actorOpenid = '') {
  if (type !== 'request') return {}
  const empty = { passengerProfiles: [], passengerProfilesError: false }
  const actor = cleanText(actorOpenid, 80)
  const driver = getRequestDriverOpenid(doc)
  // Capacity and assigned driver are independent. A full passenger group still
  // needs to share its contacts with its assigned driver, never with a visitor.
  if (!actor || !driver || actor !== driver) return empty

  const ids = new Set()
  addId(ids, getRequestCreatorOpenid(doc))
  getRequestPassengerOpenids(doc).forEach(id => addId(ids, id))
  ids.delete(driver)
  const passengers = Array.from(ids)
  if (!passengers.length) return empty

  try {
    const users = new Map()
    for (let offset = 0; offset < passengers.length; offset += BLOCK_QUERY_CHUNK_SIZE) {
      const chunk = passengers.slice(offset, offset + BLOCK_QUERY_CHUNK_SIZE)
      const result = await db.collection('userInfo')
        .where({ _openid: db.command.in(chunk) }).field(REQUEST_PASSENGER_FIELDS)
        .limit(chunk.length).get()
      ;(result.data || []).forEach(user => {
        if (user && chunk.includes(user._openid) && !users.has(user._openid)) users.set(user._openid, user)
      })
    }
    const passengerProfiles = passengers.map(openid => {
      const user = users.get(openid) || {}
      return {
        _openid: openid,
        name: cleanText(user.name || user.nickName || user.nickname),
        avatarUrl: cleanText(user.avatarUrl, 2048),
        wechatID: cleanText(user.wechatID || user.wechatId || user.wechat),
        phone: cleanText(user.phone),
        address: cleanText(user.address, 300),
        rideStats: Object.fromEntries(Object.keys(REQUEST_PASSENGER_FIELDS)
          .filter(key => key.startsWith('rideStats.'))
          .map(key => [key.slice('rideStats.'.length), user.rideStats && user.rideStats[key.slice('rideStats.'.length)]])
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))
      }
    })
    return { passengerProfiles, passengerProfilesError: false }
  } catch (e) {
    console.error('getTripDetail request passenger profile lookup failed:', e)
    return { passengerProfiles: [], passengerProfilesError: true }
  }
}

async function shouldBlockDetail(actorOpenid, type, doc) {
  const actor = cleanText(actorOpenid, 80)
  if (!actor) return false
  const participants = getTripParticipantOpenids(type, doc)
  if (participants.includes(actor)) return false
  // Only existence matters. Keep the same two ownership directions while
  // checking every participant, including unusually large legacy routes.
  for (let offset = 0; offset < participants.length; offset += BLOCK_QUERY_CHUNK_SIZE) {
    const targets = participants.slice(offset, offset + BLOCK_QUERY_CHUNK_SIZE)
    const conditions = [
      { _openid: actor, targetOpenid: db.command.in(targets), active: true },
      { _openid: db.command.in(targets), targetOpenid: actor, active: true }
    ]
    const results = await Promise.all(conditions.map(condition => db.collection('UserBlocks')
      .where(condition).field({ _id: true }).limit(1).get()))
    if (results.some(result => result.data && result.data.length)) return true
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
  const type = normalizeType(event.type)
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

    const [ratedTargetOpenids, driverData, passengerData] = await Promise.all([
      getRatedTargetOpenids(type, id, wxContext.OPENID || ''),
      getDriverData(type, res.data, wxContext.OPENID || ''),
      getRequestPassengerData(type, res.data, wxContext.OPENID || '')
    ])

    return {
      ok: true,
      success: true,
      data: sanitizeTripDoc(res.data),
      ...driverData,
      ...passengerData,
      openid: wxContext.OPENID || '',
      type,
      from: type,
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
