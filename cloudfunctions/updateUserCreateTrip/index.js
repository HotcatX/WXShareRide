// cloudfunctions/updateUserCreateTrip/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const coll = db.collection('userInfo')

function uniq(arr) {
  const seen = new Set()
  const out = []
  for (const x of arr || []) {
    if (!x) continue
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

exports.main = async (event, context) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }

  const {
    tripId,
    role, // 'driver' | 'passenger'，不传默认 driver
    carNumber,
    carBrand,
    carModel,
    customPrice
  } = event || {}

  if (!tripId) return { ok: false, errorMsg: '缺少 tripId' }

  const tripRole = role === 'passenger' ? 'passenger' : 'driver'

  try {
    const res = await coll.where({ _openid: openid }).limit(1).get()

    // 没有 userInfo：兜底创建
    if (!res.data.length) {
      const now = new Date()

      const baseDoc = {
        _openid: openid,

        role: tripRole === 'driver' ? 'driver' : 'passenger',

        // 车辆信息：只有 driver 才写入
        carNumber: tripRole === 'driver' ? (carNumber || '') : '',
        carBrand:  tripRole === 'driver' ? (carBrand  || '') : '',
        carModel:  tripRole === 'driver' ? (carModel  || '') : '',

        customPrice: {
          fortLeeNonCore: (customPrice && customPrice.fortLeeNonCore) || '',
          fortLeeCore:    (customPrice && customPrice.fortLeeCore)    || ''
        },

        status: 'normal',
        profileCompleted: false, // 如果你不想默认 true，可改成 false

        tripDriver: [],
        tripPassenger: [],
        tripDriverHistory: [],
        tripPassengerHistory: [],

        createdTime: now,
        updateTime: now
      }

      if (tripRole === 'driver') baseDoc.tripDriver = [tripId]
      else baseDoc.tripPassenger = [tripId]

      await coll.add({ data: baseDoc })
      return { ok: true, created: true, role: tripRole }
    }

    const doc = res.data[0]

    // 取旧值（容错：不是数组就当空数组）
    const oldTripDriver = Array.isArray(doc.tripDriver) ? doc.tripDriver : []
    const oldTripPassenger = Array.isArray(doc.tripPassenger) ? doc.tripPassenger : []
    const oldTripDriverHistory = Array.isArray(doc.tripDriverHistory) ? doc.tripDriverHistory : []
    const oldTripPassengerHistory = Array.isArray(doc.tripPassengerHistory) ? doc.tripPassengerHistory : []

    const updateData = {
      updateTime: new Date(),

      // 老字段兜底：保持字段存在且为数组（但不清空已有数据）
      tripDriver: oldTripDriver,
      tripPassenger: oldTripPassenger,
      tripDriverHistory: oldTripDriverHistory,
      tripPassengerHistory: oldTripPassengerHistory
    }

    // 只有 driver 才更新车辆与价格，避免 passenger 覆盖司机信息
    if (tripRole === 'driver') {
      updateData.role = 'driver'
      if (typeof carNumber === 'string') updateData.carNumber = carNumber
      if (typeof carBrand === 'string')  updateData.carBrand = carBrand
      if (typeof carModel === 'string')  updateData.carModel = carModel

      if (customPrice && typeof customPrice === 'object') {
        if (customPrice.fortLeeCore !== undefined) {
          updateData['customPrice.fortLeeCore'] = customPrice.fortLeeCore
        }
        if (customPrice.fortLeeNonCore !== undefined) {
          updateData['customPrice.fortLeeNonCore'] = customPrice.fortLeeNonCore
        }
      }

      // 去重追加
      updateData.tripDriver = uniq([tripId, ...oldTripDriver])
    } else {
      // 去重追加
      updateData.tripPassenger = uniq([tripId, ...oldTripPassenger])
    }

    await coll.doc(doc._id).update({ data: updateData })
    return { ok: true, role: tripRole }

  } catch (e) {
    console.error('【updateUserCreateTrip】异常：', e)
    return { ok: false, errorMsg: e.message || '更新失败' }
  }
}

