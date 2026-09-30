const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRideTemplateClient, toTemplateInput, toLegacyTemplate } = require('../utils/compat/rideTemplates')
const account = 'synthetic-template-owner'
const id = '00000000-0000-4000-8000-000000000001'
const idAt = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const form = (extra = {}) => ({ templateName: '周二 Fort Lee→哥大', weekdayIndex: 1, weekdayText: '周二', departureTime: '15:00',
  departureAddress: 'Fort Lee', destinationAddress: '哥大', passengerCount: 3, referencePrice: '11-13$', comment: '备注', ...extra })
const row = (extra = {}) => ({ id, ...toTemplateInput(form()), createdAt: '2026-09-20T12:00:00Z', updatedAt: null, ...extra })
const plain = value => JSON.parse(JSON.stringify(value))
const delay = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function clientHarness(server = true) {
  const state = { account, requests: [], writes: [], cloud: 0, get: async () => ({ items: [row()], page: 1, limit: 100, hasMore: false }) }
  const wx = { getStorageSync: key => key === 'openid' ? state.account : false, cloud: { database() { state.cloud++; throw Error('CloudBase must not be used') } } }
  const backend = { isBackendEnabled: () => server, retryCloudPending: async () => null, get: async route => { state.requests.push(route); return state.get(route) },
    mutate: async (...args) => { state.writes.push(args); return row() }, retryPending: async () => row() }
  return { state, wx, backend, api: createRideTemplateClient({ wx, backend }) }
}

test('retired authority cannot start template reads, writes or pending recovery through any old transport', async () => {
  const h = clientHarness(false)
  h.backend.cloudRead = h.backend.cloudMutate = h.backend.retryCloudPending = () => assert.fail('retired source must not be called')
  for (const action of [() => h.api.loadRideTemplates(), () => h.api.getRideTemplate(id), () => h.api.saveRideTemplate(form()),
    () => h.api.deleteRideTemplate(id), () => h.api.recoverRideTemplate(id)]) {
    await assert.rejects(action(), { code: 'BACKEND_DISABLED' })
  }
  assert.deepEqual(h.state.requests, []); assert.deepEqual(h.state.writes, []); assert.equal(h.state.cloud, 0)
})

test('template reads use real owner endpoint pagination; malformed pages, foreign IDs and changed accounts fail closed', async () => {
  const h = clientHarness()
  h.state.get = async route => route.includes('page=1&') ? { items: Array.from({ length: 100 }, (_, i) => row({ id: idAt(i + 1) })), page: 1, limit: 100, hasMore: true }
    : { items: [row({ id: idAt(101) })], page: 2, limit: 100, hasMore: false }
  assert.equal((await h.api.loadRideTemplates()).length, 101)
  assert.deepEqual(h.state.requests, ['/api/v1/templates?page=1&limit=100', '/api/v1/templates?page=2&limit=100'])
  await assert.rejects(h.api.getRideTemplate(idAt(102)), { code: 'TEMPLATE_NOT_FOUND' })
  for (const value of [{ items: [], page: 1, limit: 100, hasMore: true }, { items: [row(), row()], page: 1, limit: 100, hasMore: false },
    { items: [row({ timeZone: 'Asia/Shanghai' })], page: 1, limit: 100, hasMore: false }]) {
    h.state.get = async () => value
    await assert.rejects(h.api.loadRideTemplates(), { code: 'INVALID_TEMPLATE' })
  }
  const pending = delay(); h.state.get = () => pending.promise
  const read = h.api.loadRideTemplates(); h.state.account = 'different-account'
  pending.resolve({ items: [row()], page: 1, limit: 100, hasMore: false })
  await assert.rejects(read, { code: 'REQUEST_CANCELLED' })
  assert.equal(h.state.cloud, 0)
})

test('template edits validate identity before write and send only canonical changed fields; server errors never fall back', async () => {
  const h = clientHarness(), previous = toLegacyTemplate(row(), account)
  await h.api.saveRideTemplate({ ...previous, departureTime: '16:00' }, { id, previous })
  assert.deepEqual(h.state.writes[0].slice(0, 3), [`templates.update:${id}`, 'PATCH', `/api/v1/templates/${id}`])
  assert.deepEqual(h.state.writes[0][3], { localTime: '16:00' })
  await assert.rejects(h.api.saveRideTemplate(previous, { id, previous: { ...previous, _ownerAccount: 'foreign' } }), { code: 'INVALID_TEMPLATE' })
  assert.equal(h.state.writes.length, 1)
  h.backend.get = async () => { throw Error('offline') }
  h.backend.mutate = async () => { throw Error('offline') }
  await assert.rejects(h.api.loadRideTemplates(), /offline/)
  await assert.rejects(h.api.saveRideTemplate(form()), /offline/)
  await assert.rejects(h.api.deleteRideTemplate(id), /offline/)
  assert.equal(h.state.cloud, 0)
})

function pageHarness(which) {
  const h = clientHarness(), toasts = [], profileWrites = [], errors = [], saved = []
  const state = { ...h.state, account, profile: { _openid: account, wechatID: 'synthetic-contact', carNumber: 'PLATE', carBrand: 'Brand',
    carModel: 'Model', defaultShowZelle: true, pickupSpot: ['Fort Lee'], dropoffSpot: ['哥大'] }, saveError: null }
  h.wx.getStorageSync = key => key === 'openid' ? state.account : false
  Object.assign(h.wx, { showToast: value => toasts.push(value.title), getWindowInfo: () => ({ statusBarHeight: 20 }),
    showModal: options => { options.success?.({ confirm: true }); return Promise.resolve({ confirm: true }) }, navigateBack() {} })
  const profile = { isBackendEnabled: () => true, legacyDocument: value => value.result.data[0],
    getUserInfo: async () => ({ result: { data: [plain(state.profile)] } }),
    updateUser: async patch => { profileWrites.push(plain(patch)); Object.assign(state.profile, plain(patch)); return { result: { ok: true, data: state.profile } } } }
  profile.updateSpot = async (field, value, remove = false) => {
    const values = remove ? state.profile[field].filter(item => item !== value) : [...new Set([...state.profile[field], value])]
    await profile.updateUser({ [field]: values }); return { field, values }
  }
  const api = { loadRideTemplates: async () => [toLegacyTemplate(row(), state.account)], getRideTemplate: async () => toLegacyTemplate(row(), state.account),
    saveRideTemplate: async (value, options) => { saved.push({ value: plain(value), options }); if (state.saveError) throw state.saveError
      return toLegacyTemplate(row({ ...toTemplateInput(value, options?.previous?.backendTemplate) }), state.account) },
    recoverRideTemplate: async () => toLegacyTemplate(row(), state.account), deleteRideTemplate: async () => {} }
  const filename = path.resolve(__dirname, `../pages/home/${which}/${which}.js`)
  let definition
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page: value => { definition = value }, wx: h.wx,
    console: { error() {} }, setTimeout() {}, getCurrentPages: () => [{}], require(name) {
      if (name.endsWith('/compat/rideTemplates')) return api
      if (name.endsWith('/compat/profile')) return profile
      if (name.endsWith('/userProfileUpdate')) return { callUpdateUser: profile.updateUser }
      if (name.endsWith('/error')) return { showDataError: (...args) => errors.push(args) }
      return require(path.resolve(path.dirname(filename), name))
    } }, { filename })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch, cb) { Object.assign(this.data, patch); cb?.call(this) }
  return { page, api, profile, state, toasts, profileWrites, saved, errors }
}

test('actual template list uses backend rows and profile preferences without any direct CloudBase interaction', async () => {
  const h = pageHarness('CarpoolTemplateList')
  await h.page.loadTemplateList()
  assert.equal(h.page.data.templateList[0]._timeLabel, '每周二 15:00')
  await h.page.loadUserSpots()
  assert.deepEqual(plain(h.page.data.pickupSpotList), ['Fort Lee'])
  await h.page.appendSpotToUserInfo('pickupSpot', 'JFK')
  await h.page.appendSpotToUserInfo('pickupSpot', 'JFK')
  assert.deepEqual(h.profileWrites.at(-1), { pickupSpot: ['Fort Lee', 'JFK'] })
  await h.page.removeSpotFromUserInfo('pickupSpot', 'Fort Lee')
  assert.deepEqual(h.profileWrites.at(-1), { pickupSpot: ['JFK'] })
  const before = h.profileWrites.length
  await h.page.appendSpotToUserInfo('privateField', 'bad')
  assert.equal(h.profileWrites.length, before)
  assert.equal(h.state.cloud, 0)
})

test('actual template list discards late old-account reads and preserves address input after a failed save', async () => {
  const h = pageHarness('CarpoolTemplateList'), pending = delay()
  h.api.loadRideTemplates = () => pending.promise
  const loading = h.page.loadTemplateList()
  h.state.account = 'another-account'
  pending.resolve([toLegacyTemplate(row(), account)]); await loading
  assert.deepEqual(plain(h.page.data.templateList), [])
  h.profile.updateUser = async () => { throw Error('offline') }
  Object.assign(h.page.data, { pickupEditing: true, pickupInput: 'JFK' })
  await h.page.onPickupBtnTap()
  assert.equal(h.page.data.pickupInput, 'JFK'); assert.equal(h.page.data.pickupEditing, true)
})

test('actual template editor stores profile-only vehicle/payment preferences and keeps the exact saved price', async () => {
  const h = pageHarness('driverCarpoolTemplate')
  await h.page.loadUserInfo(); await h.page.loadTemplateDetail(id)
  assert.equal(h.page.data.referencePrice, '11-13$'); assert.equal(h.page.data.showZelle, true)
  Object.assign(h.page.data, { editMode: true, templateId: id, passengerCount: 8 })
  await h.page.submitTemplate('每周二')
  assert.equal(h.saved[0].value.passengerCount, 8)
  assert.equal(h.profileWrites[0].defaultShowZelle, true)
  assert.equal(h.profileWrites[0].carNumber, 'PLATE')
  assert.equal(h.page._loadedTemplate.backendTemplate.definition.listedPriceCents, null)
  assert.equal('carNumber' in h.page._loadedTemplate.backendTemplate.definition, false)
  assert.equal(h.page.data.editMode, true)
  assert.ok(h.toasts.includes('模板保存成功'))
})

test('lost creation ACK recovery binds the original template without erasing edits or automatically creating a second template', async () => {
  const h = pageHarness('driverCarpoolTemplate')
  await h.page.loadUserInfo()
  Object.assign(h.page.data, form({ departureTime: '17:00', comment: 'New input after restarting' }))
  h.state.saveError = Object.assign(Error('uncertain'), { code: 'PENDING_OPERATION' })
  await h.page.submitTemplate('New template name')
  assert.equal(h.page.data.templateId, id); assert.equal(h.page.data.editMode, true)
  assert.equal(h.page.data.departureTime, '17:00'); assert.equal(h.page.data.comment, 'New input after restarting')
  assert.equal(h.saved.length, 1); assert.equal(h.profileWrites.length, 0)
  assert.ok(h.toasts.includes('已找回上次模板，请再保存当前内容'))
  h.state.saveError = null
  await h.page.submitTemplate('New template name')
  assert.equal(h.saved[1].options.id, id)
  assert.equal(h.saved[1].options.previous.backendTemplate.localTime, '15:00')
  assert.equal(h.page._loadedTemplate.backendTemplate.localTime, '17:00')
})

test('failed recovery retains the form; late recovery after account change cannot bind the old template', async () => {
  const h = pageHarness('driverCarpoolTemplate')
  await h.page.loadUserInfo(); Object.assign(h.page.data, form())
  h.state.saveError = Object.assign(Error('uncertain'), { code: 'PENDING_OPERATION' })
  h.api.recoverRideTemplate = async () => { throw Error('offline') }
  await h.page.submitTemplate('Template')
  assert.equal(h.page.data.editMode, false); assert.equal(h.page.data.referencePrice, '11-13$')
  assert.ok(h.toasts.includes('上次保存结果待确认，请稍后重试'))
  const pending = delay(); h.api.recoverRideTemplate = () => pending.promise
  const saving = h.page.submitTemplate('Template')
  await new Promise(resolve => setImmediate(resolve))
  h.state.account = 'another-account'; pending.resolve(toLegacyTemplate(row(), account)); await saving
  assert.equal(h.page.data.editMode, false); assert.equal(h.page._loadedTemplate, undefined)
})

test('profile refresh preserves in-progress vehicle edits and account changes clear the previous form', async () => {
  const h = pageHarness('driverCarpoolTemplate')
  h.page._editorAccount = account
  await h.page.loadUserInfo(); await h.page.loadTemplateDetail(id)
  h.page.onCarNumberInput({ detail: { value: 'EDITED' } })
  h.page.onZelleCheckboxChange({ detail: { value: [] } })
  await h.page.loadUserInfo()
  assert.equal(h.page.data.carNumber, 'EDITED'); assert.equal(h.page.data.showZelle, false)
  h.state.account = 'another-account'
  h.page.onShow()
  assert.equal(h.page.data.referencePrice, ''); assert.equal(h.page.data.carNumber, '')
  assert.equal(h.page._loadedTemplate, null)
})

test('a cutover recovery binds the canonical template and keeps current edits until a second explicit save', async () => {
  const h = pageHarness('driverCarpoolTemplate')
  await h.page.loadUserInfo()
  h.page.setData({ ...form({ departureTime: '17:00' }), templateName: 'Edited title', carNumber: 'UNCHANGED-DRAFT' })
  h.api.saveRideTemplate = async () => ({ ...toLegacyTemplate(row(), account), recovered: true })
  await h.page.submitTemplate('Edited title')
  assert.equal(h.page.data.editMode, true)
  assert.equal(h.page.data.templateId, id)
  assert.equal(h.page.data.departureTime, '17:00')
  assert.equal(h.page.data.carNumber, 'UNCHANGED-DRAFT')
  assert.equal(h.page._loadedTemplate.backendTemplate.localTime, '15:00')
  assert.equal(h.profileWrites.length, 0)
})
