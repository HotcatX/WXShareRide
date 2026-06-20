const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})
const db = cloud.database()

function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('not exist') || msg.includes('not found')
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const id = String((event && (event.id || event.requestId || event.tripId)) || '').trim()
  if (!id) {
    return { success: false, notFound: true, errorMsg: '缺少路线ID' }
  }

  try {
    const res = await db.collection('CarpoolRequest').doc(id).get()
    if (!res.data) {
      return { success: false, notFound: true, errorMsg: '该求车路线不存在或已被删除' }
    }
    return {
      success: true,
      data: res.data || null,
      openid: wxContext.OPENID
    }
  } catch (e) {
    console.error('getCarpoolRequestDetail error:', e)
    if (isNotFoundError(e)) {
      return { success: false, notFound: true, errorMsg: '该求车路线不存在或已被删除' }
    }
    return { success: false, errorMsg: '读取 CarpoolRequest 失败' }
  }
}
