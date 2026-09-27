// The generated cloud authority.js is the only deployment choice. Persist only
// the irreversible handoff, never permission to use CloudBase while offline.
const SERVER_KEY = 'linkx.backend.authority.v1'
const APP_ID = 'wx8a8a389199aa2a0e'
const error = (code, message = '服务连接尚未确认，请稍后重试') => Object.assign(new Error(message), { code })

function createBackendAuthority(options = {}) {
  const api = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const setTimer = options.setTimeout || setTimeout, clearTimer = options.clearTimeout || clearTimeout
  let mode = null, phase = 'unknown', epoch = 0, flight = null, initialized = false, serverSeen = false
  const listeners = new Set()
  function state() { return { mode, phase, epoch, ready: phase === 'ready' } }
  function transition(next) {
    phase = next; epoch++
    for (const listener of listeners) { try { listener(state()) } catch (_) {} }
  }
  function initialize() {
    if (initialized) return
    let stored
    try { stored = api.getStorageSync(SERVER_KEY) }
    catch (_) { throw error('LOCAL_STORAGE_UNAVAILABLE') }
    if (stored !== undefined && stored !== null && stored !== '' && stored !== 'server') throw error('LOCAL_STORAGE_UNAVAILABLE')
    initialized = true; serverSeen = stored === 'server'
  }
  function rememberServer() {
    serverSeen = true
    try {
      api.setStorageSync(SERVER_KEY, 'server')
      if (api.getStorageSync(SERVER_KEY) !== 'server') throw new Error()
      // Clear only unscoped legacy display caches at server startup. A late old
      // response might have saved them just before the prior runtime stopped.
      // Preserve identities, drafts, all pending operations and event queues.
      if (mode === null) {
        api.removeStorageSync('userInfo')
        api.removeStorageSync('my_referral_code')
      }
    } catch (_) { throw error('LOCAL_STORAGE_UNAVAILABLE') }
    if (mode === 'cloudbase') {
      transition('restart_required')
      throw error('BACKEND_RESTART_REQUIRED', '服务已升级，请重新打开小程序后继续')
    }
    mode = 'server'; transition('ready'); return mode
  }
  function handshake() {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (failure, value) => {
        if (settled) return
        settled = true; clearTimer(timer)
        failure ? reject(failure) : resolve(value)
      }
      const timer = setTimer(() => finish(error('BACKEND_NOT_READY')), 15000)
      try {
        Promise.resolve(api.cloud.callFunction({ name: 'backend', data: { action: 'authority' } })).then(response => {
          const result = response && response.result, data = result && result.data
          if (!result || result.ok !== true || !data || data.appId !== APP_ID ||
              !['cloudbase', 'server'].includes(data.authority) || Object.keys(data).some(key => !['appId', 'authority'].includes(key))) {
            finish(error('BACKEND_NOT_READY')); return
          }
          finish(null, data.authority)
        }, () => finish(error('BACKEND_NOT_READY')))
      } catch (_) { finish(error('BACKEND_NOT_READY')) }
    })
  }
  function start(refresh) {
    if (phase === 'restart_required') return Promise.reject(error('BACKEND_RESTART_REQUIRED', '服务已升级，请重新打开小程序后继续'))
    if (flight) return flight
    if (phase === 'ready' && (!refresh || mode === 'server')) return Promise.resolve(mode)
    transition('checking')
    const pending = Promise.resolve().then(() => {
      initialize()
      return serverSeen ? 'server' : handshake()
    }).then(next => {
      if (next === 'server' || serverSeen) return rememberServer()
      mode = 'cloudbase'; transition('ready'); return mode
    }).catch(failure => {
      if (phase !== 'restart_required') transition(serverSeen && mode === 'cloudbase' ? 'handoff_blocked' : 'unavailable')
      throw failure
    }).finally(() => { if (flight === pending) flight = null })
    flight = pending
    return pending
  }
  function getMode() {
    // Reading the fixed wire representation is not permission to start I/O.
    // Already-submitted ACKs must still render during a same-source recheck.
    if (mode === null || ['restart_required', 'handoff_blocked'].includes(phase)) {
      throw error(['restart_required', 'handoff_blocked'].includes(phase) ? 'BACKEND_RESTART_REQUIRED' : 'BACKEND_NOT_READY')
    }
    return mode
  }
  return { ready: () => start(false), refresh: () => start(true), getMode, state,
    isReady: () => phase === 'ready',
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } }
}

let singleton
function authority() { if (!singleton) singleton = createBackendAuthority(); return singleton }
module.exports = { createBackendAuthority, SERVER_KEY, APP_ID,
  ...Object.fromEntries(['ready', 'refresh', 'getMode', 'state', 'isReady', 'subscribe'].map(name => [name, (...args) => authority()[name](...args)])) }
