const { placeCatalogVersion: CATALOG_VERSION, fixedPlaces: FIXED_PLACES } = require('./locationCatalog.generated.js')
function normalizeText(value) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '' }
function resolvePlaceId(value) {
  const text = normalizeText(value).toLowerCase().replace(/\s+/g, '')
  const place = FIXED_PLACES.find(item => item.placeId === text || item.aliases.includes(text) || item.label.toLowerCase().replace(/\s+/g, '') === text)
  return place ? place.placeId : 'unknown'
}
function placeById(id) { return FIXED_PLACES.find(place => place.placeId === id) || null }
function fixedPlaceValues() { return FIXED_PLACES.map(place => place.value) }
// A bare Newark / 纽瓦克 is the city. Only this configured legacy slot is migrated;
// user text and historical business addresses are never silently reclassified.
function configuredPlaceId(value) { return normalizeText(value) === '纽瓦克' ? 'ewr' : resolvePlaceId(value) }
module.exports = { CATALOG_VERSION, FIXED_PLACES, resolvePlaceId, placeById, fixedPlaceValues, configuredPlaceId }
