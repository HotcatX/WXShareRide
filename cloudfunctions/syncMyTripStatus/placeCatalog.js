const CATALOG_VERSION = 'places-v1'
const FIXED_PLACES = [
  { placeId: 'fort_lee', label: 'Fort Lee', value: 'Fort Lee', aliases: ['fortlee', 'fortlee核心区'], airport: false },
  { placeId: 'columbia', label: '哥大', value: '哥大', aliases: ['哥大', '哥伦比亚大学', 'columbia', 'columbiauniversity', '哥大columbia', '哥大/columbia'], airport: false },
  { placeId: 'flushing', label: '法拉盛', value: '法拉盛', aliases: ['法拉盛', 'flushing'], airport: false },
  { placeId: 'jfk', label: 'JFK', value: 'JFK', aliases: ['jfk', 'jfk机场', 'jfk国际机场', 'jfkairport', '肯尼迪', '肯尼迪机场', '肯尼迪国际机场', '纽约肯尼迪机场', 'johnfkennedy', 'johnfkennedyairport', 'johnfkennedyinternationalairport'], airport: true },
  { placeId: 'ewr', label: 'EWR 纽瓦克机场', value: 'EWR 机场', aliases: ['ewr', 'ewr机场', 'ewrairport', '纽瓦克机场', '纽瓦克国际机场', '纽瓦克自由国际机场', 'newarkairport', 'newarkinternationalairport', 'newarklibertyairport', 'newarklibertyinternationalairport'], airport: true },
  { placeId: 'lga', label: 'LGA 拉瓜迪亚', value: 'LGA 机场', aliases: ['lga', 'lga机场', 'lgaairport', '拉瓜迪亚', '拉瓜迪亚机场', '拉瓜迪亚国际机场', '拉瓜地亚', '拉瓜地亚机场', 'laguardia', 'laguardiaairport', 'laguardiainternationalairport'], airport: true },
  { placeId: 'lic', label: 'LIC', value: 'LIC', aliases: ['lic', 'longislandcity', '长岛市'], airport: false },
  { placeId: 'jsq', label: 'JSQ', value: 'JSQ', aliases: ['jsq', 'journalsquare', 'journalsquarestation', 'journalsquarepath', 'journalsquarepathstation'], airport: false }
]
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
