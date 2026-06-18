const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const COLLECTION = 'PublicStats'
const HOME_DOC_ID = 'home'

function getServedTrips(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function normalizeStats(data = {}) {
  return {
    _id: HOME_DOC_ID,
    servedTrips: getServedTrips(data.servedTrips),
    coverageText: data.coverageText || 'N/A'
  }
}

exports.main = async () => {
  try {
    const res = await db.collection(COLLECTION).doc(HOME_DOC_ID).get()
    return {
      success: true,
      data: normalizeStats(res.data || {})
    }
  } catch (e) {
    return {
      success: false,
      data: normalizeStats(),
      errorMsg: e.message || String(e)
    }
  }
}
