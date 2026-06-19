// 云函数：acceptCarpoolRequest（事务 + 通知乘客）
// 在司机接单成功后，给 CarpoolRequest.passengerID 里所有乘客发送通知

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const VERSION = '2025-12-30-acceptCarpoolRequest-v4-notify-passengers'

/**
 * 往 Notifications 集合写一条消息
 * @param {string} toOpenid 接收方 openid
 * @param {string} type     消息类型，如 'DRIVER_ACCEPT_REQUEST'
 * @param {string} title    标题
 * @param {string} content  内容
 * @param {string} carpoolId 对应的 requestId
 */
async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) return
  try {
    await db.collection('Notifications').add({
      data: {
        _openid: toOpenid,
        type,
        title,
        content,
        carpoolId: carpoolId || '',
        extra,
        read: false,
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    console.error('[sendNotification] 写入通知失败：', e)
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const driverOpenid = wxContext.OPENID

  const requestId = event.requestId || event.id || ''
  if (!driverOpenid) return { success: false, errorMsg: '未获取到司机 openid' }
  if (!requestId) return { success: false, errorMsg: '缺少 requestId' }

  // 用于事务后发通知
  let passengersToNotify = []
  let reqSnapshotForMsg = null

  try {
    const res = await db.runTransaction(async (transaction) => {
      // 1) 读取 CarpoolRequest
      const reqDoc = transaction.collection('CarpoolRequest').doc(requestId)
      const snap = await reqDoc.get()
      const req = snap && snap.data
      if (!req) return { success: false, errorMsg: '未找到该求车记录' }

      // 2) 业务校验
      const ownerOpenid = req.openid || req._openid || ''
      if (ownerOpenid && ownerOpenid === driverOpenid) {
        return { success: false, errorMsg: '不能接自己发布的求车' }
      }

      const existingDriver = req.driverOpenid || req.driverID || ''
      if (existingDriver) {
        if (existingDriver === driverOpenid) {
          return { success: true, alreadyAccepted: true }
        }
        return { success: false, errorMsg: '该求车已被其他司机接单' }
      }

      if (req.status && req.status !== 'open') {
        return { success: false, errorMsg: `当前状态不可接单：${req.status}` }
      }

      // 3) 更新 CarpoolRequest：写入司机
      await reqDoc.update({
        data: {
          driverOpenid,
          driverID: driverOpenid, // 兼容旧字段
          updatedAt: new Date()
        }
      })

      // 4) 查询 / 创建 / 更新司机 userInfo
      const userInfoQueryRes = await transaction
        .collection('userInfo')
        .where({ _openid: driverOpenid })
        .limit(1)
        .get()

      const list = (userInfoQueryRes && userInfoQueryRes.data) ? userInfoQueryRes.data : []

      if (list.length === 0) {
        await transaction.collection('userInfo').add({
          data: {
            openid: driverOpenid,
            role: 'driver',
            tripDriverJoin: [requestId],
            tripDriver: [],
            tripPassenger: [],
            tripDriverHistory: [],
            tripPassengerHistory: [],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        })
      } else {
        const userDocId = list[0]._id
        await transaction.collection('userInfo').doc(userDocId).update({
          data: {
            tripDriverJoin: _.addToSet(requestId),
            updatedAt: new Date()
          }
        })
      }

      // 5) 把 passengerID 暂存给事务外发通知使用（不在事务里写 Notifications，避免影响主流程）
      const passengerIds = Array.isArray(req.passengerID) ? req.passengerID : []
      passengersToNotify = passengerIds
      reqSnapshotForMsg = req

      return { success: true }
    })

    // 若事务内已判定失败，直接返回
    if (!res || !res.success) return res
    if (res.alreadyAccepted) return res

    // ===== 事务成功后：给所有已加入乘客发送通知 =====
    try {
      // 防御：如果事务里没拿到 passengerID，则再读一次
      if (!reqSnapshotForMsg) {
        const r2 = await db.collection('CarpoolRequest').doc(requestId).get()
        reqSnapshotForMsg = r2 && r2.data ? r2.data : null
      }
      if (!passengersToNotify || passengersToNotify.length === 0) {
        passengersToNotify = reqSnapshotForMsg && Array.isArray(reqSnapshotForMsg.passengerID)
          ? reqSnapshotForMsg.passengerID
          : []
      }

      const uniqPassengers = [...new Set((passengersToNotify || []).filter(x => !!x))]
        .filter(openid => openid !== driverOpenid) // 一般不需要给司机自己发

      if (uniqPassengers.length > 0 && reqSnapshotForMsg) {
        const dep = (reqSnapshotForMsg.departures || [])[0] || {}
        const des = (reqSnapshotForMsg.destinations || [])[0] || {}
        const dateStr = dep.date || ''
        const timeStr = dep.time || ''
        const routeStr = (dep.address && des.address)
          ? `${dep.address} -> ${des.address}`
          : '该求车路线'

        const title = '已有司机接单'
        const content = `已有司机接单：${dateStr} ${timeStr} ${routeStr}。你可以在“我的求车/路线详情”里查看。`

        await Promise.all(
          uniqPassengers.map(openid =>
            sendNotification(
              openid,
              'DRIVER_ACCEPT_REQUEST',
              title,
              content,
              requestId,
              {
                requestId,
                driverOpenid,
                action: 'driver_accept'
              }
            )
          )
        )
      }
    } catch (notifyErr) {
    }

    return res
  } catch (e) {
    console.error('acceptCarpoolRequest transaction error:', e)
    return {
      success: false,
      errorMsg: '系统错误，接单失败'
    }
  }
}
