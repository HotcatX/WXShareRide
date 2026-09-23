// Identity must come from this invocation's trusted runtime context. Never use
// event.openid, process.env, or an SDK's process-global context fallback.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const FIELDS = ['TCB_SOURCE', 'WX_OPENID', 'WX_APPID', 'WX_FROM_OPENID', 'WX_FROM_APPID']
const APPID = 'wx8a8a389199aa2a0e'

function getIdentity(context) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return null
    let environment
    if (own(context, 'environment')) {
      if (typeof context.environment !== 'string' || !context.environment) return null
      environment = JSON.parse(context.environment)
      if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null
    } else {
      if (!own(context, 'environ') || typeof context.environ !== 'string') return null
      environment = Object.create(null)
      for (const entry of context.environ.split(';')) {
        const split = entry.indexOf('=')
        if (split < 0) continue
        const key = entry.slice(0, split)
        if (!FIELDS.includes(key)) continue
        if (own(environment, key)) return null
        environment[key] = entry.slice(split + 1)
      }
    }
    if (!['wx_client', 'wx_devtools'].includes(environment.TCB_SOURCE) || environment.WX_APPID !== APPID ||
      typeof environment.WX_OPENID !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(environment.WX_OPENID) ||
      (own(environment, 'WX_FROM_OPENID') && environment.WX_FROM_OPENID !== '') ||
      (own(environment, 'WX_FROM_APPID') && environment.WX_FROM_APPID !== '')) return null
    return { appid: APPID, openid: environment.WX_OPENID }
  } catch (_) { return null }
}

module.exports = { getIdentity, APPID }
