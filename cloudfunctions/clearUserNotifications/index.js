// cloudfunctions/clearUserNotifications/index.js
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV   // 和其他云函数保持一致
})

const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    // 删除当前用户作为接收者 (_openid = OPENID) 的所有通知
    const res = await db.collection('Notifications')
      .where({
        _openid: OPENID
      })
      .remove()

    return {
      success: true,
      removed: res.stats ? res.stats.removed : 0
    }
  } catch (err) {
    console.error('clearUserNotifications error:', err)
    return {
      success: false,
      errorMsg: err.message || err
    }
  }
}