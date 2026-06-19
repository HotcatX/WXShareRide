// 云函数：getPassengerHomeTripList
// 读取乘客 home：
// - createList：userInfo.tripPassengerCreate -> CarpoolRequest
// - joinList  ：userInfo.tripPassenger -> Carpool 或 CarpoolRequest（优先 Carpool，缺失才当作 Request）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const IN_CHUNK_SIZE = 50
const TZ_OFFSET_HOURS = -5

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function getWeekdayCN(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[dt.getDay()] || ''
}

function makeDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const [hh, mm] = String(timeStr).split(':').map(Number)
  if (!y || !m || !d) return null
  const utcMs = Date.UTC(y, m - 1, d, (Number.isFinite(hh) ? hh : 0) - TZ_OFFSET_HOURS, Number.isFinite(mm) ? mm : 0, 0)
  const dt = new Date(utcMs)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function formatDateCNNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!m || !d) return ''
  return `${m}月${d}日`
}

function getFirstDepartureTime(doc = {}) {
  const dep = Array.isArray(doc.departures) && doc.departures.length ? doc.departures[0] : (doc.departure || null)
  if (!dep) return null
  return makeDate(dep.date, dep.time)
}

function getHomeVisibleDoc(doc = {}, requestedStatuses = [], allowCloseCompat = false) {
  const status = String(doc.status || 'open').toLowerCase()
  if (requestedStatuses.includes(status)) return doc
  if (!allowCloseCompat || status !== 'close') return null

  const tripTime = getFirstDepartureTime(doc)
  if (!tripTime || tripTime.getTime() <= Date.now()) return null

  const visibleStatus = Number(doc.availSeatNum || 0) <= 0 ? 'full' : 'open'
  return requestedStatuses.includes(visibleStatus) ? { ...doc, status: visibleStatus } : null
}

function normalizeTripData(raw = {}, source) {
  const dep0 = Array.isArray(raw.departures) && raw.departures.length ? raw.departures[0] : (raw.departure || {})
  const dest0 = Array.isArray(raw.destinations) && raw.destinations.length ? raw.destinations[0] : (raw.destination || {})

  const fromAddress =
    raw.fromAddress || raw._fromAddress || dep0.address || dep0.name || raw.departureAddress || raw.startAddress || ''

  const toAddress =
    raw.toAddress || raw._toAddress || dest0.address || dest0.name || raw.destinationAddress || raw.endAddress || ''

  const date = raw.date || dep0.date || raw.departDate || raw.departureDate || raw.tripDate || raw.requestDate || ''
  const time = raw.time || dep0.time || raw.departTime || raw.departureTime || raw.tripTime || raw.requestTime || ''

  const dateCN = formatDateCNNoYear(date)
  const weekday = getWeekdayCN(date)
  const timeLabel =
    raw._timeLabel ||
    ((dateCN && weekday && time) ? `${dateCN} ${weekday} ${time}`
      : (dateCN && weekday) ? `${dateCN} ${weekday}`
        : (dateCN || time || ''))

  const statusText = raw.statusText || raw.status || (source === 'CarpoolRequest' ? 'request' : '')

  return {
    ...raw,
    _fromAddress: raw._fromAddress || fromAddress,
    _toAddress: raw._toAddress || toAddress,
    _timeLabel: timeLabel,
    statusText,
    _isRequest: source === 'CarpoolRequest'
  }
}

exports.main = async (event, context) => {
  const { OPENID: openid } = cloud.getWXContext()
  console.log('【getPassengerHomeTripList】openid =', openid)
  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }

  const statuses =
    Array.isArray(event?.statuses) && event.statuses.length
      ? event.statuses.map(s => String(s).trim()).filter(Boolean)
      : ['open', 'full', 'past']
  const queryStatuses = Array.from(new Set([...statuses, 'close']))

  try {
    // 1) 读取 userInfo
    const userRes = await db.collection('userInfo')
      .where({ _openid: openid })
      .limit(1)
      .get()

    let tripPassengerCreate = []
    let tripPassenger = []

    if (userRes.data.length) {
      const user = userRes.data[0]
      tripPassengerCreate = Array.isArray(user.tripPassengerCreate) ? user.tripPassengerCreate : []
      tripPassenger = Array.isArray(user.tripPassenger) ? user.tripPassenger : []
    }

    // 2) createList：CarpoolRequest（tripPassengerCreate）
    let createReqDocs = []
    if (tripPassengerCreate.length) {
      for (const ids of chunk([...new Set(tripPassengerCreate)], IN_CHUNK_SIZE)) {
        const res = await db.collection('CarpoolRequest')
          .where({ _id: _.in(ids), status: _.in(statuses) })
          .get()
        createReqDocs = createReqDocs.concat(res.data || [])
      }
    }

    const createReqMap = new Map()
    createReqDocs.forEach(x => x && x._id && createReqMap.set(x._id, x))

    const createList = []
    for (const id of tripPassengerCreate) {
      const doc = createReqMap.get(id)
      if (!doc) continue
      createList.push({
        _id: id,
        role: 'passengerCreate',
        from: 'CarpoolRequest',
        tripData: normalizeTripData(doc, 'CarpoolRequest')
      })
    }

    // 3) joinList：tripPassenger（可能 Carpool / CarpoolRequest）
    const passengerIDUnique = [...new Set(tripPassenger.filter(Boolean))]
    let carpoolExistSet = new Set()

    // 3.1 先判断哪些 id 在 Carpool 中真实存在（不受 status 过滤影响）
    if (passengerIDUnique.length) {
      for (const ids of chunk(passengerIDUnique, IN_CHUNK_SIZE)) {
        const existRes = await db.collection('Carpool')
          .where({ _id: _.in(ids) })
          .field({ _id: true })
          .get()
        ;(existRes.data || []).forEach(x => x && x._id && carpoolExistSet.add(x._id))
      }
    }

    const carpoolIds = passengerIDUnique.filter(id => carpoolExistSet.has(id))
    const requestIds = passengerIDUnique.filter(id => !carpoolExistSet.has(id))

    // 3.2 拉 Carpool 详情（按 statuses 过滤）
    let carpoolDocs = []
    if (carpoolIds.length) {
      for (const ids of chunk(carpoolIds, IN_CHUNK_SIZE)) {
        const res = await db.collection('Carpool')
          .where({ _id: _.in(ids), status: _.in(queryStatuses) })
          .get()
        carpoolDocs = carpoolDocs.concat((res.data || []).map(x => getHomeVisibleDoc(x, statuses, true)).filter(Boolean))
      }
    }

    // 3.3 拉 CarpoolRequest 详情（按 statuses 过滤）
    let requestDocs = []
    if (requestIds.length) {
      for (const ids of chunk(requestIds, IN_CHUNK_SIZE)) {
        const res = await db.collection('CarpoolRequest')
          .where({ _id: _.in(ids), status: _.in(statuses) })
          .get()
        requestDocs = requestDocs.concat(res.data || [])
      }
    }

    const carpoolMap = new Map()
    carpoolDocs.forEach(x => x && x._id && carpoolMap.set(x._id, x))

    const requestMap = new Map()
    requestDocs.forEach(x => x && x._id && requestMap.set(x._id, x))

    // 3.4 按 userInfo 原顺序组装 joinList
    const joinList = []
    for (const id of tripPassenger) {
      if (!id) continue
      if (carpoolExistSet.has(id)) {
        const doc = carpoolMap.get(id)
        if (!doc) continue
        joinList.push({
          _id: id,
          role: 'passenger',
          from: 'Carpool',
          tripData: normalizeTripData(doc, 'Carpool')
        })
      } else {
        const doc = requestMap.get(id)
        if (!doc) continue
        joinList.push({
          _id: id,
          role: 'passenger',
          from: 'CarpoolRequest',
          tripData: normalizeTripData(doc, 'CarpoolRequest')
        })
      }
    }

    return { ok: true, statuses, data: { createList, joinList } }
  } catch (e) {
    console.error('【getPassengerHomeTripList】异常：', e)
    return { ok: false, errorMsg: e.message || '获取乘客 home 行程失败' }
  }
}
