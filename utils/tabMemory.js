const TAB_MEMORY_KEY = 'app_last_bottom_tab_v1'
const TAB_MEMORY_TTL = 30 * 24 * 60 * 60 * 1000
const MARKET_TYPE_KEY = 'market_active_listing_type_v1'
const HOME_ROUTE = 'pages/home/home'
const TAB_ROUTES = {
  home: HOME_ROUTE,
  goods: 'pages/market/market',
  sublet: 'pages/market/market',
  profile: 'pages/profile/profile'
}
// Normal launches from Recents, an Android shortcut or the WeChat tab menu.
// Explicit shares, QR codes and other external entry points keep their target.
const RESUME_SCENES = new Set([1001, 1023, 1089, 1090])
let pendingTab = ''

function isTab(tab) {
  return typeof tab === 'string' && Object.prototype.hasOwnProperty.call(TAB_ROUTES, tab)
}

function rememberTab(tab) {
  if (!isTab(tab)) return false
  try {
    wx.setStorageSync(TAB_MEMORY_KEY, { version: 1, tab, savedAt: Date.now() })
    return true
  } catch (_) { return false }
}

function readRememberedTab() {
  try {
    const entry = wx.getStorageSync(TAB_MEMORY_KEY)
    if (!entry || entry.version !== 1 || !isTab(entry.tab) ||
      !Number.isSafeInteger(entry.savedAt) || entry.savedAt <= 0) return ''
    const age = Date.now() - entry.savedAt
    return age >= 0 && age < TAB_MEMORY_TTL ? entry.tab : ''
  } catch (_) { return '' }
}

function prepareLaunch(options = {}) {
  pendingTab = ''
  const route = String(options.path || HOME_ROUTE).replace(/^\//, '')
  if (!RESUME_SCENES.has(Number(options.scene)) || route !== HOME_ROUTE ||
    Object.keys(options.query || {}).length || options.shareTicket ||
    (options.referrerInfo && options.referrerInfo.appId)) return
  pendingTab = readRememberedTab()
}

function restoreOnReady(route) {
  const tab = pendingTab
  // Only the first page of a cold launch may restore. Later navigation and
  // returning from the background must never redirect an in-progress task.
  pendingTab = ''
  if (!tab || String(route || '').replace(/^\//, '') !== HOME_ROUTE) return false
  if (tab === 'home') {
    rememberTab(tab)
    return false
  }
  try {
    if (typeof wx.switchTab !== 'function') return false
    // Both market columns share one native tab; market.onLoad reads this key.
    if (tab === 'goods' || tab === 'sublet') wx.setStorageSync(MARKET_TYPE_KEY, tab)
    wx.switchTab({ url: `/${TAB_ROUTES[tab]}`, success: () => rememberTab(tab) })
    return true
  } catch (_) { return false }
}

module.exports = { TAB_MEMORY_KEY, TAB_MEMORY_TTL, rememberTab, readRememberedTab, prepareLaunch, restoreOnReady }
