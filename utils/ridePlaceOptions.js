const { FIXED_PLACES, resolvePlaceId, placeById } = require('./placeCatalog')
const PLACE_MAX_LENGTH = 200
function normalizeRidePlace(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text && text.length <= PLACE_MAX_LENGTH ? text : ''
}
function placeIdentity(value) {
  const id = resolvePlaceId(value)
  return id === 'unknown' ? normalizeRidePlace(value).toLowerCase() : id
}
function shortRidePlaceLabel(value) {
  const place = placeById(resolvePlaceId(value))
  return place ? place.label : normalizeRidePlace(value)
}
function ridePlaceAliasPattern(value) {
  const place = placeById(resolvePlaceId(value))
  if (!place || ['fort_lee', 'columbia'].includes(place.placeId)) return ''
  // The old price table uses 纽瓦克 as its airport key. This exception applies to
  // reference-price lookup only, never to route classification or recommendation.
  const aliases = [...place.aliases, ...(place.placeId === 'ewr' ? ['纽瓦克'] : [])]
  const patterns = aliases.map(alias => [...alias].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'))
  return `^\\s*(?:${patterns.join('|')})\\s*$`
}
function makeRidePlaceMatcher(place) {
  const value = normalizeRidePlace(place)
  if (!value) return () => false
  if (resolvePlaceId(value) === 'fort_lee') return address => /fort\s*lee/i.test(String(address || ''))
  if (resolvePlaceId(value) === 'columbia') return address => /哥大|columbia/i.test(String(address || ''))
  const patterns = {
    ewr: /(?:^|[^a-z])ewr(?:$|[^a-z])|newark\s+(?:liberty\s+)?(?:international\s+)?airport|纽瓦克(?:自由)?(?:国际)?机场/i,
    jfk: /(?:^|[^a-z])jfk(?:$|[^a-z])|john\s*f\.?\s*kennedy|肯尼迪/i,
    lga: /(?:^|[^a-z])lga(?:$|[^a-z])|la\s*guardia|拉瓜[迪地]亚/i,
    flushing: /flushing|法拉盛/i,
    lic: /(?:^|[^a-z])lic(?:$|[^a-z])|long\s+island\s+city|长岛市/i,
    jsq: /(?:^|[^a-z])jsq(?:$|[^a-z])|journal\s+square/i,
    inwood: /(?:^|[^a-z])(?:inwood(?:\s*manhattan)?|manhattan\s*inwood)(?:$|[^a-z])/i,
    midtown: /(?:^|[^a-z])(?:midtown\s*manhattan|manhattan\s*midtown|midtown\s+(?:east|west))(?:$|[^a-z])|中城|^\s*midtown\s*$/i,
    downtown: /(?:^|[^a-z])(?:lower\s*manhattan|downtown\s*manhattan|manhattan\s*downtown)(?:$|[^a-z])|下城|^\s*downtown\s*$/i,
    queens: /(?:^|[^a-z])queens(?:$|[^a-z])|皇后[区區]/i
  }
  const id = resolvePlaceId(value)
  if (patterns[id]) return address => patterns[id].test(String(address || ''))
  return address => !!address && String(address).toLowerCase().includes(value.toLowerCase())
}
function uniqueRidePlaces(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).reduce((places, value) => {
    const text = normalizeRidePlace(value), key = placeIdentity(text)
    if (!text || ['全部', '其他', '自选'].includes(text) || seen.has(key)) return places
    seen.add(key); places.push(text); return places
  }, [])
}
// Retained API for callers; suggestions no longer scan CloudBase or expose raw
// addresses from other users. The authenticated service owns public eligibility.
function loadRidePlaceOptions(options) { return require('./placeRecommendations').loadPlaceRecommendations(options) }
module.exports = { PLACE_MAX_LENGTH, normalizeRidePlace, placeIdentity, shortRidePlaceLabel, ridePlaceAliasPattern, makeRidePlaceMatcher, uniqueRidePlaces, loadRidePlaceOptions, FIXED_PLACES, resolvePlaceId, placeById }
