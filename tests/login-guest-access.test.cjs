const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const HOME = '/pages/home/home'
const LOGIN = 'pages/other/login/login'
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness({ pages = [{ route: LOGIN }], storage = {}, call, bind, fail = [] } = {}) {
  let definition
  const calls = { cloud: [], navigation: [], toasts: [], identity: 0, referral: 0 }
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    showToast: options => calls.toasts.push(options.title),
    cloud: { callFunction(options) {
      calls.cloud.push(options.name)
      return call ? call(options) : Promise.resolve({ result: options.name === 'login'
        ? { ok: true, openid: 'test-login-user' } : { data: [{ profileCompleted: true }] } })
    } }
  }
  for (const kind of ['navigateBack', 'redirectTo', 'switchTab', 'reLaunch', 'navigateTo']) {
    wx[kind] = options => {
      calls.navigation.push({ kind, url: options.url || '', delta: options.delta })
      if (fail.includes(kind) && options.fail) options.fail()
      else if (options.success) options.success()
    }
  }
  const navModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/loginNavigation.js'), 'utf8'), {
    module: navModule, wx, getCurrentPages: () => pages
  })
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/other/login/login.js'), 'utf8'), {
    Page(value) { definition = value }, wx, getCurrentPages: () => pages,
    require(name) {
      if (name.endsWith('/loginNavigation')) return navModule.exports
      if (name.endsWith('/researchParticipation')) return { identityChanged() { calls.identity++ } }
      if (name.endsWith('/referral')) return {
        setMyReferralCode() { calls.referral++ },
        bindPendingReferral: () => bind ? bind() : Promise.resolve()
      }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  const page = { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) } }
  return { page, calls, storage, navigate: navModule.exports.returnToPublicPage }
}

test('unchecked guest entry immediately browses without login, profile lookup or agreement', () => {
  const h = harness({ storage: {
    openid: 'old-test-user', isGuest: false, postLoginAction: { type: 'joinCarpool' },
    pendingPage: { url: HOME }, needLoginToast: '请登录'
  } })
  h.page.onGuestTap()
  assert.equal(h.page.data.privacyAgreed, false)
  assert.equal(h.storage.isGuest, true)
  assert.equal(h.storage.openid, '')
  for (const key of ['pendingPage', 'postLoginAction', 'needLoginToast']) assert.equal(h.storage[key], undefined)
  assert.equal(h.calls.identity, 1)
  assert.deepEqual(h.calls.cloud, [])
  assert.deepEqual(h.calls.toasts, [])
  assert.equal(h.calls.navigation[0].kind, 'switchTab')
  assert.equal(h.calls.navigation[0].url, HOME)
  h.page.onGuestTap()
  assert.equal(h.calls.navigation.length, 1)
})

test('guest returns to the public detail without resuming the abandoned booking', () => {
  const h = harness({ pages: [{ route: 'pages/home/tripDetail/tripDetail' }, { route: LOGIN }], storage: {
    pendingPage: { url: '/pages/home/tripDetail/tripDetail?id=test-trip' }, postLoginAction: { type: 'joinCarpool' }
  } })
  h.page.onGuestTap()
  assert.equal(h.calls.navigation[0].kind, 'navigateBack')
  assert.equal(h.calls.navigation[0].delta, 1)
  assert.equal(h.storage.postLoginAction, undefined)
  assert.deepEqual(h.calls.cloud, [])
})

test('root and private-source cancellation cannot reenter login or an account page', () => {
  for (const url of ['/pages/other/login/login', '/pages/profile/addInfo/addInfo', '/pages/home/newTrip/newTrip',
    'https://example.com', '//pages/home/home', '/pages/home/home#login', '/pages/home/home\n']) {
    const h = harness({ pages: [{ route: 'pages/home/newTrip/newTrip' }, { route: LOGIN }] })
    h.navigate(url)
    assert.equal(h.calls.navigation[0].kind, 'switchTab', url)
    assert.equal(h.calls.navigation[0].url, HOME, url)
  }
})

test('public pending links preserve their query; tab destinations use switchTab', () => {
  const detail = '/pages/home/requestDetail/requestDetail?id=test-request&city=ny_nj'
  const h = harness()
  h.navigate(detail)
  assert.equal(h.calls.navigation[0].kind, 'redirectTo')
  assert.equal(h.calls.navigation[0].url, detail)
  const tab = harness()
  tab.navigate('/pages/market/market?type=goods')
  assert.equal(tab.calls.navigation[0].kind, 'switchTab')
  assert.equal(tab.calls.navigation[0].url, '/pages/market/market')
})

test('failed back/redirect navigation still has a working home escape', () => {
  const h = harness({ pages: [{ route: 'pages/home/tripDetail/tripDetail' }, { route: LOGIN }],
    fail: ['navigateBack', 'redirectTo', 'switchTab'] })
  h.navigate('/pages/home/tripDetail/tripDetail?id=test-trip')
  assert.deepEqual(h.calls.navigation.map(x => x.kind), ['navigateBack', 'redirectTo', 'switchTab', 'reLaunch'])
  assert.equal(h.calls.navigation[3].url, HOME)
})

test('guest cancellation wins over a late successful login response', async () => {
  const login = deferred()
  const h = harness({ call: () => login.promise })
  h.page.setData({ privacyAgreed: true })
  const pending = h.page.onLoginTap()
  assert.equal(h.page.data.logging, true)
  h.page.onGuestTap()
  login.resolve({ result: { ok: true, openid: 'late-test-user', referralCode: 'test-code' } })
  await pending
  assert.equal(h.storage.openid, '')
  assert.equal(h.storage.isGuest, true)
  assert.equal(h.calls.referral, 0)
  assert.equal(h.calls.navigation.length, 1)
  assert.deepEqual(h.calls.cloud, ['login'])
})

test('guest cancellation also wins while referral or profile completion is pending', async () => {
  for (const stage of ['referral', 'profile']) {
    const delayed = deferred(), started = deferred()
    const h = harness({
      bind: () => { if (stage === 'referral') { started.resolve(); return delayed.promise } },
      call: options => {
        if (options.name === 'login') return Promise.resolve({ result: { ok: true, openid: 'test-user' } })
        started.resolve(); return delayed.promise
      }
    })
    h.page.setData({ privacyAgreed: true })
    const pending = h.page.onLoginTap()
    await started.promise
    h.page.onGuestTap()
    delayed.resolve({ result: { data: [{ profileCompleted: false }] } })
    await pending
    assert.equal(h.storage.openid, '', stage)
    assert.equal(h.storage.isGuest, true, stage)
    assert.equal(h.calls.navigation.length, 1, stage)
    assert.equal(h.calls.navigation[0].url, HOME, stage)
  }
})

test('leaving the login page ignores late failures without showing another prompt', async () => {
  const login = deferred(), h = harness({ call: () => login.promise })
  h.page.setData({ privacyAgreed: true })
  const pending = h.page.onLoginTap()
  h.page.onUnload()
  login.reject(new Error('late network failure'))
  await pending
  assert.deepEqual(h.calls.toasts, [])
  assert.deepEqual(h.calls.navigation, [])
  assert.equal(h.storage.openid, undefined)
})

test('intentional login still requires agreement and retains the normal signed-in path', async () => {
  const h = harness()
  await h.page.onLoginTap()
  assert.equal(h.calls.toasts.length, 1)
  assert.deepEqual(h.calls.cloud, [])
  h.page.setData({ privacyAgreed: true })
  await h.page.onLoginTap()
  assert.equal(h.storage.openid, 'test-login-user')
  assert.equal(h.storage.isGuest, false)
  assert.deepEqual(h.calls.cloud, ['login', 'getUserInfo'])
  assert.equal(h.calls.navigation[0].url, HOME)
  assert.equal(h.page.data.logging, false)
})

test('the visible guest control is independent of agreement and login loading state', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/other/login/login.wxml'), 'utf8')
  const guest = wxml.match(/<button\b[^>]*bindtap="onGuestTap"[^>]*>[\s\S]*?<\/button>/)[0]
  assert.match(guest, /暂不登录，先浏览/)
  assert.doesNotMatch(guest, /disabled|privacyAgreed|logging/)
})
