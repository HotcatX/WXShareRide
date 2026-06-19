// 云函数：editMyRequestDetailDriver
// 作用：司机退出 CarpoolRequest（无事务版，兼容不支持 t.get 的环境）
//
// 1) 读取 CarpoolRequest 并校验当前 openid 是司机
//    并在未 past 时 status -> open
// 3) userInfo：从司机 tripDriverJoin 数组中移除该 requestId（尽力清理，不阻断主流程）

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value === 'close' || value === 'closed' ? 'past' : value
}

async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) return
  try {
    await db.collection('Notifications').add({
      data: {
        _openid: toOpenid,      // 接收方 openid
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
  const action = event.action || 'quit'

  if (!driverOpenid) return { ok: false, errorMsg: '未获取到司机 openid' }
  if (!requestId) return { ok: false, errorMsg: '缺少 requestId' }
  if (action !== 'quit') return { ok: false, errorMsg: '不支持的操作' }

  try {
    // 1) 读取 CarpoolRequest
    const reqRes = await db.collection('CarpoolRequest').doc(requestId).get()
    const req = reqRes && reqRes.data ? reqRes.data : null
    if (!req) return { ok: false, errorMsg: '未找到该路线' }

    // 2) 校验司机身份（兼容 driverOpenid / driverID / driverId）
    const reqDriver = req.driverOpenid || req.driverID || req.driverId || ''
    if (!reqDriver || reqDriver !== driverOpenid) {
      return { ok: false, errorMsg: '你不是该路线司机，无法退出' }
    }

    const next = {}

    if (Object.prototype.hasOwnProperty.call(req, 'driverOpenid')) next.driverOpenid = ''
    if (Object.prototype.hasOwnProperty.call(req, 'driverID')) next.driverID = ''
    if (Object.prototype.hasOwnProperty.call(req, 'driverId')) next.driverId = ''

    // status 回滚：仅当当前不是 past
    const curStatus = normalizeTripStatus(req.status)
    if (curStatus !== 'past') {
      next.status = 'open'
    }

    // 防御：如果确实没有 driver 字段，避免 update 空对象
    if (Object.keys(next).length === 0) {
      return { ok: false, errorMsg: '该路线不包含 driver 字段，无法清除' }
    }

    // 4) 更新 CarpoolRequest（释放司机）
    await db.collection('CarpoolRequest').doc(requestId).update({ data: next })

    // 6) 给所有已加入乘客发送“司机退出”通知
  try {
    const passengerIds = Array.isArray(req.passengerID) ? req.passengerID : []

    // 去重 + 过滤空值
    const uniqPassengers = [...new Set(passengerIds.filter(x => !!x))]

    // 拼接行程信息（从 req.departures / destinations 取）
    const dep = (req.departures || [])[0] || {}
    const des = (req.destinations || [])[0] || {}
    const dateStr = dep.date || ''
    const timeStr = dep.time || ''
    const routeStr = (dep.address && des.address)
      ? `${dep.address} -> ${des.address}`
      : '该行程'

    const title = '司机已退出该求车路线'
    const content = `司机已退出你加入的 ${dateStr} ${timeStr} ${routeStr}，该路线已恢复为可接单状态。`

    // 逐个发送（并发量可控；人数<=4通常没问题）
    await Promise.all(
      uniqPassengers
        .filter(openid => openid !== driverOpenid) // 防御：避免给自己发
        .map(openid => sendNotification(
          openid,
          'DRIVER_QUIT_REQUEST',
          title,
          content,
          requestId,
          {
            requestId,
            driverOpenid,
            action: 'driver_quit',
            // 你也可以附加：dep, des, dateStr, timeStr 等
          }
        ))
    )
  } catch (e3) {
  }


    // 5) 清理 userInfo.tripDriverJoin（尽力而为，不阻断）
    try {
      const uRes = await db.collection('userInfo').where({ _openid: driverOpenid }).limit(1).get()
      const u = uRes && uRes.data && uRes.data[0] ? uRes.data[0] : null
      if (u && u._id) {
        await db.collection('userInfo').doc(u._id).update({
          data: {
            tripDriverJoin: _.pull(requestId)
          }
        })
      }
    } catch (e2) {
    }

    return { ok: true }
  } catch (e) {
    console.error('【editMyRequestDetailDriver】error:', e)
    return {
      ok: false,
      errorMsg: '退出失败（云函数异常）'
    }
  }
}
