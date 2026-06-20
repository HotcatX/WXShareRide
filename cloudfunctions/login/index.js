// cloudfunctions/login/index.js
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const userColl = db.collection('userInfo')

function buildReferralCode(openid) {
  const hash = crypto.createHash('sha1').update(String(openid)).digest('hex').slice(0, 12)
  return `ref_${hash}`
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  if (!openid) {
    return { ok: false, errorMsg: '未获取到 openid' }
  }

  try {
    const queryRes = await userColl.where({ _openid: openid }).limit(1).get()

    let isNewUser = false
    let profileCompleted = false
    let referralCode = buildReferralCode(openid)

    if (!queryRes.data.length) {
      isNewUser = true
      profileCompleted = false

      await userColl.add({
        data: {
          _openid: openid,
          name: '',
          avatarUrl: '',
          phone: '',          // ✅ 保留字段但不自动写入
          wechatID: '',
          zelleName: '',
          zelleAccount: '',
          region: '',
          status: 'normal',
          profileCompleted,
          tripDriver: [],
          tripPassenger: [],
          tripDriverHistory: [],
          tripPassengerHistory: [],
          createdTime: new Date(),
          updateTime: new Date(),
          carBrand: '',
          carModel: '',
          carNumber: '',
          address: '',
          referralCode
        }
      })
    } else {
      const doc = queryRes.data[0]
      profileCompleted = !!doc.profileCompleted
      referralCode = doc.referralCode || referralCode

      const updateData = {
        updateTime: new Date()
      }
      if (!doc.status) {
        updateData.status = 'normal'
      }
      if (!doc.referralCode) {
        updateData.referralCode = referralCode
      }

      if (Object.keys(updateData).length > 1) {
        await userColl.doc(doc._id).update({ data: updateData })
      }
    }

    return {
      ok: true,
      openid,
      isNewUser,
      profileCompleted,
      referralCode
    }
  } catch (e) {
    console.error('【login】异常：', e)
    return { ok: false, errorMsg: e.message || '登录失败' }
  }
}
