// Temporary CloudBase boundary. The selected backend is used for the entire
// operation; an HTTP failure never reads or writes the old database.
const backend = require('../backendClient')
const { resolvePlaceId } = require('../placeCatalog')
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const fail = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => fail('INVALID_TEMPLATE', '模板数据无效，请刷新后重试')
const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

// Whole-label USD amounts only. Ranges, conditions and other currencies remain
// unresolved text; never extract the first number or round excessive precision.
function listedPrice(value) {
  if (typeof value !== 'string') throw invalid()
  const text = value.trim(), amount = '(\\d{1,8})(?:\\.(\\d{1,2}))?', space = '[^\\S\\r\\n]*'
  const forms = [new RegExp(`^${amount}$`), new RegExp(`^\\$${space}${amount}(?:${space}/${space}人)?$`),
    new RegExp(`^${amount}${space}(?:\\$|USD|美元|美金|刀)(?:${space}/${space}人)?$`, 'i')]
  let cents = text === '免费' || /^free$/i.test(text) ? 0 : null
  for (const form of forms) {
    const match = form.exec(text)
    if (match) { const n = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')); cents = n <= 2147483647 ? n : null; break }
  }
  return { listedPriceCents: cents, listedPriceLabel: value }
}
function checked(row) {
  if (!object(row) || !uuid(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 ||
    !Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.localTime) || row.timeZone !== 'America/New_York') throw invalid()
  const d = row.definition
  if (!object(d) || d.kind !== 'offer' || d.cityKey !== 'ny_nj' || !Number.isInteger(d.seatCapacity) || d.seatCapacity < 1 || d.seatCapacity > 8 ||
    d.listedPriceCents !== null && (!Number.isInteger(d.listedPriceCents) || d.listedPriceCents < 0 || d.listedPriceCents > 100000000) ||
    d.listedPriceLabel != null && (typeof d.listedPriceLabel !== 'string' || d.listedPriceLabel.length > 1000 || listedPrice(d.listedPriceLabel).listedPriceCents !== d.listedPriceCents) ||
    typeof d.note !== 'string' || d.note.length > 1000 || !Array.isArray(d.stops) || d.stops.length < 2 || d.stops.length > 20) throw invalid()
  let departures = 0, destinations = 0, previous = 0
  for (const s of d.stops) {
    if (!object(s) || typeof s.address !== 'string' || !s.address.trim() || s.address.length > 300 ||
      s.placeId !== undefined && (typeof s.placeId !== 'string' || !s.placeId.trim() || s.placeId.length > 100)) throw invalid()
    if (s.kind === 'departure') {
      if (destinations || !Number.isInteger(s.offsetMinutes) || s.offsetMinutes < previous || s.offsetMinutes > 1440 || !departures && s.offsetMinutes !== 0) throw invalid()
      previous = s.offsetMinutes; departures++
    } else if (s.kind === 'destination') destinations++
    else throw invalid()
  }
  if (!departures || !destinations || departures > 10 || destinations > 10) throw invalid()
  return row
}
function toLegacyTemplate(row, account) {
  checked(row)
  const d = row.definition, weekdayIndex = (row.weekday + 6) % 7
  return { _id: row.id, templateName: row.name, weekdayIndex, weekdayText: WEEKDAYS[weekdayIndex], departureTime: row.localTime,
    departureAddress: d.stops.find(s => s.kind === 'departure').address, destinationAddress: d.stops.find(s => s.kind === 'destination').address,
    passengerCount: d.seatCapacity, referencePrice: d.listedPriceLabel == null ? d.listedPriceCents === null ? '' : (d.listedPriceCents / 100).toFixed(2) : d.listedPriceLabel,
    comment: d.note, createdAt: row.createdAt, updatedAt: row.updatedAt, _ownerAccount: account,
    backendTemplate: copy(row) }
}
function toTemplateInput(form, previous) {
  if (!object(form) || !Number.isInteger(form.weekdayIndex) || form.weekdayIndex < 0 || form.weekdayIndex > 6 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.departureTime)) throw invalid()
  const clean = (value, max, empty = false) => {
    if (typeof value !== 'string' || value.trim().length > max || !empty && !value.trim()) throw invalid()
    return value.trim()
  }
  const seat = form.passengerCount === '' ? 1 : Number(form.passengerCount)
  if (!Number.isInteger(seat) || seat < 1 || seat > 8) throw invalid()
  const from = clean(form.departureAddress, 300), to = clean(form.destinationAddress, 300)
  if (from === to) throw invalid()
  if (typeof form.referencePrice !== 'string' || form.referencePrice.length > 1000) throw invalid()
  const old = previous ? checked(previous) : null
  const quote = old && toLegacyTemplate(old, '').referencePrice === form.referencePrice
    ? { listedPriceCents: old.definition.listedPriceCents, ...(old.definition.listedPriceLabel !== undefined ? { listedPriceLabel: old.definition.listedPriceLabel } : {}) }
    : listedPrice(form.referencePrice)
  if (quote.listedPriceCents !== null && quote.listedPriceCents > 100000000) throw invalid()
  const stops = old ? copy(old.definition.stops) : [{ kind: 'departure', address: from, offsetMinutes: 0 }, { kind: 'destination', address: to }]
  for (const [kind, address] of [['departure', from], ['destination', to]]) {
    const stop = stops.find(s => s.kind === kind)
    if (!old || stop.address !== address) {
      stop.address = address; delete stop.placeId
      const placeId = resolvePlaceId(address)
      if (placeId !== 'unknown') stop.placeId = placeId
    }
  }
  return { name: clean(form.templateName, 120), weekday: (form.weekdayIndex + 1) % 7,
    localTime: form.departureTime, timeZone: 'America/New_York', definition: { kind: 'offer', cityKey: 'ny_nj',
      seatCapacity: seat, ...quote, note: clean(form.comment || '', 1000, true), stops } }
}
function createRideTemplateClient(options = {}) {
  const api = options.backend || backend, platform = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const owner = () => {
    const value = !platform.getStorageSync('isGuest') && platform.getStorageSync('openid')
    if (typeof value !== 'string' || !value) throw fail('UNAUTHORIZED', '请先登录')
    return value
  }
  const current = account => { if (owner() !== account) throw fail('REQUEST_CANCELLED', '当前操作已取消') }
  async function loadRideTemplates() {
    const account = owner(), all = [], seen = new Set()
    if (!api.isBackendEnabled()) {
      // TEMPORARY FALLBACK: selected CloudBase mode only.
      const db = platform.cloud.database()
      for (let skip = 0; skip < 100000; skip += 100) {
        const result = await db.collection('CarpoolTemplate').where({ _openid: account }).orderBy('createdAt', 'desc').skip(skip).limit(100).get()
        current(account)
        if (!result || !Array.isArray(result.data)) throw invalid()
        all.push(...result.data)
        if (result.data.length < 100) return all
      }
      throw invalid()
    }
    for (let page = 1; page <= 1000; page++) {
      const data = await api.get(`/api/v1/templates?page=${page}&limit=100`)
      current(account)
      if (!object(data) || data.page !== page || data.limit !== 100 || typeof data.hasMore !== 'boolean' ||
        !Array.isArray(data.items) || data.items.length > 100 || data.hasMore && data.items.length !== 100) throw invalid()
      for (const row of data.items) {
        const item = toLegacyTemplate(row, account)
        if (seen.has(item._id)) throw invalid()
        seen.add(item._id); all.push(item)
      }
      if (!data.hasMore) return all
    }
    throw invalid()
  }
  async function getRideTemplate(id) {
    const account = owner()
    if (api.isBackendEnabled()) {
      if (!uuid(id)) throw invalid()
      const found = (await loadRideTemplates()).find(t => t._id === id)
      if (!found) throw fail('TEMPLATE_NOT_FOUND', '未找到该模板')
      return found
    }
    const result = await platform.cloud.database().collection('CarpoolTemplate').doc(id).get()
    current(account)
    if (!result || !object(result.data) || result.data._openid && result.data._openid !== account) throw fail('TEMPLATE_NOT_FOUND', '未找到该模板')
    return result.data
  }
  async function saveRideTemplate(form, { id, previous } = {}) {
    const account = owner()
    if (!api.isBackendEnabled()) {
      const db = platform.cloud.database(), payload = { ...form, updatedAt: db.serverDate() }
      // TEMPORARY FALLBACK: legacy snapshots remain only in the old protocol.
      if (id) {
        const result = await db.collection('CarpoolTemplate').doc(id).update({ data: payload })
        if (!result?.stats?.updated) throw invalid()
      } else {
        const result = await db.collection('CarpoolTemplate').add({ data: { ...payload, createdAt: db.serverDate() } })
        if (!result?._id) throw invalid()
        id = result._id
      }
      current(account); return { _id: id, ...form }
    }
    if (id && (!uuid(id) || previous?._id !== id || previous?._ownerAccount !== account || !previous.backendTemplate)) throw invalid()
    const input = toTemplateInput(form, previous?.backendTemplate)
    let body = input
    if (id) {
      body = Object.fromEntries(Object.entries(input).filter(([key, value]) => canonical(value) !== canonical(previous.backendTemplate[key])))
      if (!Object.keys(body).length) return previous
    }
    const row = await api.mutate(id ? `templates.update:${id}` : 'templates.create', id ? 'PATCH' : 'POST',
      id ? `/api/v1/templates/${id}` : '/api/v1/templates', body, { validate: row => { checked(row); return !id || row.id === id } })
    current(account)
    if (id && row?.id !== id) throw invalid()
    return toLegacyTemplate(row, account)
  }
  async function recoverRideTemplate(id) {
    const account = owner()
    if (!api.isBackendEnabled()) return null
    if (id && !uuid(id)) throw invalid()
    const row = await api.retryPending(id ? `templates.update:${id}` : 'templates.create', { validate: row => { checked(row); return !id || row.id === id } })
    current(account)
    if (!row) return null
    if (id && row.id !== id) throw invalid()
    return toLegacyTemplate(row, account)
  }
  async function deleteRideTemplate(id) {
    const account = owner()
    if (api.isBackendEnabled()) {
      if (!uuid(id)) throw invalid()
      const result = await api.mutate(`templates.delete:${id}`, 'DELETE', `/api/v1/templates/${id}`, {}, { validate: row => object(row) && row.id === id && row.deleted === true })
      if (!object(result) || result.id !== id || result.deleted !== true) throw invalid()
    } else await platform.cloud.database().collection('CarpoolTemplate').doc(id).remove() // TEMPORARY FALLBACK.
    current(account)
  }
  return { loadRideTemplates, getRideTemplate, saveRideTemplate, recoverRideTemplate, deleteRideTemplate }
}
let singleton
function client() { return singleton || (singleton = createRideTemplateClient()) }
module.exports = { createRideTemplateClient, toLegacyTemplate, toTemplateInput, listedPrice,
  ...Object.fromEntries(['loadRideTemplates', 'getRideTemplate', 'saveRideTemplate', 'recoverRideTemplate', 'deleteRideTemplate'].map(name => [name, (...args) => client()[name](...args)])) }
