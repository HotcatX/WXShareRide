// 云函数：getMyRequestList（读取 CarpoolRequest 作为回退）
// 目标：返回结构与 getMyTripList 一致，供 home 行程卡片复用
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function getWeekdayCN(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const day = dt.getDay()
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[day] || ''
}

function formatDateCNNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!m || !d) return ''
  return `${m}月${d}日`
}

exports.main = async (event, context) => {
  const { OPENID: openid } = cloud.getWXContext()
  console.log('【getMyRequestList】openid =', openid)

  if (!openid) return { ok: false, errorMsg: '未获取到 openid' }

  try {
    // ✅ 归属字段如果不是 _openid，请在这里替换：
    // 例如：where({ passengerOpenid: openid })
    let reqRes = null
    try {
      reqRes = await db.collection('CarpoolRequest')
        .where({ _openid: openid })
        .orderBy('createTime', 'desc')
        .get()
    } catch (e) {
      console.error('【getMyRequestList】orderBy 查询失败，降级为不排序 get():', e)
      reqRes = await db.collection('CarpoolRequest')
        .where({ _openid: openid })
        .get()
    }    

    const reqList = reqRes.data || []
    console.log('【CarpoolRequest】数量 =', reqList.length)

    const result = reqList.map(req => {
      // --------- 下面这些字段名按“常见写法”做兼容兜底 ----------
      const dep0 =
        Array.isArray(req.departures) && req.departures.length ? req.departures[0] : (req.departure || {})
      const dest0 =
        Array.isArray(req.destinations) && req.destinations.length ? req.destinations[0] : (req.destination || {})

      const fromAddress = req.fromAddress || req._fromAddress || dep0.address || dep0.name || req.departureAddress || ''
      const toAddress = req.toAddress || req._toAddress || dest0.address || dest0.name || req.destinationAddress || ''

      const date = req.date || dep0.date || req.departDate || req.departureDate || ''
      const time = req.time || dep0.time || req.departTime || req.departureTime || ''

      const dateCN = formatDateCNNoYear(date)
      const weekday = getWeekdayCN(date)
      const timeLabel =
        (dateCN && weekday && time) ? `${dateCN} ${weekday} ${time}`
        : (dateCN && weekday) ? `${dateCN} ${weekday}`
        : (dateCN || time || '')

      // 用于 home 卡片复用：home.js 会优先读 raw.statusText || raw.status
      const statusText = req.statusText || req.status || 'request'

      return {
        _id: req._id,
        role: 'passenger',      // ✅ 关键：保证 home.js 会展示进 passengerTrips
        from: 'CarpoolRequest', // 标识来源，便于你后续调试
        tripData: {
          ...req,
          // ✅ 给 home.js 的“兼容字段”
          _fromAddress: fromAddress,
          _toAddress: toAddress,
          _timeLabel: timeLabel,
          statusText,
          _isRequest: true       // 方便你在详情页/卡片上做“求车”标识（可选）
        }
      }
    })

    return { ok: true, data: result }
  } catch (e) {
    console.error('【getMyRequestList】异常：', e)
    return { ok: false, errorMsg: e.message || '获取求车列表失败', error: e }
  }
  
}