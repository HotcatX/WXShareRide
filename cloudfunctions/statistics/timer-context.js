// Read only this invocation's context. process.env/getWXContext may retain
// identity fields from an earlier invocation when an instance is reused.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const FIELDS = { TCB_SOURCE: 'SOURCE', WX_OPENID: 'OPENID', WX_FROM_OPENID: 'FROM_OPENID' }

function getInvocationContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  try {
    let environment
    // A supplied modern context takes precedence, including when malformed.
    // Never fall through from it to older or process-global values.
    if (own(input, 'environment')) {
      if (typeof input.environment !== 'string' || !input.environment) return {}
      environment = JSON.parse(input.environment)
      if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return {}
    } else {
      if (!own(input, 'environ') || typeof input.environ !== 'string') return {}
      environment = Object.create(null)
      for (const entry of input.environ.split(';')) {
        const separator = entry.indexOf('=')
        if (separator < 0) continue
        const key = entry.slice(0, separator)
        if (!own(FIELDS, key)) continue
        // Ambiguous legacy context must not authenticate a timer.
        if (own(environment, key)) return {}
        environment[key] = entry.slice(separator + 1)
      }
    }
    if (!own(environment, 'TCB_SOURCE') || typeof environment.TCB_SOURCE !== 'string' ||
      !environment.TCB_SOURCE || environment.TCB_SOURCE.length > 256) return {}
    const result = { SOURCE: environment.TCB_SOURCE }
    for (const key of ['WX_OPENID', 'WX_FROM_OPENID']) {
      if (!own(environment, key) || environment[key] === '') continue
      // Unexpected identity types fail closed instead of becoming "no user".
      if (typeof environment[key] !== 'string') return {}
      result[FIELDS[key]] = environment[key]
    }
    return result
  } catch (_) {
    return {}
  }
}

module.exports = { getInvocationContext }
