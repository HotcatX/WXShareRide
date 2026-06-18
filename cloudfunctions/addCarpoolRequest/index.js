// cloudfunctions/addCarpoolRequest/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

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
    // 1) 写入 CarpoolRequest
    const addRes = await transaction.collection('CarpoolRequest').add({
      data: {
        _openid: openid,          // 创建者 openid（索引/权限）
        passengerID: [openid],   // 初始乘客数组：创建者
        departures: departures || [],
        destinations: destinations || [],
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
      // 兜底：理论上你前端已要求完善信息，但这里仍建议兜底
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

          // 兜底：确保字段存在且为数组（不覆盖原数组内容）
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

