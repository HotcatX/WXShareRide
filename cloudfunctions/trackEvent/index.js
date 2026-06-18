const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const COLLECTION = 'analytics_events'
const MAX_STRING_LENGTH = 120
const MAX_SESSION_LENGTH = 80

const EVENT_ALLOWLIST = new Set([
  'app_launch',
  'page_view',
  'home_sync',
  'home_trip_load',
  'carpool_list_load',
  'carpool_route_click',
  'carpool_filter_change',
  'carpool_detail_load',
  'carpool_join_click',
  'carpool_join_success',
  'carpool_join_fail',
  'carpool_accept_click',
  'carpool_accept_success',
  'carpool_accept_fail',
  'market_list_load',
  'market_filter_click',
  'market_search_submit',
  'market_detail_load',
  'market_contact_seller_click',
  'market_post_start',
  'market_image_upload_start',
  'market_image_upload_done',
  'market_image_upload_fail',
  'market_publish_click',
  'market_publish_success',
  'market_publish_fail'
])

const ALLOWED_STRING_FIELDS = [
  'event',
  'page',
  'module',
  'action',
  'source',
  'result',
  'errorCode',
  'category',
  'city',
  'region',
  'priceBucket',
  'sizeBucket',
  'networkType',
  'appVersion',
  'routeType',
  'filterName',
  'filterValue'
]

const ALLOWED_NUMBER_FIELDS = [
  'durationMs',
  'imageCount',
  'listCount',
  'carpoolCount',
  'requestCount',
  'failCount',
  'cacheHit'
]

function clampString(value, maxLength = MAX_STRING_LENGTH) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function toFiniteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function hashOpenid(openid, env) {
  if (!openid) return ''
  const salt = process.env.ANALYTICS_SALT || env || 'default'
  return crypto.createHash('sha256').update(`${salt}:${openid}`).digest('hex')
}

function sanitizePayload(event = {}) {
  const doc = {}

  ALLOWED_STRING_FIELDS.forEach(field => {
    if (event[field] !== undefined && event[field] !== null) {
      doc[field] = clampString(event[field])
    }
  })

  ALLOWED_NUMBER_FIELDS.forEach(field => {
    const value = toFiniteNumber(event[field])
    if (value !== null) doc[field] = value
  })

  if (event.sessionId) {
    doc.sessionId = clampString(event.sessionId, MAX_SESSION_LENGTH)
  }

  return doc
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const eventName = clampString(event && event.event, 80)

  if (!eventName || !EVENT_ALLOWLIST.has(eventName)) {
    return { ok: false, errorMsg: 'invalid event' }
  }

  const doc = sanitizePayload({ ...event, event: eventName })
  const now = db.serverDate()

  await db.collection(COLLECTION).add({
    data: {
      ...doc,
      userHash: hashOpenid(wxContext.OPENID, wxContext.ENV),
      env: wxContext.ENV || '',
      createTime: now
    }
  })

  return { ok: true }
}
