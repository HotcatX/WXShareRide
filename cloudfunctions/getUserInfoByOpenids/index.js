const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// event.openids: string[]  要查询的一组 openid
exports.main = async (event, context) => {
  const { openids } = event || {}

  console.log('【getUserInfoByOpenids】收到 openids =', openids)

  if (!Array.isArray(openids) || openids.length === 0) {
    return { ok: false, errorMsg: 'openids 为空' }
  }

  try {
    const res = await db.collection('userInfo')
      .where({
        _openid: _.in(openids)
      })
      .get()

    console.log('【getUserInfoByOpenids】查询结果条数 =', res.data.length)

    return {
      ok: true,
      data: res.data         // 每个元素里有 _openid / name / phone / wechatID 等
    }
  } catch (e) {
    console.error('【getUserInfoByOpenids】查询出错：', e)
    return { ok: false, errorMsg: e.message || '查询失败' }
  }
}