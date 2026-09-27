// App's asynchronous handshake is not awaited by WeChat's Page lifecycle.
// Defer only lifecycle delivery; never save and replay a user's write click.
function createBackendPageGate({ authority, unavailable = () => {} }) {
  const nativeCallbacks = new Set(['onPullDownRefresh', 'onReachBottom', 'onPageScroll', 'onResize', 'onTabItemTap', 'onSaveExitState'])
  function canComplete() { try { authority.getMode(); return true } catch (_) { return false } }
  function userEvent(args) {
    const event = args[0]
    return !!event && typeof event === 'object' && typeof event.type === 'string' &&
      (!!event.currentTarget || !!event.target || Object.prototype.hasOwnProperty.call(event, 'detail'))
  }
  function wrapPage(definition) {
    const original = { ...definition }
    function initialize(page) {
      if (page.__backendPage) return page.__backendPage
      const state = { alive: true, visible: false, loaded: false, readySeen: false, readyCalled: false,
        show: 0, shown: 0, cleaning: false, options: {}, capturedAt: Date.now(), waiting: null }
      page.__backendPage = state
      const setData = page.setData
      page.setData = function(patch, callback) {
        if (state.alive && (state.cleaning || authority.isReady() || state.loaded && canComplete())) return setData.call(this, patch, callback)
      }
      return state
    }
    function invoke(page, name, args) {
      if (typeof original[name] !== 'function') return
      try {
        const result = original[name].apply(page, args)
        if (result && typeof result.catch === 'function') result.catch(unavailable)
        return result
      } catch (error) { unavailable(error) }
    }
    function deliver(page) {
      const state = initialize(page)
      if (!state.alive || !state.visible || !authority.isReady()) return
      if (!state.loaded) { state.loaded = true; invoke(page, 'onLoad', [state.options]) }
      if (state.shown !== state.show) { state.shown = state.show; invoke(page, 'onShow', state.showArgs || []) }
      if (state.readySeen && !state.readyCalled) { state.readyCalled = true; invoke(page, 'onReady', state.readyArgs || []) }
    }
    function wait(page) {
      const state = initialize(page)
      if (authority.isReady()) { deliver(page); return }
      if (state.waiting) return
      const pending = authority.ready().then(() => deliver(page), unavailable)
        .finally(() => { if (state.waiting === pending) state.waiting = null })
      state.waiting = pending
    }
    definition.onLoad = function(options = {}) { initialize(this).options = options; wait(this) }
    definition.onShow = function(...args) {
      const state = initialize(this); state.visible = true; state.show++; state.showArgs = args; wait(this)
    }
    definition.onReady = function(...args) {
      const state = initialize(this); state.readySeen = true; state.readyArgs = args; wait(this)
    }
    for (const name of ['onHide', 'onUnload']) definition[name] = function(...args) {
      const state = initialize(this); state.visible = false
      if (name === 'onUnload') state.alive = false
      state.cleaning = true
      try { if (state.loaded) return invoke(this, name, args) }
      finally { state.cleaning = false }
    }
    for (const [name, method] of Object.entries(original)) {
      if (typeof method !== 'function' || ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload'].includes(name)) continue
      definition[name] = function(...args) {
        const state = initialize(this)
        if (state.cleaning) return method.apply(this, args)
        if (!state.alive || !state.loaded || !authority.isReady() &&
            (!canComplete() || nativeCallbacks.has(name) || userEvent(args))) {
          if (name === 'onPullDownRefresh' && typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh()
          if (name === 'onShareAppMessage') return { title: '志远共享', path: '/pages/home/home' }
          if (name === 'onShareTimeline') return { title: '志远共享', query: '' }
          // No Promise here: synchronous formatters/share callbacks retain their
          // contracts, and a blocked submit is not automatically replayed.
          return undefined
        }
        return method.apply(this, args)
      }
    }
    return definition
  }
  return { wrapPage }
}
module.exports = { createBackendPageGate }
