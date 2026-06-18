// cloudfunctions/login/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const userColl = db.collection('userInfo')

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  console.log('【login】openid =', openid)
  console.log('【login】event =', event)

  if (!openid) {
    return { ok: false, errorMsg: '未获取到 openid' }
  }

  try {
    // 1️⃣ 查询是否已有记录
    const queryRes = await userColl.where({ _openid: openid }).limit(1).get()

    let isNewUser = false
    let profileCompleted = false

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
          address: ''
        }
      })
    } else {
      // 老用户：只做必要的兜底更新
      const doc = queryRes.data[0]
      profileCompleted = !!doc.profileCompleted

      const updateData = {
        updateTime: new Date()
      }
      if (!doc.status) {
        updateData.status = 'normal'
      }

      if (Object.keys(updateData).length > 1) {
        await userColl.doc(doc._id).update({ data: updateData })
      }
    }

    return {
      ok: true,
      openid,
      isNewUser,
      profileCompleted
    }
  } catch (e) {
    console.error('【login】异常：', e)
    return { ok: false, errorMsg: e.message || '登录失败' }
  }
}
