// 云函数：joinCarpoolRequest（事务型 + 通知司机/创建者）
// 作用：乘客加入 CarpoolRequest：
// 1) CarpoolRequest.passengerID 追加当前乘客 openid（数组去重）
// 2) 同时把 requestId 去重写入乘客 userInfo.tripPassenger（不存在则创建）
// 3) 加入成功后：通知司机（CarpoolRequest.driverID/driverOpenid）和创建者（CarpoolRequest._openid）
//    不通知所有乘客

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const MAX_PASSENGERS = 4

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
  const passengerOpenid = wxContext.OPENID

  const requestId = event.requestId || event.id || ''
  if (!passengerOpenid) return { success: false, errorMsg: '未获取到乘客 openid' }
  if (!requestId) return { success: false, errorMsg: '缺少 requestId' }

  // 事务外用于发通知的信息
  let notifyTargets = []
  let reqForMsg = null
  let alreadyJoinedForMsg = false

  try {
    const result = await db.runTransaction(async (transaction) => {
      // ---------- A) 读取 CarpoolRequest ----------
      const reqDoc = await transaction.collection('CarpoolRequest').doc(requestId).get()
      const req = reqDoc && reqDoc.data
      if (!req) return { success: false, errorMsg: '未找到该路线' }

      // 状态校验：只允许 open 加入
      const status = req.status || 'open'
      if (status !== 'open') {
        return { success: false, errorMsg: '该路线不可加入（已关闭或已结束）' }
      }

      // passengerID 数组
      const arr = Array.isArray(req.passengerID) ? req.passengerID.filter(Boolean) : []
      const alreadyJoined = arr.includes(passengerOpenid)

      // 人数/满员判断
      const passengerCountRaw = req.passengerCount
      const baseCount = Number.isFinite(passengerCountRaw) ? passengerCountRaw : arr.length
      const nextCount = alreadyJoined ? baseCount : (baseCount + 1)

      if (!alreadyJoined && nextCount > MAX_PASSENGERS) {
        return { success: false, errorMsg: '该路线已满员' }
      }

      // ---------- B) 更新 CarpoolRequest.passengerID / passengerCount ----------
      if (!alreadyJoined) {
        await transaction.collection('CarpoolRequest').doc(requestId).update({
          data: {
            passengerID: _.addToSet(passengerOpenid),
            passengerCount: nextCount,
            updatedAt: new Date()
          }
        })
      }

      // ---------- C) 更新/创建乘客 userInfo.tripPassenger ----------
      const userInfoRes = await transaction.collection('userInfo')
        .where({ _openid: passengerOpenid })
        .limit(1)
        .get()

      const userInfoList = (userInfoRes && userInfoRes.data) || []

      if (userInfoList.length === 0) {
        await transaction.collection('userInfo').add({
          data: {
            role: 'passenger',
            tripPassenger: [requestId],
            tripDriver: [],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        })
      } else {
        const userInfoDocId = userInfoList[0]._id
        await transaction.collection('userInfo').doc(userInfoDocId).update({
          data: {
            role: 'passenger',
            tripPassenger: _.addToSet(requestId),
            updatedAt: new Date()
          }
        })
      }

      // ---------- D) 事务内仅“准备”通知目标（事务外再写 Notifications） ----------
      const ownerOpenid = req._openid || ''                 // 创建者
      const driverOpenid = req.driverOpenid || req.driverID || ''  // 司机（兼容字段）

      // 去重 + 过滤自己
      const targets = [ownerOpenid, driverOpenid]
        .filter(Boolean)
        .filter(x => x !== passengerOpenid)
      notifyTargets = [...new Set(targets)]

      // 事务外拼文案用
      reqForMsg = req
      alreadyJoinedForMsg = alreadyJoined

      return { success: true, alreadyJoined }
    })

    // 事务判定失败则直接返回
    if (!result || !result.success) return result

    // 如果本来就已经加入过（重复点击），一般不再重复发通知（可按你偏好修改）
    if (alreadyJoinedForMsg) return result

    // ===== 事务成功后：只通知司机 + 创建者 =====
    try {
      // 防御：极端情况下 reqForMsg 没拿到，再读一次
      if (!reqForMsg) {
        const r2 = await db.collection('CarpoolRequest').doc(requestId).get()
        reqForMsg = r2 && r2.data ? r2.data : null
      }

      const dep = (reqForMsg && reqForMsg.departures || [])[0] || {}
      const des = (reqForMsg && reqForMsg.destinations || [])[0] || {}
      const dateStr = dep.date || ''
      const timeStr = dep.time || ''
      const routeStr = (dep.address && des.address)
        ? `${dep.address} -> ${des.address}`
        : '该求车路线'

      const title = '有乘客加入求车路线'
      const content = `有新乘客加入：${dateStr} ${timeStr} ${routeStr}。`

      if (Array.isArray(notifyTargets) && notifyTargets.length > 0) {
        await Promise.all(
          notifyTargets.map(toOpenid =>
            sendNotification(
              toOpenid,
              'PASSENGER_JOIN_REQUEST',
              title,
              content,
              requestId,
              {
                requestId,
                passengerOpenid,
                action: 'passenger_join'
              }
            )
          )
        )
      }
    } catch (notifyErr) {
      console.warn('【joinCarpoolRequest】通知发送失败（不影响加入）:', notifyErr)
    }

    return result
  } catch (e) {
    console.error('joinCarpoolRequest transaction error:', e)
    const msg = String(e && (e.message || e.errMsg || e) || '')
    return { success: false, errorMsg: msg ? `加入失败：${msg}` : '系统错误，加入失败' }
  }
}


