// Shared view adaptation for authenticated ride management pages. The rides
// facade alone owns transport, authorization and UUID identity; this module only
// applies its authorized response and discards late page/account responses.
const rides = require('./rides')
const profile = require('./profile')
const { attachRideStats, buildRatedTargetMap, isTargetRated, formatRidePricePerPerson } = require('../tripManage')
const telemetry = require('../rideTelemetry')
const fail = message => Object.assign(new Error(message), { code: 'PRIVATE_RIDE_UNAVAILABLE' })
function clear(page, message = '') {
  page.setData({ trip: null, driverInfo: null, passengers: [], otherPassengers: [], passengerList: [], ratedTargetMap: {},
    loading: false, passengersLoading: false, loadError: message, passengersError: '', driverInfoError: '',
    fromText: '', toText: '', dateText: '', weekdayText: '', timeText: '', showFortLeeCoreTip: false,
    isMyRequest: false, isCreator: false, kickMode: false, isTripCompleted: false, isRequestCompleted: false })
}
function actionGuard(page) {
  if (!rides.isBackendEnabled()) return () => false
  const identity = profile.identity(), revision = page._detailRevision
  return () => !page._detailDisposed && !!page.data.trip && page._detailIdentity === identity &&
    profile.identity() === identity && page._detailRevision === revision
}
const REFRESH_MS = 240000
function cancelRefresh(page) { if (page._detailTimer) clearTimeout(page._detailTimer); page._detailTimer = null }
function scheduleRefresh(page) {
  cancelRefresh(page)
  if (page._detailHidden || page._detailDisposed || !page._refreshPrivateRide) return
  page._detailTimer = setTimeout(() => { page._detailTimer = null; page._refreshPrivateRide() }, Math.max(0, REFRESH_MS - (Date.now() - (page._detailReadAt || Date.now()))))
  page._detailTimer?.unref?.()
}
function onHide(page) { page._detailHidden = true; cancelRefresh(page) }
function onShow(page, reload) {
  if (!rides.isBackendEnabled()) { clear(page, '业务服务尚未切换'); return }
  page._detailHidden = false
  const identity = profile.identity()
  if (page._detailIdentity !== undefined && page._detailIdentity !== identity) {
    page._detailRevision = (page._detailRevision || 0) + 1
    page._detailIdentity = identity
    clear(page, '登录状态已变化，请刷新路线')
    if (reload) reload()
  } else if (page._detailReadAt && Date.now() - page._detailReadAt >= REFRESH_MS) {
    if (reload) reload()
  } else scheduleRefresh(page)
}
function onUnload(page) { onHide(page); page._detailDisposed = true; page._detailRevision = (page._detailRevision || 0) + 1 }
function toState(page, result, role, creatorOnly) {
  const trip = result?.data, viewer = result?.viewer
  if (!result?.ok || !trip?.serverMode || !viewer || viewer.role !== role || creatorOnly && !viewer.isCreator) throw fail('当前账号无权查看此路线')
  const ratedTargetMap = buildRatedTargetMap(result)
  const member = value => value ? { ...value, ...attachRideStats(value, value.role), hasRated: isTargetRated(ratedTargetMap, value.userId) } : null
  const passengers = (result.passengerProfiles || []).map(member)
  const others = passengers.filter(p => p.userId !== viewer.userId)
  const from = trip.departures[0], to = trip.destinations[0], completed = trip.canonicalStatus === 'closed'
  const count = trip.kind === 'request' ? trip.passengerCount : passengers.reduce((n, p) => n + p.seatCount, 0)
  return { trip: { ...trip, referencePriceText: formatRidePricePerPerson(trip.referencePrice) },
    serverMode: true, fromText: from.address, toText: to.address, dateText: page.formatDateNoYear(from.date),
    weekdayText: page.getWeekdayCN(from.date), timeText: from.time,
    showFortLeeCoreTip: page.containsFortLeeCore(from.address) || page.containsFortLeeCore(to.address),
    passengers: role === 'driver' ? passengers : [], passengersLoading: false, passengersError: '',
    otherPassengers: trip.kind === 'request' ? others : [], passengerList: trip.kind === 'request' ? others : [],
    passengerSummaryText: count === passengers.length ? `${count} 人` : `${count} 人 · ${passengers.length} 位联系人`,
    driverInfo: member(result.driverInfo), driverInfoError: '', ratedTargetMap, isMyRequest: role === 'driver',
    isCreator: viewer.isCreator, isTripCompleted: completed, isRequestCompleted: completed,
    largeLuggageCount: Number.isSafeInteger(trip.largeLuggageCount) && trip.largeLuggageCount >= 0 ? trip.largeLuggageCount : null, kickMode: completed ? false : page.data.kickMode,
    loading: false, loadError: '' }
}
async function load(page, type, id, role, options = {}) {
  if (page._detailDisposed) return
  cancelRefresh(page)
  page._refreshPrivateRide = () => load(page, type, id, role, { ...options, silent: true })
  const identity = profile.identity(), revision = page._detailRevision = (page._detailRevision || 0) + 1
  if (page._detailIdentity !== identity) clear(page)
  page._detailIdentity = identity
  const current = () => !page._detailDisposed && page._detailRevision === revision && profile.identity() === identity
  if (!options.silent) page.setData({ loading: true, loadError: '' })
  try {
    const result = await rides.getTripDetail(type, id)
    if (!current()) return
    const state = toState(page, result, role, options.creatorOnly)
    page._detailReadAt = Date.now()
    page.setData(state, () => { if (current()) telemetry.detailViewed(page, state.trip, type, 'history') })
    scheduleRefresh(page)
  } catch (error) {
    if (current()) clear(page, error.message || '路线加载失败，请重试')
  }
}
function target(e) {
  const data = e?.currentTarget?.dataset || {}
  return { targetUserId: data.userId || '' }
}
module.exports = { isBackendEnabled: rides.isBackendEnabled, load, onShow, onHide, onUnload, actionGuard, toState, target }
