const https = require('https')
const ENDPOINT = 'https://collect.linkx.ink/api/v1/statistics/public'

// TEMPORARY FALLBACK — remove only after the next production release is verified
// and old clients no longer call statistics.publicStats. Server authority never
// falls back to CloudBase: both old and new clients read the same database.
function readServerStats(request = https.request) {
  return new Promise((resolve, reject) => {
    let settled = false, req
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(new Error('PUBLIC_STATS_UNAVAILABLE'))
      else resolve(value)
    }
    const deadline = setTimeout(() => { finish(true); if (req) req.destroy() }, 8000)
    try {
      req = request(ENDPOINT, { method: 'GET', headers: { 'Accept-Encoding': 'identity' } }, res => {
        res.on('error', () => finish(true)); res.on('aborted', () => finish(true))
        const length = res.headers['content-length'], encoding = res.headers['content-encoding']
        if (res.statusCode !== 200 || encoding && encoding !== 'identity' ||
          length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 8192)) {
          finish(true); res.destroy(); return
        }
        let size = 0
        const chunks = []
        res.on('data', chunk => {
          size += chunk.length
          if (size > 8192) { finish(true); res.destroy(); return }
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            if (length !== undefined && Number(length) !== size) throw new Error()
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
            const data = value && value.data
            if (value.ok !== true || !data || !Number.isSafeInteger(data.servedCount) || data.servedCount < 0 ||
              data.coverageText !== null && (typeof data.coverageText !== 'string' || data.coverageText.length > 120 ||
              /[\u0000-\u001f\u007f]/.test(data.coverageText))) throw new Error()
            finish(false, { _id: 'home', servedTrips: data.servedCount, coverageText: data.coverageText || 'N/A' })
          } catch (_) { finish(true) }
        })
      })
      req.on('error', () => finish(true)); req.end()
    } catch (_) { finish(true); if (req) req.destroy() }
  })
}

function createPublicStatsReader({ authority, readCloudStats, readServer = readServerStats }) {
  return async () => {
    if (authority === 'cloudbase') return readCloudStats()
    if (authority === 'server') return readServer()
    throw new Error('PUBLIC_STATS_UNAVAILABLE')
  }
}
module.exports = { ENDPOINT, readServerStats, createPublicStatsReader }
