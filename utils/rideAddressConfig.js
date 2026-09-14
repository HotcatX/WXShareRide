const { normalizeRidePlace, placeIdentity, uniqueRidePlaces } = require('./ridePlaceOptions')

const ADDRESS_CONFIG_CACHE_MS = 5 * 60 * 1000
const COMMON_PLACE_ORDER = ['fortlee', 'columbia', 'ewr', 'jfk', 'lga', 'flushing']
let cached = null
let pending = null

function copyConfig(config) {
  return { fromPlaces: config.fromPlaces.slice(), toPlaces: config.toPlaces.slice() }
}

function getCachedRideAddressConfig() {
  const age = cached ? Date.now() - cached.at : -1
  return cached && age >= 0 && age < ADDRESS_CONFIG_CACHE_MS ? copyConfig(cached.data) : null
}

function readPlaces(response) {
  const record = response && Array.isArray(response.data) && response.data[0]
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('地点配置加载失败')
  const values = Object.keys(record).filter(key => key !== '_id').map(key => record[key])
  if (!values.length || values.some(value => typeof value !== 'string' || !normalizeRidePlace(value))) throw new Error('地点配置格式无效')
  const places = uniqueRidePlaces(values)
  if (!places.length) throw new Error('地点配置为空')
  return places.map((value, index) => ({ value, index, rank: COMMON_PLACE_ORDER.indexOf(placeIdentity(value)) }))
    .sort((a, b) => (a.rank < 0 ? COMMON_PLACE_ORDER.length : a.rank) - (b.rank < 0 ? COMMON_PLACE_ORDER.length : b.rank) || a.index - b.index)
    .map(item => item.value)
}

function loadRideAddressConfig({ force = false } = {}) {
  if (pending) return pending.then(copyConfig)
  const available = !force && getCachedRideAddressConfig()
  if (available) return Promise.resolve(available)
  pending = (async () => {
    const db = wx.cloud.database()
    const [from, to] = await Promise.all([
      db.collection('Departure').get(),
      db.collection('Arrival').get()
    ])
    const data = { fromPlaces: readPlaces(from), toPlaces: readPlaces(to) }
    cached = { at: Date.now(), data }
    return data
  })().finally(() => { pending = null })
  return pending.then(copyConfig)
}

module.exports = { ADDRESS_CONFIG_CACHE_MS, getCachedRideAddressConfig, loadRideAddressConfig }
