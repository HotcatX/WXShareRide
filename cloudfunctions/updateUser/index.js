// cloudfunctions/updateUserInfo/index.js
const cloud = require('wx-server-sdk')

// 统一使用当前环境
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const coll = db.collection('userInfo')

function normalizeLocationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeLocationForSave(location) {
  if (!location || typeof location !== 'object') return null

  const lat = toFiniteNumber(location.lat ?? location.latitude)
  const lng = toFiniteNumber(location.lng ?? location.longitude)
  const displayName = normalizeLocationText(
    location.displayName ||
    location.name ||
    location.address
  )
  const address = normalizeLocationText(location.address)

  if (!displayName && !address && (lat === null || lng === null)) return null

  return {
    displayName: displayName || address,
    name: normalizeLocationText(location.name || displayName || address),
    address,
    lat,
    lng,
    source: normalizeLocationText(location.source || 'chooseLocation'),
    updatedAtMs: Date.now()
  }
}

exports.main = async (event, context) => {
  const { OPENID: openid } = cloud.getWXContext()

  if (!openid) {
    return { ok: false, errorMsg: '未获取到 openid' }
  }

  const { action } = event || {}

  // ============================================================
  // ============================================================
  if (action === 'addCommonComment') {
    return await handleAddCommonComment(openid, event)
  }

  // ============================================================
  // B）默认逻辑：editInfo / 登录时补全资料 / addInfo 完善资料
  // ============================================================
  return await handleNormalUpdate(openid, event)
}

/**
 * B）普通资料更新（addInfo / editInfo / 登录补全）
 */
async function handleNormalUpdate(openid, event) {
  const {
    wechatID,
    phone,
    region,
    name,
    avatarUrl,
    zelleName,
    zelleAccount,

    // 车辆 + 自定义价格（资料页也可能维护这些）
    carNumber,
    carBrand,
    carModel,
    customPrice,     // { fortLeeNonCore, fortLeeCore }

    // 住址
    address,
    location,

    bigregion,
    bio
  } = event || {}
  const normalizedLocation = normalizeLocationForSave(location)

  try {
    const res = await coll.where({ _openid: openid }).limit(1).get()

    // 1）用户不存在 → 新建记录
    if (!res.data.length) {
      const now = new Date()

      await coll.add({
        data: {
          _openid: openid,

          wechatID: wechatID || '',
          phone: phone || '',
          region: region || '',
          name: name || '',
          avatarUrl: avatarUrl || '',
          zelleName: zelleName || '',
          zelleAccount: zelleAccount || '',
          address: address || '',
          location: normalizedLocation || {},

          bigregion: bigregion || '',

          carNumber: carNumber || '',
          carBrand: carBrand || '',
          carModel: carModel || '',

          customPrice: customPrice || {
            fortLeeNonCore: '',
            fortLeeCore: ''
          },

          status: 'normal',
          profileCompleted: true,

          // trip 字段统一补齐
          tripDriver: [],
          tripPassenger: [],
          tripDriverHistory: [],
          tripPassengerHistory: [],

          createdTime: now,
          updateTime: now
        }
      })

      return { ok: true, created: true }
    }

    // 2）用户已存在 → 更新
    const doc = res.data[0]
    const updateData = {
      updateTime: new Date(),
      profileCompleted: true
    }

    if (typeof wechatID === 'string')      updateData.wechatID = wechatID
    if (typeof phone === 'string')         updateData.phone    = phone
    if (typeof region === 'string')        updateData.region   = region
    if (typeof name === 'string')          updateData.name     = name
    if (typeof avatarUrl === 'string')     updateData.avatarUrl = avatarUrl
    if (typeof zelleName === 'string')     updateData.zelleName = zelleName
    if (typeof zelleAccount === 'string')  updateData.zelleAccount = zelleAccount
    if (typeof address === 'string')       updateData.address = address
    if (normalizedLocation)                updateData.location = normalizedLocation
    if (typeof bigregion === 'string')    updateData.bigregion = bigregion

    if (typeof carNumber === 'string') updateData.carNumber = carNumber
    if (typeof carBrand === 'string')  updateData.carBrand  = carBrand
    if (typeof carModel === 'string')  updateData.carModel  = carModel
    if (typeof bio === 'string') updateData.bio = bio

    // 资料页用整对象覆盖 customPrice（与你原逻辑一致）
    if (customPrice && typeof customPrice === 'object') {
      updateData.customPrice = customPrice
    }

    if (!Array.isArray(doc.tripDriver))           updateData.tripDriver = []
    if (!Array.isArray(doc.tripPassenger))        updateData.tripPassenger = []
    if (!Array.isArray(doc.tripDriverHistory))    updateData.tripDriverHistory = []
    if (!Array.isArray(doc.tripPassengerHistory)) updateData.tripPassengerHistory = []

    await coll.doc(doc._id).update({ data: updateData })
    return { ok: true }

  } catch (e) {
    console.error("【updateUserInfo.normal】异常：", e)
    return { ok: false, errorMsg: e.message || '更新失败' }
  }
}

/**
 * event: { action: 'addCommonComment', text: 'xxx', max: 10 }
 */
async function handleAddCommonComment(openid, event) {
  const { text, max } = event || {}
  const MAX = (typeof max === 'number' && max > 0) ? max : 10
  const t = (text || '').trim()

  if (!t) {
    return { ok: false, errorMsg: '缺少 text' }
  }

  try {
    const res = await coll.where({ _openid: openid }).limit(1).get()

    if (!res.data.length) {
      const now = new Date()
      await coll.add({
        data: {
          _openid: openid,
          commonComments: [t],
          status: 'normal',
          profileCompleted: true,

          tripDriver: [],
          tripPassenger: [],
          tripDriverHistory: [],
          tripPassengerHistory: [],

          createdTime: now,
          updateTime: now
        }
      })
      return { ok: true, created: true }
    }

    const doc = res.data[0]
    const oldList = Array.isArray(doc.commonComments) ? doc.commonComments.filter(Boolean) : []

    const filtered = oldList.filter(x => String(x).trim() !== t)
    const nextList = [t, ...filtered].slice(0, MAX)

    await coll.doc(doc._id).update({
      data: {
        commonComments: nextList,
        updateTime: new Date()
      }
    })

    return { ok: true }

  } catch (e) {
    console.error('【updateUserInfo.addCommonComment】异常：', e)
    return { ok: false, errorMsg: e.message || '更新失败' }
  }
}
