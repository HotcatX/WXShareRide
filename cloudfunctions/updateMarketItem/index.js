const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { id, patch } = event || {}

  if (!id) return { ok: false, error: 'missing_id' }
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'missing_patch' }

  // ✅ 白名单字段：只允许改这些，避免误覆盖
  const ALLOWED = new Set([
    'title',
    'price',
    'category',
    'region',
    'location',
    'condition',
    'desc',
    'imageFileID',
    'thumbFileID',
    'imageFileIDs',
    'thumbFileIDs'
  ])

  const safePatch = {}
  Object.keys(patch).forEach(k => {
    if (ALLOWED.has(k)) safePatch[k] = patch[k]
  })

  if (Object.keys(safePatch).length === 0) {
    return { ok: false, error: 'empty_patch' }
  }

  const res = await db.collection('market_goods')
    .where({ _id: id, _openid: OPENID })
    .update({
      data: {
        ...safePatch,
        updateTime: db.serverDate()
      }
    })

  return { ok: true, updated: res.stats.updated }
}
