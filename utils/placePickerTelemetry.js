const { CATALOG_VERSION, resolvePlaceId } = require('./placeCatalog')
const { currentViewer } = require('./placeRecommendations')
function analytics() { return require('./analyticsSession') }
function eventId() {
  return 'place_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 13) + Math.random().toString(36).slice(2, 8)
}
function record(session, name, detail = {}) {
  if (!session || session.closed || session.viewer !== currentViewer()) return
  try {
    const api = analytics()
    if (session.scope && typeof api.getCollectionScope === 'function' && api.getCollectionScope() !== session.scope) return
    api.recordEvent(name, { ...session.common, ...detail })
  } catch (_) {}
}
function createPlacePickerSession(context, snapshot) {
  let scope = ''
  try { scope = analytics().getCollectionScope() || '' } catch (_) {}
  const session = { viewer: currentViewer(), scope, closed: false, rendered: '', visible: new Set(), observer: null, common: {
    pickerSessionId: eventId(), field: context.field, mode: context.mode, cityKey: context.cityKey,
    catalogVersion: snapshot.catalogVersion || CATALOG_VERSION, rankingVersion: snapshot.rankingVersion || 'fixed-recent-v1',
    ...(snapshot.snapshotId ? { snapshotId: snapshot.snapshotId } : {}),
    ...(context.counterpartPlaceId && context.counterpartPlaceId !== 'unknown' ? { counterpartPlaceId: context.counterpartPlaceId } : {}),
    ...(snapshot.preferenceVersion ? { preferenceVersion: snapshot.preferenceVersion } : {}),
    circleIds: (snapshot.circles || []).slice(0, 2).map(circle => circle.circleId),
    generatedAt: snapshot.generatedAt || Date.now(), cacheAgeMs: Math.min(86400000, snapshot.cacheAgeMs || 0)
  } }
  record(session, 'place_picker_open'); return session
}
function itemData(row, position) {
  const id = row.placeId || resolvePlaceId(row.value)
  return { placeId: id === 'unknown' ? 'custom' : id, position: Number.isInteger(row.position) ? row.position : position, source: row.source || 'fixed' }
}
function renderPlaces(session, rows, stage = 'rendered') {
  const items = (rows || []).filter(row => !row.filterToken).slice(0, 20).map(itemData)
  if (!items.length) return
  const signature = JSON.stringify(items)
  if (stage === 'rendered' && session && session.rendered === signature) return
  if (session && stage === 'rendered') session.rendered = signature
  record(session, 'place_picker_rendered', { items, stage })
}
function selectPlace(session, row, position, custom = false) {
  if (row.filterToken) { closePlacePicker(session); return }
  const item = itemData(row, position)
  if (custom) record(session, 'place_picker_custom', { result: 'confirmed', placeId: item.placeId })
  record(session, 'place_picker_selected', item)
  closePlacePicker(session)
}
function customCancelled(session) { record(session, 'place_picker_custom', { result: 'cancelled' }) }
function closePlacePicker(session, reason) {
  if (!session || session.closed) return
  if (reason) record(session, 'place_picker_dismissed', { reason })
  if (session.observer) { try { session.observer.disconnect() } catch (_) {} }
  session.closed = true
}
function observePlaces(host, session, selector) {
  if (!host || !session || session.closed) return
  if (session.observer) { try { session.observer.disconnect() } catch (_) {} }
  if (typeof host.createIntersectionObserver !== 'function') return
  try {
    const observer = host.createIntersectionObserver({ observeAll: true, thresholds: [0, 0.5] })
    session.observer = observer
    observer.relativeToViewport().observe(selector, result => {
      if (session.closed || result.intersectionRatio < 0.5) return
      const data = result.dataset || {}, position = Number(data.position)
      if (!Number.isInteger(position) || position < 0 || position > 49 || !data.placeId || data.filterToken === true || data.filterToken === 'true') return
      const key = position + ':' + data.placeId
      if (session.visible.has(key)) return
      session.visible.add(key)
      renderPlaces(session, [{ placeId: data.placeId, position, source: data.source || 'fixed' }], 'visible')
    })
  } catch (_) {}
}
module.exports = { createPlacePickerSession, renderPlaces, selectPlace, closePlacePicker, customCancelled, observePlaces }
