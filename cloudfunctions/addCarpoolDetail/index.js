// 云函数：addCarpoolDetail

const REQUIRE_PUDO_GLOBAL = false

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/**
 * 🆕 公共方法：往 Notifications 集合里写一条消息
 * @param {string} toOpenid 接收方 openid
 * @param {string} type     消息类型，如 'PASSENGER_JOIN'
 * @param {string} title    标题
 * @param {string} content  内容
 * @param {string} carpoolId 对应的行程 id
 * @param {object} extra    其他附加字段（可选）
 */

async function sendNotification(toOpenid, type, title, content, carpoolId, extra = {}) {
  if (!toOpenid) {
    console.warn('[sendNotification] 缺少 toOpenid，跳过发送')
    return
  }
  try {
    await db.collection('Notifications').add({
      data: {
        _openid: toOpenid,          // ❗接收方 openid，结合“仅创建者可读写”权限
        type,
        title,
        content,
        carpoolId: carpoolId || '',
        extra,
        read: false,
        createdAt: db.serverDate()
      }
    })
    console.log('[sendNotification] 已发送通知给', toOpenid, type)
  } catch (e) {
    console.error('[sendNotification] 写入通知失败：', e)
  }
}

exports.main = async (event, context) => {
  const { tripId, passengerInfo } = event
  const { OPENID } = cloud.getWXContext()

  try {
    const tripRef = db.collection('Carpool').doc(tripId)
    const tripRes = await tripRef.get()
    const tripData = tripRes.data

    if (!tripData) {
      return { success: false, msg: '路线不存在' }
    }

    // ✅ 开关：是否要求乘客填写上下车点（每条行程可控）
    const requirePickupDropoff = REQUIRE_PUDO_GLOBAL && (tripData.requirePickupDropoff !== false)

    // 取值（无论是否必填都先取出来，后面写 passenger 记录用）
    const pickupAddress = String(passengerInfo?.pickupAddress ?? event.pickupAddress ?? '').trim()
    const dropoffAddress = String(passengerInfo?.dropoffAddress ?? event.dropoffAddress ?? '').trim()

    // 只有开关开启时才校验必填
    if (requirePickupDropoff) {
      if (!pickupAddress || !dropoffAddress) {
        return { success: false, msg: '请先填写上车点和下车点' }
      }
    }


    // ✅ 检查路线状态
    if (tripData.status === 'close' || (tripData.availSeatNum ?? 0) <= 0) {
      return { success: false, msg: '该路线已满员' }
    }

    // ✅ 检查是否已加入
    const passengers = (tripData.passengers || []).filter(p => !!p)
    const alreadyJoined = passengers.some(p => p._openid === OPENID)
    if (alreadyJoined) {
      return { success: false, msg: '您已加入该路线' }
    }

    // ✅ 修正乘客信息（确保含 openid）
    const fixedPassengerInfo = {
      // 你原来 passengerInfo 里用于展示的字段（按你实际有的来）
      name: passengerInfo?.name,
      nickName: passengerInfo?.nickName,
      nickname: passengerInfo?.nickname,
      avatarUrl: passengerInfo?.avatarUrl,
    
      _openid: passengerInfo?._openid || OPENID,
      joinedAt: new Date(),
    
      // ✅ 新增：乘客自己的上下车点
      pickupAddress,
      dropoffAddress
    }

    // ✅ 计算剩余座位
    const newAvail = (tripData.availSeatNum ?? tripData.passengerCount) - 1

    // ✅ 原子更新
    await tripRef.update({
      data: {
        availSeatNum: _.inc(-1),
        passengers: _.push(fixedPassengerInfo),
        status: newAvail <= 0 ? 'full' : 'open',
        updatedAt: new Date()
      }
    })

    // 🆕 成功拼车后：给司机发送一条通知
    // 假设 Carpool 创建者就是司机：tripData._openid
    const driverOpenid = tripData._openid

    // 拼接行程信息
    const dep = (tripData.departures || [])[0] || {}
    const des = (tripData.destinations || [])[0] || {}
    const dateStr = dep.date || ''
    const timeStr = dep.time || ''
    const routeStr = (dep.address && des.address)
      ? `${dep.address} -> ${des.address}`
      : '本次行程'

    const passengerName =
      passengerInfo?.name ||
      passengerInfo?.nickName ||
      passengerInfo?.nickname ||
      '一位乘客'

    const title = '有乘客加入你的行程'
    const content = `${passengerName} 加入了 ${dateStr} ${timeStr} ${routeStr} 的行程`

    await sendNotification(driverOpenid, 'PASSENGER_JOIN', title, content, tripId, {
      role: 'driver',
      passengerOpenid: OPENID
    })

    return { success: true, msg: '添加路线成功', newAvail }

  } catch (err) {
    console.error('[addCarpoolDetail 错误]', err)
    return { success: false, msg: '添加路线失败', error: String(err) }
  }
}
