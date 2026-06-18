// 云函数 addCarpoolList 
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const {
    driverID,
    departures,
    destinations,
    passengerCount,
    availSeatNum,
    status,
    passengers,
    referencePrice,   // ✅ 新增
    comment,          // ✅ 新增
    zelle             // ✅ 新增 (yes/no)
  } = event

  const { OPENID } = cloud.getWXContext()

  console.log("【addCarpoolList 接收到的参数】", event) // 调试用

  try {
    const result = await db.collection('Carpool').add({
      data: {
        driverID,
        departures,
        destinations,
        passengerCount,
        availSeatNum: availSeatNum || passengerCount,
        status: status || 'open',
        passengers: passengers || [],

        // ========================
        // ★★★ 新增三个字段 ★★★
        // ========================
        referencePrice: referencePrice || "",   // 价格
        comment: comment || "",                 // 备注
        zelle: zelle || "no",                   // yes/no
        // ========================

        createdAt: db.serverDate(),
        _openid: OPENID
      }
    })

    return {
      success: true,
      message: '路线创建成功',
      id: result._id
    }
  } catch (err) {
    console.error('添加失败:', err)
    return {
      success: false,
      error: err.message || '数据库写入失败'
    }
  }
}