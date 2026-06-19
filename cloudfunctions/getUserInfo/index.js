const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()

  try {
    const res = await db.collection('userInfo')
      .where({ _openid: wxContext.OPENID })
      .get()

    return res
  } catch (e) {
    console.error('【getUserInfo】查询 userInfo 时出错：', e)
    throw e
  }
}
