const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { openids } = event || {}

  if (!Array.isArray(openids) || openids.length === 0) {
    return { ok: false, errorMsg: 'openids 为空' }
  }

  try {
    const res = await db.collection('userInfo')
      .where({
        _openid: _.in(openids)
      })
      .get()

    return {
      ok: true,
      data: res.data
    }
  } catch (e) {
    console.error('【getUserInfoByOpenids】查询出错：', e)
    return { ok: false, errorMsg: e.message || '查询失败' }
  }
}
