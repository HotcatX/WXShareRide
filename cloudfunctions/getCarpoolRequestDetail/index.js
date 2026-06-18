const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const { id } = event || {}
  if (!id) return { success: false, errorMsg: '缺少 id' }

  try {
    const res = await db.collection('CarpoolRequest').doc(id).get()
    return {
      success: true,
      data: res.data || null,
      openid: wxContext.OPENID // ✅ 关键：让前端能判断自己是不是该路线司机
    }
  } catch (e) {
    console.error('getCarpoolRequestDetail error:', e)
    return { success: false, errorMsg: '读取 CarpoolRequest 失败' }
  }
}

