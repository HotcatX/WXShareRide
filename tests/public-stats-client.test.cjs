const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(storage = {}) {
  const state = { network: [], personalReads: 0, timers: new Map(), sequence: 0 }
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    getWindowInfo: () => ({ windowWidth: 390, statusBarHeight: 44 }),
    showShareMenu() {}, stopPullDownRefresh() {},
    request: options => state.network.push(options.url),
    cloud: { callFunction: options => state.network.push(options.name) }
  }
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/home.js'), 'utf8'), {
    Page: value => { definition = value }, wx, Date, console,
    setTimeout(fn) { const id = ++state.sequence; state.timers.set(id, fn); return id },
    clearTimeout(id) { state.timers.delete(id) },
    require(name) {
      if (name.endsWith('/backendClient')) return {
        ready: async () => {}, get: async route => {
          state.network.push(route)
          return { servedCount: 10194, coverageText: 'NY / NJ' }
        }
      }
      if (name.endsWith('/cityTree')) return {
        getCitySnapshot: () => ({ key: 'ny_nj' }), getStoredCitySnapshot: () => ({ key: 'ny_nj' }),
        getCountryTabs: () => [], getCountryGroups: () => []
      }
      if (name.endsWith('/tripFollowup')) return { hide() {}, dispose() {}, canConsider: () => false }
      if (name.endsWith('/analyticsSession')) return { subscribe: () => () => {} }
      return {}
    }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) } }
  page._applyCityUi = page.loadCityTreeFromCloud = page.onCommunityNoticeClose = () => {}
  page.refreshCommunityConfig = page.loadUnreadCount = page.loadHomeFollowup = async () => {}
  page.refreshHomeData = async () => { state.personalReads++ }
  async function show() {
    page.onShow()
    for (const [id, fn] of state.timers) { state.timers.delete(id); fn() }
    await tick()
  }
  return { page, storage, state, show }
}

test('first home entry never requests cumulative statistics with empty, cleared, or old milestone cache', async () => {
  for (const storage of [
    {},
    { openid: 'member', isGuest: false },
    { openid: 'member', homePublicStatsCacheV1: { version: 1, syncedAt: 1,
      data: { servedTrips: 10194, coverageText: 'NY / NJ' } } }
  ]) {
    const { page, state, show } = harness(storage)
    page.onLoad({})
    await show()
    assert.equal(state.personalReads, 1)
    assert.deepEqual(state.network, [])
    page.onUnload()
  }
})

test('home refresh, page return, and member/guest changes keep the milestone free of network reads', async () => {
  const { page, storage, state, show } = harness({ openid: 'member-a', isGuest: false })
  page.onLoad({})
  await show()
  await page.onPullDownRefresh()
  for (const identity of [{ openid: 'member-b', isGuest: false }, { openid: '', isGuest: true }]) {
    page.onHide()
    Object.assign(storage, identity)
    await show()
    await page.onHomeRefresherRefresh()
  }
  assert.equal(state.personalReads, 6)
  assert.equal(page.data.refresherTriggered, false)
  assert.deepEqual(state.network, [])
  page.onUnload()
})
