const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const TYPE_CONFIG = {
  carpool: {
    collection: 'Carpool',
    notFoundText: '该路线不存在或已被删除'
  },
  request: {
    collection: 'CarpoolRequest',
    notFoundText: '该求车路线不存在或已被删除'
  }
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'request' || type === 'carpoolrequest') return 'request'
  return 'carpool'
}

function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('not exist') || msg.includes('not found')
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  const id = String(event.id || event.tripId || event.requestId || '').trim()
  const type = normalizeType(event.type || event.sourceType || event.routeType)
  const config = TYPE_CONFIG[type]

  if (!id) {
    return {
      ok: false,
      success: false,
      notFound: true,
      errorMsg: '缺少路线ID',
      openid: wxContext.OPENID || ''
    }
  }

  try {
    const res = await db.collection(config.collection).doc(id).get()
    if (!res.data) {
      return {
        ok: false,
        success: false,
        notFound: true,
        errorMsg: config.notFoundText,
        openid: wxContext.OPENID || '',
        type
      }
    }

    return {
      ok: true,
      success: true,
      data: res.data,
      openid: wxContext.OPENID || '',
      type,
      from: config.collection
    }
  } catch (e) {
    console.error('getTripDetail error:', e)
    if (isNotFoundError(e)) {
      return {
        ok: false,
        success: false,
        notFound: true,
        errorMsg: config.notFoundText,
        openid: wxContext.OPENID || '',
        type
      }
    }
    return {
      ok: false,
      success: false,
      errorMsg: '读取路线详情失败',
      openid: wxContext.OPENID || '',
      type
    }
  }
}
