const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MAX_OPENIDS = 20
const PUBLIC_USER_FIELDS = {
  _id: true,
  _openid: true,
  openid: true,
  name: true,
  nickName: true,
  nickname: true,
  avatarUrl: true,
  wechatID: true,
  phone: true,
  bigregion: true,
  address: true,
  apartment: true,
  dorm: true,
  addr: true,
  location: true,
  region: true,
  bio: true,
  intro: true,
  signature: true,
  carNumber: true,
  carBrand: true,
  carModel: true,
  carPlate: true,
  plateNumber: true,
  zelleName: true,
  zelleAccount: true,
  rideStats: true
}

function normalizeOpenids(openids) {
  return Array.from(new Set((openids || [])
    .map(id => String(id || '').trim())
    .filter(Boolean)))
    .slice(0, MAX_OPENIDS)
}

exports.main = async (event, context) => {
  const openids = normalizeOpenids((event || {}).openids)

  if (openids.length === 0) {
    return { ok: false, errorMsg: 'openids 为空' }
  }

  try {
    const res = await db.collection('userInfo')
      .where({
        _openid: _.in(openids)
      })
      .field(PUBLIC_USER_FIELDS)
      .get()

    return {
      ok: true,
      data: (res.data || []).map(user => ({
        ...user,
        carNumber: user.carNumber || user.carPlate || user.plateNumber || '',
        carBrand: user.carBrand || '',
        carModel: user.carModel || ''
      }))
    }
  } catch (e) {
    console.error('【getUserInfoByOpenids】查询出错：', e)
    return { ok: false, errorMsg: e.message || '查询失败' }
  }
}
