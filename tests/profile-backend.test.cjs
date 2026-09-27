const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const loadApi = require('./helpers/profile-api.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const idA = '00000000-0000-4000-8000-000000000001'
const idB = '00000000-0000-4000-8000-000000000002'
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness(pageName, overrides = {}) {
  const storage = { openid: 'synthetic-user', isGuest: false }
  const state = { cloud: [], gets: [], mutations: [], uploads: [], toasts: [], navigation: [], sets: [], timers: new Map() }
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    showToast: value => state.toasts.push(value.title), navigateBack: () => state.navigation.push('back'),
    redirectTo: value => state.navigation.push(value.url), reLaunch: value => state.navigation.push(value.url),
    cloud: { callFunction: options => { state.cloud.push(options); throw new Error('CloudBase must not be called') },
      uploadFile: options => { state.cloud.push(options); throw new Error('CloudBase must not be called') } }
  }
  const user = { id: idA, openid: 'synthetic-user', name: 'Person', avatarFileId: null,
    profile: { wechatId: 'contact', phoneRegion: 'US', profileCompleted: true,
      region: { state: 'NJ', county: 'Fort Lee', area: 'Core' }, location: { residence: 'Building' } } }
  const backend = {
    isBackendEnabled: () => true,
    get: async url => { state.gets.push(url); return user },
    mutate: async (...args) => { state.mutations.push(plain(args)); return user },
    uploadImage: async (...args) => { state.uploads.push(args); return { fileId: idB } },
    resolveImages: async ids => ids.map(fileId => ({ fileId, url: `https://signed.invalid/${fileId}?temporary=1` })),
    logout() {}, ...overrides
  }
  const api = loadApi(wx, backend), display = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/profileDisplay.js'), 'utf8'), {
    module: display, require(name) {
      if (name === './backendClient') return backend
      if (name === './regionTree') return { normalizeUserRegion: () => ({}) }
      throw new Error(name)
    }
  })
  let definition
  const context = {
    wx, console: { error() {} }, getCurrentPages: () => [], Page: value => { definition = value },
    setTimeout: callback => { const id = state.timers.size + 1; state.timers.set(id, callback); return id },
    clearTimeout: id => state.timers.delete(id),
    require(name) {
      if (name.endsWith('/compat/profile')) return api
      if (name.endsWith('/profileDisplay')) return display.exports
      if (name.endsWith('/userProfileUpdate')) return { callUpdateUser: api.updateUser }
      if (name.endsWith('/error')) return { showDataError: title => state.toasts.push(title) }
      if (name.endsWith('/loginNavigation')) return { returnToPublicPage: url => state.navigation.push(url) }
      if (name.endsWith('/analyticsSession')) return { identityChanged() {} }
      if (name.endsWith('/referral')) return { bindPendingReferral: async () => {}, setMyReferralCode() {} }
      if (name.endsWith('/tripManage')) return { formatRideStats: () => ({ ratingCount: 0 }) }
      if (name.endsWith('/Region')) return { DEFAULT_REGION_TREE: [], normalizeRegionTree: x => x,
        getCityOptions: () => [], getCitySnapshot: () => ({ label: 'NJ' }), findState: () => null,
        readCachedRegionTree: () => null, loadRegionTreeConfig: async () => ({ tree: [], fromCloud: false }) }
      throw new Error(name)
    }
  }
  if (pageName) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../', pageName), 'utf8'), context)
  const page = definition && { ...definition, data: plain(definition.data) }
  if (page) page.setData = function(patch, callback) { state.sets.push(patch); Object.assign(this.data, patch); if (callback) callback.call(this) }
  return { api, backend, display: display.exports, page, state, storage, user }
}
const add = 'pages/profile/addInfo/addInfo.js', edit = 'pages/profile/editInfo/editInfo.js'

test('profile aliases map to the actual canonical schema without persistent URLs or retired price overrides', async () => {
  const { api } = harness()
  const { updateUserSchema } = await import('../services/backend/src/users/service.ts')
  const patch = plain(api.toBackendPatch({ name: ' Person ', avatarFileId: idA, avatarUrl: 'https://signed.invalid/transient',
    wechatID: 'contact', regionPhone: 'US', phone: '', bio: 'bio', carNumber: 'ABC', carBrand: '', carModel: 'X',
    zelleName: 'Payee', zelleAccount: '', defaultShowZelle: false,
    regionState: 'NJ', regionCounty: 'Fort Lee', regionArea: 'Core', regionDisplay: 'NJ / Fort Lee / Core',
    Apartment: 'Building', location: { displayName: 'Point', address: 'Street', lat: 40, lng: -74 },
    pickupSpot: ['A'], dropoffSpot: [], commonComments: [], customPrice: { fortLeeCore: '100', fortLeeNonCore: '12' } }))
  assert.deepEqual(updateUserSchema.parse(patch), patch)
  assert.equal(patch.profile.profileCompleted, true)
  assert.equal(patch.profile.location.latitude, 40)
  assert.deepEqual(patch.profile.preferences.routePrices, { fortLeeNonCore: '12' })
  assert.equal(JSON.stringify(patch).includes('signed.invalid'), false)
  assert.deepEqual(plain(api.toBackendPatch({ avatarFileId: null })), { avatarFileId: null })
  assert.deepEqual(plain(api.toBackendPatch({ name: '', bio: 'Only bio', location: { lat: null, lng: null } })), { profile: { bio: 'Only bio' } })
  assert.deepEqual(plain(api.toBackendPatch({ carBrand: 'New' })), { profile: { vehicle: { brand: 'New' } } })
})

test('canonical profile reads preserve phone, driver defaults and region without fake coordinates', () => {
  const { api } = harness()
  const dto = api.fromBackendUser({ id: idA, openid: 'synthetic-user', avatarFileId: idB,
    profile: { phoneRegion: 'CN', phone: '123', wechatId: 'contact', profileCompleted: true,
      vehicle: { plate: 'ABC' }, zelle: { public: true, account: 'payee' },
      region: { state: 'NJ', county: 'Fort Lee', area: 'Core' }, location: { residence: 'Building' },
      preferences: { pickupAddresses: [], routePrices: { fortLeeNonCore: '12' } } } })
  assert.equal(dto.avatarFileId, idB)
  assert.equal('avatarUrl' in dto, false)
  assert.equal(dto.defaultShowZelle, true)
  assert.equal(dto.carNumber, 'ABC')
  assert.equal(dto.regionPhone, 'CN')
  assert.equal(dto.Apartment, 'Building')
  assert.equal('lat' in dto.location, false)
})

test('HTTP write and upload failures never fall back to CloudBase', async () => {
  const h = harness(null, { mutate: async () => { throw new Error('network timeout') }, uploadImage: async () => { throw new Error('network timeout') } })
  await assert.rejects(h.api.updateUser({ bio: 'edited' }), /network timeout/)
  await assert.rejects(h.api.uploadAvatar('/tmp/local.png'), /network timeout/)
  assert.deepEqual(h.state.cloud, [])
})

test('profile summary maps statistics and every block page; image cache stores IDs only', async () => {
  const h = harness()
  h.backend.get = async url => {
    h.state.gets.push(url)
    if (url === '/api/v1/me') return h.user
    if (url === '/api/v1/me/statistics') return { all: { completedTrips: 5 }, driver: { completedTrips: 2, ratingCount: 1, averageRating: 5, weightedRating: 4.8 }, passenger: { completedTrips: 3 } }
    if (url === '/api/v1/notifications/unread') return { unreadCount: 7 }
    return url.includes('page=1') ? { blocks: [{ targetUserId: idA }], nextPage: 2 } : { blocks: [{ targetUserId: idB }], nextPage: null }
  }
  const dto = h.api.legacyDocument(await h.api.getUserInfo({ summary: true }))
  assert.equal(dto.rideStats.completedDriverTrips, 2)
  assert.equal(dto.rideStats.driverRatingWeightedAvg, 4.8)
  assert.deepEqual(plain(dto.blockedUsers), [idA, idB])
  assert.equal(await h.api.getUnreadCount('synthetic-user'), 7)
  h.api.cacheUser({ ...dto, avatarFileId: idA, avatarUrl: 'https://signed.invalid' })
  assert.equal('avatarUrl' in h.storage.userInfo, false)
  assert.equal(h.storage.userInfo.avatarFileId, idA)
})

for (const file of [add, edit]) {
  test(`${file}: a slow first avatar cannot replace the second selection or persist a display URL`, async () => {
    const first = deferred(), second = deferred()
    const h = harness(file, { uploadImage: file => file === '/tmp/a.png' ? first.promise : second.promise })
    h.page.data.wechat = 'contact'
    const pendingA = h.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/a.png' } })
    const pendingB = h.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/b.png' } })
    second.resolve({ fileId: idB }); await pendingB
    first.resolve({ fileId: idA }); await pendingA
    assert.equal(h.page.data.avatarFileId, idB)
    assert.equal(h.page.data.avatarUrl, '/tmp/b.png')
    if (file === add) assert.equal(await h.page.saveToCloud(), true)
    assert.equal(h.state.mutations.length, 1)
    const [scope, method, route, body] = h.state.mutations[0]
    assert.deepEqual([scope, method, route], ['profile.update', 'PATCH', '/api/v1/me'])
    assert.equal(body.avatarFileId, idB)
    assert.equal(JSON.stringify(body).includes('/tmp/'), false)
    assert.equal(body.profile.profileCompleted, true)
    assert.deepEqual(h.state.cloud, [])
  })
  test(`${file}: an unloaded page cannot apply or save a late image upload`, async () => {
    const upload = deferred(), h = harness(file, { uploadImage: () => upload.promise })
    const pending = h.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/a.png' } })
    h.page.onUnload()
    const sets = h.state.sets.length
    upload.resolve({ fileId: idA }); await pending
    assert.equal(h.state.sets.length, sets)
    assert.equal(h.state.mutations.length, 0)
    assert.deepEqual(h.state.toasts, [])
  })
  test(`${file}: a late profile/image read cannot overwrite newly typed contact`, async () => {
    const resolution = deferred(), h = harness(file, { resolveImages: () => resolution.promise })
    h.user.avatarFileId = idA
    const pending = h.page.loadUserInfo()
    await tick()
    h.page.onInput({ currentTarget: { dataset: { field: 'wechat' } }, detail: { value: 'typed-contact' } })
    resolution.resolve([{ fileId: idA, url: 'https://signed.invalid/avatar' }]); await pending
    assert.equal(h.page.data.wechat, 'typed-contact')
  })
}

test('editing a migrated region preserves its state, area and residence during unrelated saves', async () => {
  const h = harness(edit)
  await h.page.loadUserInfo()
  h.page.onInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: 'New name' } })
  assert.equal(await h.page.saveToCloud(), true)
  const patch = h.state.mutations[0][3]
  assert.deepEqual(patch.profile.region, { state: 'NJ', county: 'Fort Lee', area: 'Core', label: 'NJ / Fort Lee / Core' })
  assert.equal(patch.profile.location.residence, 'Building')
  assert.equal(patch.avatarFileId, null)
})

test('server login forwards the current-attempt guard and guest cancellation clears the session immediately', async () => {
  const login = deferred(); let guard, logout = 0
  const h = harness('pages/other/login/login.js', {
    login: options => { guard = options.isCurrent; return login.promise }, logout: () => { logout++ }
  })
  h.page.data.privacyAgreed = true
  const pending = h.page.onLoginTap()
  assert.equal(guard(), true)
  h.page.onGuestTap()
  assert.equal(guard(), false)
  assert.equal(logout, 1)
  login.resolve({ user: { openid: 'late-user' } }); await pending
  assert.equal(h.storage.openid, '')
  assert.equal(h.storage.isGuest, true)
  assert.deepEqual(h.state.cloud, [])
  assert.equal(h.state.navigation.length, 1)
})

for (const file of [add, edit]) {
  test(`${file}: switching accounts prevents late uploads and saves of the previous account's form`, async () => {
    const upload = deferred(), h = harness(file, { uploadImage: () => upload.promise })
    await h.page.loadUserInfo()
    const pending = h.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/a.png' } })
    h.storage.openid = 'other-user'
    const sets = h.state.sets.length
    upload.resolve({ fileId: idA }); await pending
    assert.equal(h.state.sets.length, sets)
    assert.equal(await h.page.saveToCloud(), false)
    assert.equal(h.state.mutations.length, 0)
  })
}

test('a failed current avatar upload keeps the previous reference and stays retryable', async () => {
  const h = harness(edit, { uploadImage: async () => { throw new Error('offline') } })
  await h.page.loadUserInfo()
  const previous = h.page.data.avatarUrl
  await h.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/a.png' } })
  assert.equal(h.page.data.avatarUrl, previous)
  assert.equal(h.page.data.avatarFileId, null)
  assert.equal(h.page._avatarUploading, false)
  assert.equal(h.state.mutations.length, 0)
  assert.deepEqual(h.state.toasts, ['头像上传失败，请重试'])
})

test('the actual backend client carries profile login, raw image upload and UUID update through one session', async () => {
  const { createBackendClient, SESSION_KEY } = require('../utils/backendClient')
  const { updateUserSchema } = await import('../services/backend/src/users/service.ts')
  const storage = {}, requests = [], cloudCalls = []
  const openid = 'synthetic_profile_sdk_identity'
  let canonical = { id: idA, openid, name: 'Person', avatarFileId: null, profile: { wechatId: 'contact' } }
  const session = { token: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    user: { id: idA, openid, referralCode: 'ref_123456789abc' } }
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    cloud: { callFunction: async options => { cloudCalls.push(options.name); return { result: { ok: true, data: session } } } },
    getFileSystemManager: () => ({ readFile: options => options.success({ data: bytes }) }),
    request(options) {
      requests.push(options)
      assert.equal(options.header.Authorization, `Bearer ${session.token}`)
      const route = options.url.replace('https://collect.linkx.ink', '')
      let data
      if (route === '/api/v1/me' && options.method === 'GET') data = canonical
      else if (route === '/api/v1/files/images') {
        assert.equal(options.data, bytes)
        assert.equal(options.header['content-type'], 'application/octet-stream')
        data = { fileId: idB }
      } else if (route === '/api/v1/me' && options.method === 'PATCH') {
        const patch = updateUserSchema.parse(options.data)
        canonical = { ...canonical, ...patch, profile: { ...canonical.profile, ...patch.profile } }
        data = canonical
      } else if (route === '/api/v1/files/urls') data = { expiresIn: 120, items: [{ fileId: idB, url: 'https://signed.invalid/image?temporary=1' }] }
      else if (route === '/api/v1/auth/logout') data = {}
      else throw new Error(`Unexpected route ${route}`)
      options.success({ statusCode: 200, data: { ok: true, data } })
      return { abort() {} }
    }
  }
  const backend = createBackendClient({ wx, config: { mode: 'server' } })
  const api = loadApi(wx, backend)
  const login = await api.login({ isCurrent: () => true })
  assert.equal(login.result.openid, openid)
  storage.openid = openid; storage.isGuest = false
  assert.equal(api.legacyDocument(await api.getUserInfo()).wechatID, 'contact')
  const avatar = await api.uploadAvatar('/tmp/synthetic.png')
  await api.updateUser({ ...avatar, wechatID: 'updated-contact' })
  assert.equal(canonical.avatarFileId, idB)
  assert.equal(canonical.profile.wechatId, 'updated-contact')
  assert.equal(JSON.stringify(canonical).includes('/tmp/'), false)
  assert.equal((await backend.resolveImages([idB]))[0].fileId, idB)
  assert.deepEqual(cloudCalls, ['backend'])
  assert.ok(requests.filter(r => r.url.endsWith('/images') || r.method === 'PATCH').every(r => r.header['Idempotency-Key']))
  const logout = api.logout()
  assert.equal(storage[SESSION_KEY], undefined)
  await logout
})

test('an explicit edited save reconciles the old uncertain operation before the new payload, without displaying its reply', async () => {
  const calls = [], h = harness(null, {
    mutate: async (...args) => {
      calls.push(['mutate', plain(args)])
      if (calls.length === 1) throw Object.assign(new Error('pending'), { code: 'PENDING_OPERATION' })
      return { id: idA, openid: 'synthetic-user', profile: { bio: 'new' } }
    },
    retryPending: async scope => { calls.push(['retry', scope]); return { profile: { bio: 'old' } } }
  })
  const result = await h.api.updateUser({ bio: 'new' })
  assert.equal(result.result.data.bio, 'new')
  assert.deepEqual(calls.map(x => x[0]), ['mutate', 'retry', 'mutate'])
  assert.equal(calls[1][1], 'profile.update')
  assert.deepEqual(calls[0][1], calls[2][1])
  for (const code of ['NETWORK_ERROR', 'UNAUTHORIZED', 'FORBIDDEN']) {
    let writes = 0
    const failed = harness(null, { mutate: async () => { writes++; throw Object.assign(new Error('pending'), { code: 'PENDING_OPERATION' }) },
      retryPending: async () => { throw Object.assign(new Error('not reconciled'), { code }) } })
    await assert.rejects(failed.api.updateUser({ bio: 'new' }), { code })
    assert.equal(writes, 1)
    assert.deepEqual(failed.state.cloud, [])
  }
})

test('real SDK lost ACK then process restart reconciles the original profile key before saving changed fields', async () => {
  const { createBackendClient, SESSION_KEY, PENDING_KEY } = require('../utils/backendClient')
  for (const recovery of ['success', 'offline', '401', '403']) {
    const openid = 'synthetic_profile_recovery_identity'
    const session = { token: 'b'.repeat(43), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: { id: idA, openid, referralCode: 'ref_123456789abc' } }
    const storage = { openid, isGuest: false, [SESSION_KEY]: session }, requests = [], receipts = new Map()
    let canonical = { id: idA, openid, name: 'Person', avatarFileId: null, profile: {} }, phase = 'lost', changes = 0
    const wx = {
      getStorageSync: key => storage[key] && plain(storage[key]),
      setStorageSync: (key, value) => { storage[key] = plain(value) }, removeStorageSync: key => { delete storage[key] },
      cloud: { callFunction: async () => ({ result: { ok: true, data: session } }) },
      request(options) {
        const key = options.header['Idempotency-Key']; requests.push({ key, body: plain(options.data) })
        if (phase === 'recovery' && recovery !== 'success') {
          if (recovery === 'offline') options.fail({})
          else options.success({ statusCode: Number(recovery), data: { ok: false, error: { code: recovery === '401' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: 'rejected' } } })
          return { abort() {} }
        }
        if (!receipts.has(key)) {
          canonical = { ...canonical, profile: { ...canonical.profile, ...options.data.profile } }
          receipts.set(key, plain(canonical)); changes++
        }
        if (phase === 'lost') options.fail({})
        else options.success({ statusCode: 200, data: { ok: true, data: receipts.get(key) } })
        return { abort() {} }
      }
    }
    const make = () => loadApi(wx, createBackendClient({ wx, config: { mode: 'server' } }))
    await assert.rejects(make().updateUser({ bio: 'old' }), { code: 'NETWORK_ERROR' })
    const oldKey = requests[0].key
    assert.equal(storage[PENDING_KEY][0].key, oldKey)
    phase = 'recovery'
    const restarted = make()
    if (recovery === 'success') {
      const saved = await restarted.updateUser({ bio: 'new' })
      assert.equal(saved.result.data.bio, 'new')
      assert.equal(changes, 2)
      assert.deepEqual(requests.map(r => r.body.profile.bio), ['old', 'old', 'new'])
      assert.equal(requests[1].key, oldKey)
      assert.notEqual(requests[2].key, oldKey)
      assert.equal(storage[PENDING_KEY], undefined)
    } else {
      await assert.rejects(restarted.updateUser({ bio: 'new' }))
      assert.equal(changes, 1)
      assert.ok(requests.every(r => r.key === oldKey))
      assert.equal(storage[PENDING_KEY][0].key, oldKey)
      assert.ok(requests.every(r => r.body.profile.bio === 'old'))
    }
  }
})
