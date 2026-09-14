// Fixed, read-only community configuration. Storage IDs and arbitrary document
// fields never leave this handler; image URLs are resolved on every request.
const COLLECTION = 'community_config'
const DOCUMENT_ID = 'main'
const PROJECTION = Object.fromEntries([
  'group.enabled', 'group.title', 'group.imageFileID', 'group.expiresAt',
  'announcement.enabled', 'announcement.id', 'announcement.title', 'announcement.body',
  'announcement.imageFileID', 'announcement.showGroupImage', 'announcement.maxShows',
  'announcement.intervalHours', 'announcement.startAt', 'announcement.endAt'
].map(field => [field, true]))
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

function cleanText(value, limit, multiline = false) {
  if (typeof value !== 'string') return ''
  let result = value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
  result = multiline ? result.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : result.replace(/\s+/g, ' ')
  return result.trim().slice(0, limit)
}

function timestamp(value) {
  if (value instanceof Date) return validTimestamp(value.getTime())
  if (typeof value === 'number') return validTimestamp(value)
  if (value && typeof value === 'object') {
    if (own(value, '$date')) return timestamp(value.$date)
    if (own(value, '$numberLong') && /^\d+$/.test(value.$numberLong)) return validTimestamp(Number(value.$numberLong))
    return 0
  }
  if (typeof value !== 'string') return 0
  const text = value.trim()
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (!parts) return 0
  const [, year, month, day, hour, minute, second] = parts
  const days = new Date(Date.UTC(+year, +month, 0)).getUTCDate()
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +(second || 0) > 59) return 0
  return validTimestamp(Date.parse(text))
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0
}

function optionalTime(value) {
  // The web admin stores an unset boundary as numeric zero.
  if (value === undefined || value === null || value === '' || value === 0) return { valid: true, value: 0 }
  const parsed = timestamp(value)
  return { valid: parsed > 0, value: parsed }
}

function safeFileID(value, env) {
  if (typeof value !== 'string' || value.length > 2048 || typeof env !== 'string' || !/^[a-z\d-]+$/i.test(env)) return ''
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(value)
  if (!match || !match[1].startsWith(env + '.') || !/^[a-z\d-]+$/i.test(match[1].slice(env.length + 1))) return ''
  const filePath = match[2]
  if (/[\s%?#\\\u0000-\u001f]/.test(filePath) || filePath.split('/').some(part => !part || part === '.' || part === '..')) return ''
  return /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(filePath) ? value : ''
}

function safeImageURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return ''
  try {
    const url = new URL(value)
    const hosts = ['tcb.qcloud.la', 'tcloudbaseapp.com', 'myqcloud.com', 'tencentcos.cn', 'qcloud.com']
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return ''
    return hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : ''
  } catch (_) { return '' }
}

function unavailable() {
  return { ok: false, error: 'community_config_unavailable', message: '暂时无法加载社群信息，请稍后重试' }
}

function createCommunityConfigHandler({ db, cloud, now = () => Date.now(), getEnvId }) {
  const environment = getEnvId || (() => {
    const context = cloud.getWXContext()
    return context.ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || ''
  })
  return async function communityConfig() {
    try {
      const response = await db.collection(COLLECTION).doc(DOCUMENT_ID).field(PROJECTION).get()
      // A successful, absent document means no configuration. Transport/backend
      // failures must reach the friendly error response, never look like opt-out.
      if (!response || !own(response, 'data')) return unavailable()
      const document = record(response.data)
      const groupSource = record(document.group)
      const announcementSource = record(document.announcement)
      const env = environment()
      const groupFile = safeFileID(groupSource.imageFileID, env)
      const groupExpiry = timestamp(groupSource.expiresAt)
      const startedAt = now()
      if (!validTimestamp(startedAt)) return unavailable()
      const groupCandidate = groupSource.enabled === true && !!groupFile && groupExpiry > startedAt
      const group = { enabled: false, title: cleanText(groupSource.title, 80) || '加入拼车群', imageUrl: '', expiresAt: groupExpiry }

      const id = typeof announcementSource.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(announcementSource.id) ? announcementSource.id : ''
      const body = cleanText(announcementSource.body, 2000, true)
      const title = cleanText(announcementSource.title, 80) || '最新消息'
      const start = optionalTime(announcementSource.startAt)
      const end = optionalTime(announcementSource.endAt)
      const usesGroup = announcementSource.showGroupImage === true
      const announcementFile = usesGroup ? (groupCandidate ? groupFile : '') : safeFileID(announcementSource.imageFileID, env)
      const maxShows = announcementSource.maxShows === undefined ? 1 : announcementSource.maxShows
      const intervalHours = announcementSource.intervalHours === undefined ? 24 : announcementSource.intervalHours
      const validFrequency = Number.isInteger(maxShows) && maxShows >= 1 && maxShows <= 100 &&
        typeof intervalHours === 'number' && Number.isFinite(intervalHours) && intervalHours >= 0 && intervalHours <= 8760
      const endsAt = usesGroup && groupExpiry ? (end.value ? Math.min(end.value, groupExpiry) : groupExpiry) : end.value
      const validWindow = start.valid && end.valid && (!endsAt || !start.value || start.value < endsAt)
      const announcementCandidate = !!id && !!(body || announcementFile) && validWindow &&
        (!start.value || start.value <= startedAt) && (!endsAt || startedAt < endsAt) && (!usesGroup || groupCandidate)
      const announcement = {
        available: false, enabled: false, id, title, body, imageUrl: '',
        maxShows: validFrequency ? maxShows : 0, intervalHours: validFrequency ? intervalHours : 0,
        startAt: start.value, endAt: endsAt
      }

      const fileList = [...new Set([groupCandidate ? groupFile : '', announcementCandidate ? announcementFile : ''].filter(Boolean))]
      const urls = new Map()
      if (fileList.length) {
        const result = await cloud.getTempFileURL({ fileList })
        if (!result || !Array.isArray(result.fileList)) return unavailable()
        for (const fileID of fileList) {
          const rows = result.fileList.filter(row => row && row.fileID === fileID)
          const row = rows.length === 1 ? rows[0] : null
          const url = row && (row.status === undefined || row.status === 0) ? safeImageURL(row.tempFileURL) : ''
          if (!url) return unavailable()
          urls.set(fileID, url)
        }
      }
      const serverTime = now()
      if (!validTimestamp(serverTime)) return unavailable()
      group.enabled = groupCandidate && groupExpiry > serverTime
      if (group.enabled) group.imageUrl = urls.get(groupFile) || ''
      announcement.available = announcementCandidate && (!endsAt || serverTime < endsAt) && (!usesGroup || group.enabled)
      if (announcement.available) announcement.imageUrl = urls.get(announcementFile) || ''
      announcement.enabled = announcementSource.enabled === true && announcement.available && validFrequency
      return { ok: true, serverTime, group, announcement }
    } catch (_) { return unavailable() }
  }
}

module.exports = { createCommunityConfigHandler }
