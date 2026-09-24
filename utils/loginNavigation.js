const HOME = '/pages/home/home'
const PUBLIC_TABS = new Set([HOME, '/pages/market/market'])
const PUBLIC_PAGES = new Set([
  ...PUBLIC_TABS,
  '/pages/home/carpoolList/carpoolList',
  '/pages/home/tripDetail/tripDetail',
  '/pages/home/requestDetail/requestDetail',
  '/pages/market/marketDetail/marketDetail',
  '/pages/market/marketSeller/marketSeller'
])

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\#]/.test(value)) return ''
  const url = value.startsWith('/') ? value : `/${value}`
  return PUBLIC_PAGES.has(url.split('?')[0]) ? url : ''
}

// Cancelling login/onboarding must not return to a private page that opens it again.
function returnToPublicPage(pendingUrl = '') {
  const goHome = () => wx.switchTab({ url: HOME, fail: () => wx.reLaunch({ url: HOME }) })
  const goPending = () => {
    const url = publicUrl(pendingUrl)
    if (!url) return goHome()
    const route = url.split('?')[0]
    if (PUBLIC_TABS.has(route)) return wx.switchTab({ url: route, fail: () => wx.reLaunch({ url: HOME }) })
    wx.redirectTo({ url, fail: goHome })
  }
  const pages = getCurrentPages()
  const previous = pages.length > 1 ? pages[pages.length - 2] : null
  if (previous && publicUrl(previous.route)) {
    wx.navigateBack({ delta: 1, fail: goPending })
    return
  }
  goPending()
}

module.exports = { returnToPublicPage }
