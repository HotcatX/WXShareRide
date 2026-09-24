const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const save = deferred()
  const profile = deferred()
  const storage = {
    openid: 'member-a', isGuest: false,
    pendingPage: { url: '/pages/home/tripDetail/tripDetail?id=route-1' },
    postLoginAction: { type: 'joinCarpool', tripId: 'route-1' },
    needLoginToast: '请先登录'
  }
  const state = { saves: [], publicReturns: [], navigation: [], toasts: [], errors: [], timers: new Map(), timerId: 0, cancelled: new Map(), reads: [] }
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    showToast: value => state.toasts.push(value),
    navigateBack: value => state.navigation.push({ kind: 'back', ...value }),
    redirectTo: value => state.navigation.push({ kind: 'redirect', ...value }),
    reLaunch: value => state.navigation.push({ kind: 'relaunch', ...value }),
    cloud: { callFunction: value => { state.reads.push(value); return profile.promise } }
  }
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/addInfo/addInfo.js'), 'utf8'), {
    Page: value => { definition = value }, wx,
    getCurrentPages: () => [{ route: 'pages/profile/addInfo/addInfo' }],
    setTimeout: callback => { const id = ++state.timerId; state.timers.set(id, callback); return id },
    clearTimeout: id => { state.cancelled.set(id, state.timers.get(id)); state.timers.delete(id) },
    console: { error() {} },
    require(name) {
      if (name.endsWith('/userProfileUpdate')) return { callUpdateUser: data => { state.saves.push(JSON.parse(JSON.stringify(data))); return save.promise } }
      if (name.endsWith('/loginNavigation')) return { returnToPublicPage: url => state.publicReturns.push(url) }
      if (name.endsWith('/error')) return { showDataError: (...args) => state.errors.push(args) }
      throw new Error(`Unexpected module ${name}`)
    }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = patch => { Object.assign(page.data, patch) }
  const runTimers = () => { for (const [id, callback] of state.timers) { state.timers.delete(id); callback() } }
  return { page, state, storage, save, profile, runTimers }
}

test('skipping incomplete onboarding immediately clears action resumption without saving, signing out, or discarding typed fields', () => {
  const h = harness()
  h.page.onInput({ currentTarget: { dataset: { field: 'wechat' } }, detail: { value: 'unsaved-wechat' } })
  h.page.onSkipProfile()
  assert.equal(h.state.saves.length, 0)
  assert.deepEqual(h.state.publicReturns, ['/pages/home/tripDetail/tripDetail?id=route-1'])
  for (const key of ['pendingPage', 'postLoginAction', 'needLoginToast']) assert.equal(h.storage[key], undefined)
  assert.equal(h.storage.openid, 'member-a')
  assert.equal(h.storage.isGuest, false)
  assert.equal(h.page.data.wechat, 'unsaved-wechat')
  assert.equal(h.page.data.unsaved, true)
  h.page.onSkipProfile()
  assert.equal(h.state.publicReturns.length, 1)
})

test('standalone onboarding exit delegates an empty destination to the public home fallback', () => {
  const h = harness()
  delete h.storage.pendingPage
  h.page.onSkipProfile()
  assert.deepEqual(h.state.publicReturns, [''])
  assert.equal(h.state.saves.length, 0)
})

test('onboarding exit rejects non-string destination data before calling navigation', () => {
  const h = harness()
  h.storage.pendingPage = { url: { unexpected: true } }
  h.page.onSkipProfile()
  assert.deepEqual(h.state.publicReturns, [''])
})

test('late successful save after skipping cannot restore the pending join or navigate over the browsing page', async () => {
  const h = harness()
  h.page.setData({ wechat: 'member-wechat', unsaved: true })
  const pending = h.page.onComplete()
  assert.equal(h.state.saves.length, 1)
  h.page.onSkipProfile()
  h.save.resolve({ result: { ok: true } })
  await pending
  h.runTimers()
  assert.equal(h.state.toasts.length, 0)
  assert.equal(h.state.navigation.length, 0)
  assert.equal(h.state.timers.size, 0)
  assert.equal(h.page.data.unsaved, true)
  assert.equal(h.storage.postLoginAction, undefined)
  assert.equal(h.storage.openid, 'member-a')
})

test('late failed save after skipping cannot display a failure over public browsing', async () => {
  for (const reject of [false, true]) {
    const h = harness()
    h.page.setData({ wechat: 'member-wechat' })
    const pending = h.page.onComplete()
    h.page.onSkipProfile()
    if (reject) h.save.reject(new Error('offline'))
    else h.save.resolve({ result: { ok: false, errorMsg: 'offline' } })
    await pending
    assert.equal(h.state.toasts.length, 0)
    assert.equal(h.state.errors.length, 0)
    assert.equal(h.state.navigation.length, 0)
  }
})

test('skip cancels the post-save delay and its stale callback is also unable to navigate', async () => {
  const h = harness()
  h.page.setData({ wechat: 'member-wechat' })
  const pending = h.page.onComplete()
  h.save.resolve({ result: { ok: true } })
  await pending
  assert.equal(h.state.timers.size, 1)
  assert.equal(h.page.data.saving, true)
  h.page.onSkipProfile()
  assert.equal(h.state.timers.size, 0)
  for (const callback of h.state.cancelled.values()) callback()
  assert.equal(h.state.navigation.length, 0)
  assert.equal(h.storage.postLoginAction, undefined)
})

test('leaving the page independently invalidates an in-flight save', async () => {
  const h = harness()
  h.page.setData({ wechat: 'member-wechat' })
  const pending = h.page.onComplete()
  h.page.onUnload()
  h.save.resolve({ result: { ok: true } })
  await pending
  h.runTimers()
  assert.equal(h.state.toasts.length, 0)
  assert.equal(h.state.navigation.length, 0)
})

test('failed current save remains retryable and duplicate clicks do not dispatch parallel saves', async () => {
  const h = harness()
  h.page.setData({ wechat: 'member-wechat' })
  const pending = h.page.onComplete()
  await h.page.onComplete()
  assert.equal(h.state.saves.length, 1)
  h.save.resolve({ result: { ok: false, errorMsg: '保存失败' } })
  await pending
  assert.equal(h.page.data.saving, false)
  assert.equal(h.state.toasts.at(-1).title, '保存失败')
  assert.equal(h.state.timers.size, 0)
})

test('normal completion still requires the existing contact field and saves successfully after validation', async () => {
  const h = harness()
  await h.page.onComplete()
  assert.equal(h.state.toasts.at(-1).title, '请填写微信号')
  assert.equal(h.state.saves.length, 0)
  h.page.setData({ wechat: 'member-wechat', unsaved: true })
  const pending = h.page.onComplete()
  h.save.resolve({ result: { ok: true } })
  await pending
  h.runTimers()
  assert.equal(h.state.saves[0].wechatID, 'member-wechat')
  assert.equal(h.page.data.unsaved, false)
  assert.equal(h.state.navigation.length, 1)
  assert.equal(h.state.navigation[0].url, '/pages/home/tripDetail/tripDetail?id=route-1')
})

test('late initial profile reads do not overwrite user input or mutate an exited page', async () => {
  for (const exit of [false, true]) {
    const h = harness()
    const read = h.page.loadUserInfo()
    h.page.onInput({ currentTarget: { dataset: { field: 'wechat' } }, detail: { value: 'typed-contact' } })
    if (exit) h.page.onSkipProfile()
    h.profile.resolve({ result: { data: [{ wechatID: 'older-contact' }] } })
    await read
    assert.equal(h.page.data.wechat, 'typed-contact')
  }
})
