// Publishing has one durable operation scope, shared by offer/request modes.
// An uncertain previous publish is confirmed under its original key; it never
// becomes a second POST simply because the form or account session restarted.
const backend = require('../backendClient')
const rideTime = require('../rideTime')
const { toTemplateInput, toLegacyTemplate, listedPrice } = require('./rideTemplates')
const { loadLocationConfig } = require('../locationConfig')
const { ridePlaceAliasPattern } = require('../ridePlaceOptions')
const fail = (code, message) => Object.assign(new Error(message), { code })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const invalid = () => fail('INVALID_RIDE', '路线信息无效，请检查地点、时间和价格')
const DAY = 86400000

function stopsAt(definition, date, time, now = Date.now()) {
  if (!rideTime.isValidRideDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw invalid()
  const wall = Date.parse(`${date}T${time}:00Z`)
  let previous = -Infinity
  return definition.stops.map(stop => {
    const place = { kind: stop.kind, address: stop.address, ...(stop.placeId ? { placeId: stop.placeId } : {}) }
    if (stop.kind === 'destination') return place
    const offset = new Date(wall + stop.offsetMinutes * 60000).toISOString()
    const at = rideTime.parseRideDateTime(offset.slice(0, 10), offset.slice(11, 16))
    if (!Number.isFinite(at) || at < previous || at < now + 15 * 60000 || at > now + 30 * DAY) throw invalid()
    previous = at
    return { ...place, departureAt: new Date(at).toISOString() }
  })
}
function templateOccurrence(template, now = Date.now()) {
  const legacy = toLegacyTemplate(template, '')
  let date = rideTime.getNextWeeklyRideDate(legacy.weekdayIndex, template.localTime, { now })
  const last = rideTime.shiftRideDate(rideTime.getRideDateData(now).todayDateStr, 30)
  while (date && date <= last) {
    try { return { date, time: template.localTime, stops: stopsAt(template.definition, date, template.localTime, now) } }
    catch (_) { date = rideTime.shiftRideDate(date, 7) }
  }
  return null
}
function toRideInput(draft, now = Date.now()) {
  if (!object(draft) || !['offer', 'request'].includes(draft.kind) || draft.cityKey !== 'ny_nj') throw invalid()
  if (draft.kind === 'request' && draft.template) throw invalid()
  const capacity = Number(draft.passengerCount)
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > (draft.kind === 'offer' ? 8 : 4)) throw invalid()
  const template = toTemplateInput({ templateName: draft.template?.name || '路线', weekdayIndex: 0,
    departureTime: draft.departureTime, departureAddress: draft.departureAddress, destinationAddress: draft.destinationAddress,
    passengerCount: capacity, referencePrice: draft.referencePrice, comment: draft.comment || '' }, draft.template)
  const { seatCapacity, ...fields } = template.definition
  return { ...fields, kind: draft.kind, timeZone: 'America/New_York', stops: stopsAt(template.definition, draft.departureDate, draft.departureTime, now),
    ...(draft.kind === 'offer' ? { seatCapacity } : { partySize: capacity, largeLuggageCount: 0 }) }
}
function summarizeStops(stops) {
  return stops.map(stop => {
    const local = stop.kind === 'departure' ? rideTime.getRideDateTime(Date.parse(stop.departureAt)) : null
    return `${stop.kind === 'departure' ? '出发' : '到达'}：${stop.address}${local ? ` ${local.date} ${local.time}` : ''}`
  }).join('\n')
}
function validReceipt(data) {
  return object(data) && uuid(data.rideId) && Number.isSafeInteger(data.version) && data.version >= 1 && data.status === 'open' && data.changed === true
}
function createRidePublishClient(options = {}) {
  const api = options.backend || backend, platform = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const config = options.loadLocationConfig || loadLocationConfig
  const owner = () => !platform.getStorageSync('isGuest') && platform.getStorageSync('openid') || ''
  const current = account => { if (!account || owner() !== account) throw fail('REQUEST_CANCELLED', '当前操作已取消') }
  async function recoverPublishedRide() {
    const account = owner(); current(account)
    if (!api.isBackendEnabled()) throw fail('BACKEND_DISABLED', '业务服务尚未切换')
    const receipt = await api.retryPending('rides.create', { validate: validReceipt })
    current(account)
    if (!receipt) return null
    if (!validReceipt(receipt)) throw fail('INVALID_RESPONSE', '发布结果尚未确认，请重试')
    return { id: receipt.rideId, version: receipt.version, status: receipt.status, recovered: true }
  }
  async function publishRide(draft) {
    const account = owner(); current(account)
    if (draft.openid !== account) throw fail('REQUEST_CANCELLED', '当前操作已取消')
    const recoveredRide = await recoverPublishedRide()
    if (recoveredRide) return recoveredRide
    const payload = toRideInput(draft, options.now ? options.now() : Date.now())
    let receipt, recovered = false
    try { receipt = await api.mutate('rides.create', 'POST', '/api/v1/rides', payload, { validate: validReceipt }) }
    catch (error) {
      if (error?.code !== 'PENDING_OPERATION') throw error
      receipt = await api.retryPending('rides.create', { validate: validReceipt })
      recovered = true
    }
    current(account)
    if (!validReceipt(receipt)) throw fail('INVALID_RESPONSE', '发布结果尚未确认，请重试')
    return { id: receipt.rideId, version: receipt.version, status: receipt.status, recovered, ...(recovered ? {} : { payload }) }
  }
  async function loadRequestPrice(fromAddress, toAddress) {
    const match = (value, selected) => {
      const pattern = ridePlaceAliasPattern(selected)
      return pattern ? new RegExp(pattern, 'i').test(value) : value === selected
    }
    const catalog = await config()
    const rows = catalog.requestPrices.filter(row => match(row.fromAddress, fromAddress) && match(row.toAddress, toAddress))
    const score = row => Number(row.fromAddress === fromAddress) + Number(row.toAddress === toAddress)
    const row = rows.slice().sort((a, b) => score(b) - score(a))[0]
    return row && row.label !== null && row.label !== undefined && String(row.label).trim() ? String(row.label) : '参考打车价格'
  }
  return { publishRide, recoverPublishedRide, loadRequestPrice }
}
let singleton
function client() { return singleton || (singleton = createRidePublishClient()) }
module.exports = { createRidePublishClient, toRideInput, templateOccurrence, summarizeStops, validReceipt, listedPrice,
  ...Object.fromEntries(['publishRide', 'recoverPublishedRide', 'loadRequestPrice'].map(name => [name, (...args) => client()[name](...args)])) }
