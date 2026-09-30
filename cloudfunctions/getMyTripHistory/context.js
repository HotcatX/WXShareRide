// Use only this invocation's trusted context; client payloads and process-global
// SDK/environment fallbacks are not authentication evidence.
const APPID = 'wx8a8a389199aa2a0e'
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const fields = ['TCB_SOURCE', 'WX_OPENID', 'WX_APPID', 'WX_FROM_OPENID', 'WX_FROM_APPID']

function getIdentity(context) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return null
    let environment
    if (own(context, 'environment')) {
      if (typeof context.environment !== 'string' || !context.environment || context.environment.length > 16384) return null
      environment = JSON.parse(context.environment)
      if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null
    } else {
      if (!own(context, 'environ') || typeof context.environ !== 'string' || context.environ.length > 16384) return null
      environment = Object.create(null)
      for (const entry of context.environ.split(';')) {
        const split = entry.indexOf('=')
        if (split < 0) continue
        const name = entry.slice(0, split)
        if (!fields.includes(name)) continue
        if (own(environment, name)) return null
        environment[name] = entry.slice(split + 1)
      }
    }
    if (['TCB_SOURCE', 'WX_APPID', 'WX_OPENID'].some(name => !own(environment, name)) ||
      !['wx_client', 'wx_devtools'].includes(environment.TCB_SOURCE) || environment.WX_APPID !== APPID ||
      typeof environment.WX_OPENID !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(environment.WX_OPENID) ||
      (own(environment, 'WX_FROM_OPENID') && environment.WX_FROM_OPENID !== '') ||
      (own(environment, 'WX_FROM_APPID') && environment.WX_FROM_APPID !== '')) return null
    return { appId: APPID, openid: environment.WX_OPENID, source: environment.TCB_SOURCE }
  } catch (_) { return null }
}

module.exports = { APPID, getIdentity }
