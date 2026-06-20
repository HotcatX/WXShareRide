// cloudfunctions/addCarpoolRequest/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
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

function parseTripTimeMs(dateStr, timeStr) {
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
  return Number.isFinite(utcMs) ? utcMs : null
}

function buildDepartureMeta(departures = []) {
  const parsed = (Array.isArray(departures) ? departures : [])
    .map(item => {
      const ms = parseTripTimeMs(item && item.date, item && item.time)
      return ms ? {
        ms,
        date: String(item.date || ''),
        time: String(item.time || '')
      } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.ms - b.ms)

  if (!parsed.length) return {}
  const first = parsed[0]
  const latest = parsed[parsed.length - 1]
  return {
    departureAtMs: first.ms,
    latestDepartureAtMs: latest.ms,
    firstDepartureDate: first.date,
    firstDepartureTime: first.time
  }
}

exports.main = async (event, context) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { success: false, errorMsg: '未获取到 openid' }

  const {
    departures,
    destinations,
    passengerCount,
    status,
    referencePrice,
    comment,
    largeLuggageCount,
  } = event || {}

  const transaction = await db.startTransaction()

  try {
    const departureMeta = buildDepartureMeta(departures)

    // 1) 写入 CarpoolRequest
    const addRes = await transaction.collection('CarpoolRequest').add({
      data: {
        _openid: openid,          // 创建者 openid（索引/权限）
        passengerID: [openid],   // 初始乘客数组：创建者
        departures: departures || [],
        destinations: destinations || [],
        ...departureMeta,
        passengerCount: passengerCount || 1,
        largeLuggageCount: largeLuggageCount || 0,
        status: status || 'open',
        referencePrice: referencePrice || '',
        comment: comment || '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })

    const requestId = addRes._id

    // 2) 同步写入 userInfo.tripPassengerCreate
    const userRes = await transaction
      .collection('userInfo')
      .where({ _openid: openid })
      .limit(1)
      .get()

    if (!userRes.data.length) {
      await transaction.collection('userInfo').add({
        data: {
          _openid: openid,
          role: 'passenger',

          status: 'normal',
          profileCompleted: false,

          tripDriver: [],
          tripPassenger: [],
          tripDriverHistory: [],
          tripPassengerHistory: [],

          // ✅ 新字段：我创建的求车
          tripPassengerCreate: [requestId],

          createdTime: new Date(),
          updateTime: new Date()
        }
      })
    } else {
      const doc = userRes.data[0]
      await transaction.collection('userInfo').doc(doc._id).update({
        data: {
          updateTime: new Date(),
          role: 'passenger',

          // ✅ 新字段：我创建的求车（去重追加）
          tripPassengerCreate: _.addToSet(requestId),

          tripPassenger: Array.isArray(doc.tripPassenger) ? doc.tripPassenger : [],
          tripDriver: Array.isArray(doc.tripDriver) ? doc.tripDriver : [],
          tripDriverHistory: Array.isArray(doc.tripDriverHistory) ? doc.tripDriverHistory : [],
          tripPassengerHistory: Array.isArray(doc.tripPassengerHistory) ? doc.tripPassengerHistory : []
        }
      })
    }

    await transaction.commit()
    return { success: true, id: requestId }

  } catch (e) {
    await transaction.rollback()
    console.error('addCarpoolRequest error:', e)
    return { success: false, errorMsg: e.message || '系统错误' }
  }
}
