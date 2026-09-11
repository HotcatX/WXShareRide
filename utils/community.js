const { isTimelinePreview } = require('./timeline')

const HISTORY_KEY = 'community_announcement_history_v1'
const MAX_HISTORY = 100
const REQUEST_TIMEOUT_MS = 15000
let pendingRequest = null

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit) : ''
}

function imageURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return ''
  const match = /^https:\/\/([a-z\d.-]+)(?::443)?(?:[/?#][^\s\\]*)?$/i.exec(value)
  if (!match || match[1].split('.').some(label => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) return ''
  return value
}

function performanceNow() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getPerformance === 'function') {
      const performance = wx.getPerformance()
      const time = performance && typeof performance.now === 'function' ? performance.now() : NaN
      if (Number.isFinite(time) && time >= 0) return time
    }
  } catch (_) {}
  return null
}

// Advance from server time, even on devices whose wall clock has the wrong date.
function getCommunityNow(config) {
  const clock = config && config._clock
  if (!clock || !validTime(clock.serverTime) || !validTime(clock.clientTime)) return Date.now()
  const monotonic = performanceNow()
  const elapsed = clock.monotonicTime !== null && monotonic !== null && monotonic >= clock.monotonicTime
    ? monotonic - clock.monotonicTime : Date.now() - clock.clientTime
  return clock.serverTime + Math.max(0, elapsed)
}

function normalizeConfig(result) {
  if (!result || result.ok !== true || !validTime(result.serverTime) || !result.serverTime) throw friendlyError()
  const group = object(result.group)
  const notice = object(result.announcement)
  const maxShows = notice.maxShows === undefined ? 1 : notice.maxShows
  const intervalHours = notice.intervalHours === undefined ? 24 : notice.intervalHours
  const validFrequency = Number.isInteger(maxShows) && maxShows >= 1 && maxShows <= 100 &&
    typeof intervalHours === 'number' && Number.isFinite(intervalHours) && intervalHours >= 0 && intervalHours <= 8760
  const startAt = notice.startAt === undefined ? 0 : notice.startAt
  const endAt = notice.endAt === undefined ? 0 : notice.endAt
  const validWindow = validTime(startAt) && validTime(endAt) && (!startAt || !endAt || startAt < endAt)
  const safeImage = imageURL(notice.imageUrl)
  return {
    ok: true,
    serverTime: result.serverTime,
    _clock: { serverTime: result.serverTime, clientTime: Date.now(), monotonicTime: performanceNow() },
    group: {
      enabled: group.enabled === true,
      title: cleanText(group.title, 80),
      imageUrl: imageURL(group.imageUrl),
      expiresAt: validTime(group.expiresAt) ? group.expiresAt : 0
    },
    announcement: {
      available: notice.available === true && validWindow && (!notice.imageUrl || !!safeImage),
      enabled: notice.enabled === true && validFrequency,
      id: validId(notice.id) ? notice.id : '',
      title: cleanText(notice.title, 80),
      body: cleanText(notice.body, 2000),
      imageUrl: safeImage,
      maxShows: validFrequency ? maxShows : 0,
      intervalHours: validFrequency ? intervalHours : 0,
      startAt: validWindow ? startAt : 0,
      endAt: validWindow ? endAt : 0
    }
  }
}

function canRequest() {
  return typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callFunction === 'function' && !isTimelinePreview()
}

function friendlyError(timeout = false) {
  const error = new Error(timeout ? '加载时间有点久，请稍后重试' : '暂时无法加载社群信息，请稍后重试')
  error.code = timeout ? 'TIMEOUT' : 'COMMUNITY_UNAVAILABLE'
  return error
}

// There is deliberately no settled-value cache: each visit and manual tap can
// observe a server-side switch-off or a replaced/expired QR code immediately.
function loadCommunityConfig({ force = false } = {}) {
  void force
  if (!canRequest()) return Promise.resolve(null)
  if (pendingRequest) return pendingRequest
  const request = new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(friendlyError(true)), REQUEST_TIMEOUT_MS)
    try {
      Promise.resolve(wx.cloud.callFunction({ name: 'marketApi', data: { action: 'communityConfig' } }))
        .then(response => {
          if (!canRequest()) return finish(null, null)
          try { finish(null, normalizeConfig(response && response.result)) } catch (_) { finish(friendlyError()) }
        }, () => finish(friendlyError()))
    } catch (_) { finish(friendlyError()) }
  })
  pendingRequest = request.then(value => {
    pendingRequest = null
    return value
  }, error => {
    pendingRequest = null
    throw error
  })
  return pendingRequest
}

function isGroupAvailable(config) {
  const group = config && config.group
  return !!(group && group.enabled === true && imageURL(group.imageUrl) && validTime(group.expiresAt) && group.expiresAt > getCommunityNow(config))
}

// Manual viewing ignores the automatic switch and frequency, but never bypasses
// the server's availability decision or the advancing validity window.
function getAvailableAnnouncement(config) {
  if (isTimelinePreview()) return null
  const notice = config && config.announcement
  if (!notice || notice.available !== true || !validId(notice.id)) return null
  const body = cleanText(notice.body, 2000)
  const imageUrl = imageURL(notice.imageUrl)
  const startAt = notice.startAt === undefined ? 0 : notice.startAt
  const endAt = notice.endAt === undefined ? 0 : notice.endAt
  if ((!body && !imageUrl) || (notice.imageUrl && !imageUrl) || !validTime(startAt) || !validTime(endAt) ||
    (startAt && endAt && startAt >= endAt)) return null
  const now = getCommunityNow(config)
  if ((startAt && now < startAt) || (endAt && now >= endAt)) return null
  return {
    available: true, enabled: notice.enabled === true, id: notice.id,
    title: cleanText(notice.title, 80), body, imageUrl,
    maxShows: notice.maxShows, intervalHours: notice.intervalHours, startAt, endAt
  }
}

function readHistory() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function' || typeof wx.setStorageSync !== 'function') return null
    const stored = wx.getStorageSync(HISTORY_KEY)
    if (stored === undefined || stored === null || stored === '') return []
    if (!stored || stored.version !== 1 || !Array.isArray(stored.items) || stored.items.length > 1000) return null
    const ids = new Set()
    const entries = []
    for (const item of stored.items) {
      if (!item || !validId(item.id) || ids.has(item.id) || !Number.isInteger(item.count) || item.count < 0 || item.count > 1000 || !validTime(item.lastShownAt)) return null
      ids.add(item.id)
      entries.push({ id: item.id, count: item.count, lastShownAt: item.lastShownAt })
    }
    return entries
  } catch (_) { return null }
}

function eligibleNotice(config, history) {
  const notice = getAvailableAnnouncement(config)
  if (!notice || !notice.enabled || !history) return null
  const maxShows = notice.maxShows === undefined ? 1 : notice.maxShows
  const intervalHours = notice.intervalHours === undefined ? 24 : notice.intervalHours
  if (!Number.isInteger(maxShows) || maxShows < 1 || maxShows > 100 || typeof intervalHours !== 'number' ||
    !Number.isFinite(intervalHours) || intervalHours < 0 || intervalHours > 8760) return null
  const previous = history.find(item => item.id === notice.id)
  const now = getCommunityNow(config)
  if (previous && (previous.count >= maxShows || now < previous.lastShownAt || now - previous.lastShownAt < intervalHours * 3600000)) return null
  return notice
}

function shouldShowAnnouncement(config) {
  return !!eligibleNotice(config, readHistory())
}

// Persist immediately before showing. A failed storage write prevents the
// automatic display, so inaccessible storage cannot create endless popups.
function recordAnnouncementShown(config) {
  const history = readHistory()
  const notice = eligibleNotice(config, history)
  if (!notice) return false
  const previous = history.find(item => item.id === notice.id)
  const next = history.filter(item => item.id !== notice.id)
  next.unshift({ id: notice.id, count: Math.min(1000, (previous ? previous.count : 0) + 1), lastShownAt: Math.floor(getCommunityNow(config)) })
  next.sort((a, b) => b.lastShownAt - a.lastShownAt)
  try {
    wx.setStorageSync(HISTORY_KEY, { version: 1, items: next.slice(0, MAX_HISTORY) })
    return true
  } catch (_) { return false }
}

module.exports = {
  loadCommunityConfig, isGroupAvailable, getAvailableAnnouncement,
  shouldShowAnnouncement, recordAnnouncementShown, getCommunityNow
}
