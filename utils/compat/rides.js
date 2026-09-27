// TEMPORARY CloudBase boundary. Selection is explicit for the whole operation;
// failures of the server never fall back to the old database.
const backend = require('../backendClient')
const rideTime = require('../rideTime')
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
const rideId = v => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(v)
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const fail = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => fail('INVALID_RESPONSE', '行程数据异常，请刷新后重试')
const version = v => Number.isSafeInteger(v) && v > 0

function statistics(value, role = 'driver') {
  if (!object(value) || !Number.isSafeInteger(value.completedTrips) || value.completedTrips < 0 ||
    !Number.isSafeInteger(value.ratingCount) || value.ratingCount < 0 ||
    [value.averageRating, value.weightedRating].some(n => n !== null && (typeof n !== 'number' || n < 1 || n > 5))) throw invalid()
  const prefix = role === 'driver' ? 'driver' : 'passenger'
  return { completedTrips: value.completedTrips, ratingCount: value.ratingCount,
    ratingAvg: value.averageRating, ratingWeightedAvg: value.weightedRating,
    [role === 'driver' ? 'completedDriverTrips' : 'completedPassengerTrips']: value.completedTrips,
    [`${prefix}RatingCount`]: value.ratingCount, [`${prefix}RatingAvg`]: value.averageRating,
    [`${prefix}RatingWeightedAvg`]: value.weightedRating }
}
function toRide(row) {
  if (!object(row) || !rideId(row.id) || !['offer', 'request'].includes(row.kind) || !['open', 'closed'].includes(row.status) ||
    !version(row.version) || !Number.isInteger(row.seatCapacity) || row.seatCapacity < 1 || row.seatCapacity > 8 ||
    !Number.isInteger(row.availableSeats) || row.availableSeats < 0 || row.availableSeats > row.seatCapacity ||
    typeof row.hasDriver !== 'boolean' || !Array.isArray(row.stops) || row.stops.length < 2 || row.stops.length > 20 ||
    row.listedPriceCents !== null && (!Number.isSafeInteger(row.listedPriceCents) || row.listedPriceCents < 0) ||
    row.listedPriceLabel !== null && typeof row.listedPriceLabel !== 'string') throw invalid()
  let destinationSeen = false
  const point = (stop, index) => {
    if (!object(stop) || !['departure', 'destination'].includes(stop.kind) || typeof stop.address !== 'string' ||
      !stop.address || stop.position !== index || stop.kind === 'departure' && destinationSeen) throw invalid()
    if (stop.kind === 'destination') destinationSeen = true
    const at = stop.kind === 'departure' ? Date.parse(stop.departureAt) : null
    if (at !== null && !Number.isFinite(at)) throw invalid()
    return { address: stop.address, placeId: stop.placeId || '', ...(at !== null ? rideTime.getRideDateTime(at) : {}) }
  }
  const points = row.stops.map(point)
  const departures = points.filter((_, i) => row.stops[i].kind === 'departure')
  const destinations = points.filter((_, i) => row.stops[i].kind === 'destination')
  if (!departures.length || !destinations.length) throw invalid()
  return { _id: row.id, serverMode: true, kind: row.kind, cityKey: row.cityKey, businessVersion: row.version,
    status: row.status === 'closed' ? 'past' : 'open', canonicalStatus: row.status,
    departures, destinations, departureAtMs: Date.parse(row.departureAt),
    latestDepartureAtMs: Math.max(...row.stops.filter(stop => stop.kind === "departure").map(stop => Date.parse(stop.departureAt))),
    referencePrice: row.listedPriceLabel == null ? row.listedPriceCents === null ? '' : (row.listedPriceCents / 100).toFixed(2) : row.listedPriceLabel,
    listedPriceLabel: row.listedPriceLabel, listedPriceCents: row.listedPriceCents,
    passengerCount: row.kind === 'offer' ? row.seatCapacity : row.seatCapacity - row.availableSeats,
    seatCapacity: row.seatCapacity, availableSeats: row.availableSeats, availSeatNum: row.availableSeats,
    hasDriver: row.hasDriver, comment: row.note || '', passengers: [], passengerID: [],
    driverStats: row.driverStatistics == null ? null : statistics(row.driverStatistics) }
}
function toMember(member) {
  if (!object(member) || !uuid(member.id) || typeof member.name !== 'string' || !['driver', 'passenger'].includes(member.role) ||
    !Number.isInteger(member.seatCount) || member.seatCount < 0 || member.avatarFileId !== null && !uuid(member.avatarFileId)) throw invalid()
  return { userId: member.id, name: member.name, role: member.role, isCreator: member.isCreator === true,
    seatCount: member.seatCount, avatarFileId: member.avatarFileId, avatarUrl: '',
    phone: member.phone || '', regionPhone: member.phoneRegion || '', wechatID: member.wechatId || '',
    carNumber: member.vehicle?.plate || '', carBrand: member.vehicle?.brand || '', carModel: member.vehicle?.model || '',
    zelleName: member.zelle?.name || '', zelleAccount: member.zelle?.account || '',
    pickupAddress: member.pickupAddress || '', dropoffAddress: member.dropoffAddress || '',
    rideStats: statistics(member.statistics, member.role) }
}
function filters(input) {
  const values = { cityKey: input.cityKey || 'ny_nj' }
  if (input.type === 'carpool' || input.type === 'offer') values.kind = 'offer'
  if (input.type === 'request') values.kind = 'request'
  for (const key of ['fromPlace', 'toPlace', 'keyword']) if (input[key]) values[key] = input[key]
  for (const key of ['fromPresets', 'toPresets']) if (Array.isArray(input[key]) && input[key].length) values[key] = JSON.stringify(input[key])
  return values
}
const query = values => Object.entries(values).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

function createRideClient(options = {}) {
  const api = options.backend || backend, platform = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const account = () => !platform.getStorageSync('isGuest') && platform.getStorageSync('openid') || ''
  const current = owner => { if (account() !== owner) throw fail('REQUEST_CANCELLED', '登录状态已变化，请重试') }
  const authenticated = () => { const owner = account(); if (!owner) throw fail('UNAUTHORIZED', '请先登录'); return owner }
  const old = (name, data) => platform.cloud.callFunction({ name, ...(data === undefined ? {} : { data }) })
  async function pages(path, params, owner, publicRead) {
    const all = [], seen = new Set()
    let nextDate = null
    for (let page = 1; page <= 1000; page++) {
      current(owner)
      const data = await api.get(`${path}?${query({ ...params, page, limit: 50 })}`, { public: publicRead })
      current(owner)
      if (!object(data) || !Array.isArray(data.rides) || data.rides.length > 50 || data.nextPage !== null &&
        (data.nextPage !== page + 1 || data.rides.length !== 50 || page === 1000)) throw invalid()
      if (params.startDate) {
        if (data.nextDate !== null && (!date(data.nextDate) || data.nextDate < params.endDateExclusive)) throw invalid()
        if (page > 1 && data.nextDate !== nextDate) throw fail('RIDE_CHANGED', '列表已更新，请刷新重试')
        nextDate = data.nextDate
      }
      for (const row of data.rides) {
        toRide(row)
        if (seen.has(row.id)) throw fail('RIDE_CHANGED', '列表已更新，请刷新重试')
        seen.add(row.id); all.push(row)
      }
      if (data.nextPage === null) return { rows: all, nextDate }
    }
    throw invalid()
  }
  async function callTripList(input = {}) {
    if (!api.isBackendEnabled()) return old('getTripList', input)
    const owner = account(), params = filters(input)
    if (input.month) {
      const result = await api.get(`/api/v1/rides/calendar?${query({ ...params, month: input.month })}`, { public: true })
      current(owner)
      if (!object(result) || result.month !== input.month || !Array.isArray(result.days)) throw invalid()
      const seen = new Set()
      const days = result.days.map(day => {
        if (!object(day) || !date(day.date) || !day.date.startsWith(`${input.month}-`) || seen.has(day.date) ||
          !Number.isSafeInteger(day.offerCount) || day.offerCount < 0 || !Number.isSafeInteger(day.requestCount) || day.requestCount < 0) throw invalid()
        seen.add(day.date)
        return { date: day.date, carpoolCount: day.offerCount, requestCount: day.requestCount }
      })
      return { result: { success: true, month: input.month, data: { days } } }
    }
    if (!date(input.startDate) || !date(input.endDateExclusive) || input.endDateExclusive <= input.startDate) throw invalid()
    const { rows, nextDate } = await pages('/api/v1/rides', { ...params, startDate: input.startDate, endDateExclusive: input.endDateExclusive }, owner, true)
    return { result: { success: true, data: { carpool: rows.filter(r => r.kind === 'offer').map(toRide), request: rows.filter(r => r.kind === 'request').map(toRide) },
      page: { startDate: input.startDate, endDateExclusive: input.endDateExclusive, hasMore: nextDate !== null, nextDate } } }
  }
  async function getHomeTripList() {
    if (!api.isBackendEnabled()) return old('getHomeTripList')
    const owner = account(), data = { driver: { createList: [], joinList: [] }, passenger: { createList: [], joinList: [] } }
    if (!owner) return { result: { ok: true, data } }
    const { rows } = await pages('/api/v1/me/rides', { scope: 'current' }, owner, false)
    for (const row of rows) {
      if (!['driver', 'passenger'].includes(row.role) || typeof row.isCreator !== 'boolean') throw invalid()
      data[row.role][row.isCreator ? 'createList' : 'joinList'].push({ tripData: { ...toRide(row), viewer: { isCreator: row.isCreator, role: row.role, seatCount: row.seatCount } },
        from: row.kind === 'offer' ? 'carpool' : 'request' })
    }
    return { result: { ok: true, data } }
  }
  async function getTripDetail(type, id) {
    if (!api.isBackendEnabled()) return (await old('getTripDetail', { type, id })).result || {}
    if (!rideId(id)) throw invalid()
    const owner = account(), path = `/api/v1/rides/${encodeURIComponent(id)}`
    for (let attempt = 0; attempt < 2; attempt++) {
      current(owner)
      const [row, viewer] = await Promise.all([api.get(path, { public: true }), owner ? api.get(`${path}/membership`) : null])
      current(owner)
      const trip = toRide(row)
      if ((type === 'request') !== (row.kind === 'request') || row.id !== id) throw invalid()
      if (viewer && (!object(viewer) || viewer.rideId !== id || !uuid(viewer.userId) || typeof viewer.isCreator !== 'boolean' ||
        ![null, 'driver', 'passenger'].includes(viewer.role) || !Number.isInteger(viewer.seatCount) || viewer.seatCount < 0 || !version(viewer.version))) throw invalid()
      if (viewer && viewer.version !== row.version) continue
      let participants = [], ratedTargetUserIds = []
      if (viewer?.role) {
        const [members, ratings] = await Promise.all([api.get(`${path}/participants`), api.get(`${path}/ratings`)])
        current(owner)
        if (!object(members) || members.rideId !== id || members.kind !== row.kind || !version(members.version) ||
          !Array.isArray(members.participants) || !object(ratings) || !Array.isArray(ratings.ratings)) throw invalid()
        if (members.version !== row.version) continue
        participants = members.participants.map(toMember)
        if (new Set(participants.map(m => m.userId)).size !== participants.length || !participants.some(m => m.userId === viewer.userId && m.role === viewer.role)) throw invalid()
        ratedTargetUserIds = ratings.ratings.map(r => { if (!uuid(r?.targetId) || !Number.isInteger(r.score) || r.score < 1 || r.score > 5) throw invalid(); return r.targetId })
        const ids = [...new Set(participants.map(m => m.avatarFileId).filter(Boolean))]
        const urls = ids.length ? await api.resolveImages(ids) : []
        current(owner)
        for (const member of participants) member.avatarUrl = urls.find(item => item.fileId === member.avatarFileId)?.url || ''
        if (members.largeLuggageCount !== undefined) trip.largeLuggageCount = members.largeLuggageCount
      }
      const driverInfo = participants.find(m => m.role === 'driver') || null
      trip.viewer = viewer || { userId: null, isCreator: false, role: null, seatCount: 0 }
      trip.passengers = participants.filter(m => m.role === 'passenger')
      trip.driverUserId = driverInfo?.userId || ''
      trip.creatorUserId = participants.find(m => m.isCreator)?.userId || ''
      trip.zelle = driverInfo && (driverInfo.zelleName || driverInfo.zelleAccount) ? 'yes' : 'no'
      return { ok: true, success: true, data: trip, viewer: trip.viewer, participants, driverInfo,
        passengerProfiles: trip.passengers, ratedTargetUserIds, driverStats: trip.driverStats }
    }
    throw fail('RIDE_CHANGED', '行程已变化，请重新加载')
  }
  async function callTripManage(input = {}) {
    if (!api.isBackendEnabled()) return (await old('tripManage', input)).result || {}
    const owner = authenticated(), id = input.tripId || input.requestId || input.id, target = input.targetUserId
    if (input.action === 'getBlockList') {
      const list = [], seen = new Set()
      for (let page = 1; page <= 1000; page++) {
        const result = await api.get(`/api/v1/blocks?page=${page}&limit=50`); current(owner)
        if (!Array.isArray(result?.blocks) || result.blocks.length > 50 || result.nextPage !== null && (result.nextPage !== page + 1 || result.blocks.length !== 50 || page === 1000)) throw invalid()
        for (const item of result.blocks) { if (!uuid(item?.targetUserId) || seen.has(item.targetUserId)) throw invalid(); seen.add(item.targetUserId); list.push(item) }
        if (result.nextPage === null) {
          for (let offset = 0; offset < list.length; offset += 50) {
            const chunk = list.slice(offset, offset + 50), ids = [...new Set(chunk.map(m => m.avatarFileId).filter(Boolean))]
            const urls = ids.length ? await api.resolveImages(ids) : []; current(owner)
            for (const item of chunk) item.avatarUrl = urls.find(u => u.fileId === item.avatarFileId)?.url || ''
          }
          return { ok: true, list, data: list }
        }
      }
      throw invalid()
    }
    let scope, path, method = 'POST', body, validate
    if (input.action === 'blockUser' || input.action === 'unblockUser') {
      if (!uuid(target)) throw fail('INVALID_REQUEST', '缺少用户编号')
      const active = input.action === 'blockUser'
      scope = `blocks.${active ? 'add' : 'remove'}:${target}`; path = `/api/v1/blocks${active ? '' : `/${target}`}`
      method = active ? 'POST' : 'DELETE'; body = active ? { targetUserId: target } : {}
      validate = data => object(data) && data.targetUserId === target && data.active === active
    } else {
      if (!rideId(id)) throw fail('INVALID_REQUEST', '缺少路线编号')
      const base = `/api/v1/rides/${encodeURIComponent(id)}`
      switch (input.action) {
        case 'acceptRequest': case 'joinPassenger':
          path = `${base}/join`; scope = `rides.join:${id}`
          body = input.action === 'acceptRequest' ? { role: 'driver' } : { role: 'passenger', seatCount: input.seatCount || 1,
            ...(input.type === 'request' ? {} : { pickupAddress: input.pickupAddress, dropoffAddress: input.dropoffAddress }) }; break
        case 'quitDriver': case 'quitTrip':
          path = `${base}/leave`; scope = `rides.leave:${id}`; body = { reason: input.reason || '' }; break
        case 'deleteTrip':
          path = `${base}/cancel`; scope = `rides.cancel:${id}`; body = { reason: input.reason || '取消行程' }; break
        case 'kickDriver': case 'kickPassenger':
          if (!uuid(target)) throw fail('INVALID_REQUEST', '缺少用户编号')
          path = `${base}/members/${target}/remove`; scope = `rides.remove:${id}:${target}`; body = { reason: input.reason || '' }; break
        case 'rateUser':
          if (!uuid(target)) throw fail('INVALID_REQUEST', '缺少用户编号')
          path = `${base}/ratings`; scope = `rides.rate:${id}:${target}`; body = { targetId: target, score: input.score }
          validate = data => object(data) && uuid(data.ratingId) && data.rideId === id && data.targetId === target && Number.isInteger(data.score) && data.score >= 1 && data.score <= 5; break
        default: throw fail('INVALID_REQUEST', '不支持的行程操作')
      }
      if (!validate) validate = data => object(data) && data.rideId === id && version(data.version) && ['open', 'closed', 'cancelled'].includes(data.status) && typeof data.changed === 'boolean'
    }
    // Changed input after an uncertain submit stays pending. Never replay a
    // different intent, silently change an existing membership, or switch source.
    let result, recovered = false
    try { result = await api.mutate(scope, method, path, body, { validate }) }
    catch (error) {
      if (error?.code !== 'PENDING_OPERATION') throw error
      current(owner)
      result = await api.retryPending(scope, { validate })
      recovered = true
    }
    current(owner)
    if (!validate(result)) throw invalid()
    return { ok: true, success: true, recovered, data: result }
  }
  async function requestCity(input = {}) {
    if (!api.isBackendEnabled()) return old('rideDemand', input)
    const owner = account()
    const data = await api.submitLocationRequest({ cityKey: input.cityKey, sourcePage: input.sourcePage })
    current(owner)
    if (!object(data) || typeof data.cityKey !== 'string' ||
      !(data.status === 'recorded' && uuid(data.requestId) || data.status === 'already_available' && data.cityKey === 'ny_nj' && data.requestId === null)) throw invalid()
    return { result: { success: true, ...data } }
  }
  async function joinTrip(input = {}) {
    if (!api.isBackendEnabled()) return old('joinTrip', input)
    return { result: await callTripManage({ ...input, action: 'joinPassenger',
      tripId: input.tripId || input.requestId, pickupAddress: input.pickupAddress || input.passengerInfo?.pickupAddress,
      dropoffAddress: input.dropoffAddress || input.passengerInfo?.dropoffAddress }) }
  }
  return { callTripList, getHomeTripList, getTripDetail, callTripManage, joinTrip, requestCity }
}
let singleton
const client = () => singleton || (singleton = createRideClient())
module.exports = { createRideClient, toRide, toMember, isBackendEnabled: backend.isBackendEnabled,
  ...Object.fromEntries(['callTripList', 'getHomeTripList', 'getTripDetail', 'callTripManage', 'joinTrip', 'requestCity'].map(name => [name, (...args) => client()[name](...args)])) }
