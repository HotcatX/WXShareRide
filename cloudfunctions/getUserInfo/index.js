const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  console.log('【getUserInfo】当前云函数 ENV：', wxContext.ENV)
  console.log('【getUserInfo】当前 OPENID：', wxContext.OPENID)

  try {
    const res = await db.collection('userInfo')
      .where({ _openid: wxContext.OPENID })
      .get()

    console.log('【getUserInfo】userInfo 查询成功，记录条数：', res.data.length)
    return res
  } catch (e) {
    console.error('【getUserInfo】查询 userInfo 时出错：', e)
    // 把错误抛给前端，这样你在小程序控制台能看到完整 errCode
    throw e
  }
}
