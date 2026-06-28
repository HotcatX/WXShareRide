const ALL_CITY_KEY = "all"
const ALL_CITY_LABEL = "全部"
const DEFAULT_CITY_KEY = "ny_nj"
const DEFAULT_CITY_LABEL = "纽约/新泽西"
const RIDE_DEFAULT_CITY_KEY = DEFAULT_CITY_KEY
const RIDE_SERVICE_CITY_KEY = DEFAULT_CITY_KEY
const RIDE_SERVICE_CITY_LABEL = DEFAULT_CITY_LABEL
const RIDE_SERVICE_CITY_KEYS = [RIDE_SERVICE_CITY_KEY, "ny", "nj"]
const MARKET_CITY_STORAGE_KEY = "market_active_city_v3"
const RIDE_CITY_STORAGE_KEY = "ride_active_city_v1"
const ALL_STATE_FILTER_KEY = "ALL_STATES"
const NY_NJ_ALIASES = [
  "纽约/新泽西", "纽约", "新泽西", "NY", "NJ", "NY/NJ", "NYC", "New York", "New Jersey",
  "Manhattan", "Queens", "LIC", "Long Island City", "Jersey", "Jersey City", "Fort Lee",
  "Hoboken", "Newark"
]

const CITY_STATE_FILTERS = {
  [DEFAULT_CITY_KEY]: { key: "NY_NJ", label: "NY/NJ" },
  ny: { key: "NY_NJ", label: "NY/NJ" },
  nj: { key: "NY_NJ", label: "NY/NJ" },
  boston: { key: "MA", label: "MA" },
  philadelphia: { key: "PA", label: "PA" },
  dc: { key: "DC", label: "DC" },
  la: { key: "CA", label: "CA" },
  bay_area: { key: "CA", label: "CA" },
  san_diego: { key: "CA", label: "CA" },
  seattle: { key: "WA", label: "WA" },
  chicago: { key: "IL", label: "IL" },
  champaign: { key: "IL", label: "IL" },
  ann_arbor: { key: "MI", label: "MI" },
  columbus: { key: "OH", label: "OH" },
  dallas: { key: "TX", label: "TX" },
  houston: { key: "TX", label: "TX" },
  austin: { key: "TX", label: "TX" },
  atlanta: { key: "GA", label: "GA" },
  miami: { key: "FL", label: "FL" },
  orlando: { key: "FL", label: "FL" },
  other_city: { key: "OTHER", label: "其他" }
}

const STATE_FILTER_ORDER = [
  ALL_STATE_FILTER_KEY,
  "NY_NJ",
  "CA",
  "MA",
  "IL",
  "TX",
  "WA",
  "PA",
  "DC",
  "MI",
  "OH",
  "GA",
  "FL",
  "OTHER"
]

const DEFAULT_CITY_TREE = [
  {
    code: "US",
    label: "美国",
    groups: [
      {
        title: "热门城市",
        badge: "Hot",
        cities: [
          {
            key: DEFAULT_CITY_KEY,
            label: DEFAULT_CITY_LABEL,
            aliases: NY_NJ_ALIASES
          },
          { key: "boston", label: "波士顿", aliases: ["波士顿", "Boston", "Cambridge"] },
          { key: "chicago", label: "芝加哥", aliases: ["芝加哥", "Chicago"] },
          { key: "la", label: "洛杉矶", aliases: ["洛杉矶", "LA", "Los Angeles", "Irvine", "Pasadena"] },
          { key: "bay_area", label: "旧金山湾区", aliases: ["旧金山", "湾区", "San Francisco", "Bay Area", "San Jose", "Berkeley", "Palo Alto", "Oakland"] },
          { key: "seattle", label: "西雅图", aliases: ["西雅图", "Seattle", "Bellevue"] },
          { key: "other_city", label: "其他城市", aliases: ["其他", "其他城市", "Other City", "Other"] }
        ]
      },
      {
        title: "东北部",
        cities: [
          { key: DEFAULT_CITY_KEY, label: DEFAULT_CITY_LABEL, aliases: NY_NJ_ALIASES },
          { key: "boston", label: "波士顿", aliases: ["波士顿", "Boston", "Cambridge"] },
          { key: "philadelphia", label: "费城", aliases: ["费城", "Philadelphia", "Philly"] },
          { key: "dc", label: "华盛顿DC", aliases: ["华盛顿", "Washington DC", "DC", "Arlington"] }
        ]
      },
      {
        title: "西海岸",
        cities: [
          { key: "la", label: "洛杉矶", aliases: ["洛杉矶", "LA", "Los Angeles", "Irvine", "Pasadena"] },
          { key: "bay_area", label: "旧金山湾区", aliases: ["旧金山", "湾区", "San Francisco", "Bay Area", "San Jose", "Berkeley", "Palo Alto", "Oakland"] },
          { key: "seattle", label: "西雅图", aliases: ["西雅图", "Seattle", "Bellevue"] },
          { key: "san_diego", label: "圣地亚哥", aliases: ["圣地亚哥", "San Diego"] }
        ]
      },
      {
        title: "中部",
        cities: [
          { key: "chicago", label: "芝加哥", aliases: ["芝加哥", "Chicago"] },
          { key: "ann_arbor", label: "安娜堡", aliases: ["安娜堡", "Ann Arbor"] },
          { key: "champaign", label: "香槟", aliases: ["香槟", "Champaign", "Urbana"] },
          { key: "columbus", label: "哥伦布", aliases: ["哥伦布", "Columbus"] }
        ]
      },
      {
        title: "南部",
        cities: [
          { key: "dallas", label: "达拉斯", aliases: ["达拉斯", "Dallas"] },
          { key: "houston", label: "休斯顿", aliases: ["休斯顿", "Houston"] },
          { key: "atlanta", label: "亚特兰大", aliases: ["亚特兰大", "Atlanta"] },
          { key: "miami", label: "迈阿密", aliases: ["迈阿密", "Miami"] },
          { key: "orlando", label: "奥兰多", aliases: ["奥兰多", "Orlando"] },
          { key: "austin", label: "奥斯汀", aliases: ["奥斯汀", "Austin"] }
        ]
      }
    ]
  }
]

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function uniq(values) {
  const out = []
  const seen = new Set()
  ;(values || []).forEach(value => {
    const text = cleanText(value)
    if (!text || seen.has(text)) return
    seen.add(text)
    out.push(text)
  })
  return out
}

function normalizeCityKeyAlias(key) {
  const text = cleanText(key).toLowerCase()
  if (["ny", "nj", "new york", "new_york", "new jersey", "new-jersey", "new_jersey", "nyc", "jersey", "纽约", "新泽西"].includes(text)) {
    return DEFAULT_CITY_KEY
  }
  return cleanText(key)
}

function normalizeCity(city = {}) {
  const key = normalizeCityKeyAlias(city.key || city.id || city.value)
  const label = key === DEFAULT_CITY_KEY
    ? DEFAULT_CITY_LABEL
    : cleanText(city.label || city.name || city.title)
  if (!key || !label) return null
  return {
    key,
    label,
    aliases: uniq([
      label,
      ...(key === DEFAULT_CITY_KEY ? NY_NJ_ALIASES : []),
      ...(Array.isArray(city.aliases) ? city.aliases : [])
    ])
  }
}

function normalizeCityTree(source) {
  let tree = source
  if (tree && Array.isArray(tree.tree)) tree = tree.tree
  if (tree && Array.isArray(tree.countries)) tree = tree.countries
  if (!Array.isArray(tree) || !tree.length) tree = DEFAULT_CITY_TREE

  const normalized = tree.map(country => {
    const groups = (Array.isArray(country.groups) ? country.groups : []).map(group => {
      const seenCityKeys = new Set()
      const cities = (Array.isArray(group.cities) ? group.cities : [])
        .map(normalizeCity)
        .filter(Boolean)
        .filter(city => {
          if (seenCityKeys.has(city.key)) return false
          seenCityKeys.add(city.key)
          return true
        })
      return {
        title: cleanText(group.title || group.label || "城市"),
        badge: cleanText(group.badge),
        cities
      }
    }).filter(group => group.cities.length)

    return {
      code: cleanText(country.code || country.key || country.value || country.label),
      label: cleanText(country.label || country.name || country.title),
      groups
    }
  }).filter(country => country.label && country.groups.length)

  return normalized.length ? normalized : DEFAULT_CITY_TREE
}

function flattenCityTree(tree) {
  const map = new Map()
  normalizeCityTree(tree).forEach(country => {
    country.groups.forEach(group => {
      group.cities.forEach(city => {
        if (!map.has(city.key)) map.set(city.key, city)
      })
    })
  })
  return Array.from(map.values())
}

function getCityByKey(tree, key = DEFAULT_CITY_KEY) {
  const target = normalizeCityKeyAlias(key) || DEFAULT_CITY_KEY
  if (target === ALL_CITY_KEY) {
    return { key: ALL_CITY_KEY, label: ALL_CITY_LABEL, aliases: [] }
  }
  const cities = flattenCityTree(tree)
  return cities.find(city => city.key === target) ||
    cities.find(city => city.key === DEFAULT_CITY_KEY) ||
    { key: DEFAULT_CITY_KEY, label: DEFAULT_CITY_LABEL, aliases: [DEFAULT_CITY_LABEL] }
}

function getCitySnapshot(tree, key = DEFAULT_CITY_KEY) {
  const city = getCityByKey(tree, key)
  return {
    key: city.key,
    label: city.label,
    aliases: uniq(city.aliases || [city.label])
  }
}

function getCityStateFilter(city = {}) {
  const key = normalizeCityKeyAlias(city.key)
  return CITY_STATE_FILTERS[key] || { key: "OTHER", label: "其他" }
}

function normalizeStateFilterKey(value = "") {
  const raw = cleanText(value).toUpperCase()
  if (!raw || raw === "US" || raw === "USA" || raw === "ALL" || raw === "全部" || raw === "全部州") {
    return ALL_STATE_FILTER_KEY
  }
  if (raw === "NY" || raw === "NJ" || raw === "NY/NJ" || raw === "NY_NJ" || raw === "纽约" || raw === "新泽西") {
    return "NY_NJ"
  }
  if (raw === "OTHER" || raw === "其他") return "OTHER"
  return raw
}

function getPrimaryCityCountry(tree) {
  const normalized = normalizeCityTree(tree)
  return normalized.find(item => item.code === "US") || normalized[0] || null
}

function getStateFilterTabs(tree, activeCode = ALL_STATE_FILTER_KEY) {
  const country = getPrimaryCityCountry(tree)
  const activeKey = normalizeStateFilterKey(activeCode)
  const byKey = new Map()
  if (country) {
    country.groups.forEach(group => {
      ;(group.cities || []).forEach(city => {
        const state = getCityStateFilter(city)
        if (!byKey.has(state.key)) byKey.set(state.key, state)
      })
    })
  }
  const tabs = [
    { key: ALL_STATE_FILTER_KEY, label: "全部州" },
    ...Array.from(byKey.values())
  ].sort((a, b) => {
    const ai = STATE_FILTER_ORDER.indexOf(a.key)
    const bi = STATE_FILTER_ORDER.indexOf(b.key)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })
  return tabs.map(tab => ({
    code: tab.key,
    label: tab.label,
    className: tab.key === activeKey ? "active" : ""
  }))
}

function getCountryTabs(tree, activeCode = ALL_STATE_FILTER_KEY) {
  return getStateFilterTabs(tree, activeCode)
}

function getCountryGroups(tree, activeCode = ALL_STATE_FILTER_KEY, activeCityKey = DEFAULT_CITY_KEY, options = {}) {
  const country = getPrimaryCityCountry(tree)
  const stateFilterKey = normalizeStateFilterKey(activeCode)
  const keyword = cleanText(options.keyword).toLowerCase()
  const normalizedActiveCityKey = normalizeCityKeyAlias(activeCityKey) || DEFAULT_CITY_KEY
  const seenSearchKeys = new Set()
  return (country ? country.groups : []).map((group, groupIndex) => {
    const cities = options.includeAll && groupIndex === 0
      ? [{ key: ALL_CITY_KEY, label: ALL_CITY_LABEL, aliases: [] }, ...group.cities.filter(city => city.key !== ALL_CITY_KEY)]
      : group.cities
    const stateFilteredCities = stateFilterKey === ALL_STATE_FILTER_KEY
      ? cities
      : cities.filter(city => {
        if (city.key === ALL_CITY_KEY) return stateFilterKey === ALL_STATE_FILTER_KEY
        return getCityStateFilter(city).key === stateFilterKey
      })
    const visibleCities = keyword
      ? stateFilteredCities.filter(city => {
        if (!cityMatchesKeyword(city, keyword) || seenSearchKeys.has(city.key)) return false
        seenSearchKeys.add(city.key)
        return true
      })
      : stateFilteredCities
    return {
      ...group,
      cities: visibleCities.map(city => ({
        ...city,
        className: city.key === normalizedActiveCityKey ? "active" : ""
      }))
    }
  }).filter(group => group.cities.length)
}

function cityMatchesKeyword(city = {}, keyword = "") {
  const target = cleanText(keyword).toLowerCase()
  if (!target) return true
  return uniq([city.key, city.label, ...(city.aliases || [])])
    .some(value => cleanText(value).toLowerCase().includes(target))
}

function cityGroupsHaveResults(groups = []) {
  return (groups || []).some(group => Array.isArray(group.cities) && group.cities.length)
}

function getStoredCitySnapshot(storageKey, tree, fallbackKey = DEFAULT_CITY_KEY) {
  try {
    const stored = wx.getStorageSync(storageKey)
    const key = typeof stored === "object" && stored ? stored.key : stored
    return getCitySnapshot(tree, key || fallbackKey)
  } catch (e) {
    return getCitySnapshot(tree, fallbackKey)
  }
}

function isRideServiceCityKey(cityKey) {
  return RIDE_SERVICE_CITY_KEYS.includes(cleanText(cityKey)) ||
    normalizeCityKeyAlias(cityKey) === RIDE_SERVICE_CITY_KEY
}

function normalizeRideDisplayCityKey(cityKey) {
  const key = normalizeCityKeyAlias(cityKey)
  if (!key || key === ALL_CITY_KEY || key === RIDE_SERVICE_CITY_KEY) return RIDE_DEFAULT_CITY_KEY
  return key
}

function normalizeRideServiceCityKey(cityKey) {
  const key = normalizeCityKeyAlias(cityKey)
  if (!key || isRideServiceCityKey(key)) return RIDE_SERVICE_CITY_KEY
  return key
}

function getRideServiceCitySnapshot(city = {}) {
  const source = city && typeof city === "object" ? city : { key: city }
  const serviceKey = normalizeRideServiceCityKey(source.key || source.id || source.value)
  if (serviceKey === RIDE_SERVICE_CITY_KEY) {
    return {
      key: RIDE_SERVICE_CITY_KEY,
      label: RIDE_SERVICE_CITY_LABEL,
      aliases: uniq(NY_NJ_ALIASES)
    }
  }
  const label = cleanText(source.label || source.name || source.title || serviceKey)
  return {
    key: serviceKey,
    label,
    aliases: uniq([label, ...(Array.isArray(source.aliases) ? source.aliases : [])])
  }
}

function rideCityKeysMatch(leftKey, rightKey) {
  const left = cleanText(leftKey)
  const right = cleanText(rightKey)
  if (!left || !right) return false
  if (left === right) return true
  return isRideServiceCityKey(left) && isRideServiceCityKey(right)
}

function setStoredCitySnapshot(storageKey, city) {
  try {
    wx.setStorageSync(storageKey, {
      key: city.key,
      label: city.label,
      aliases: city.aliases || []
    })
  } catch (e) {}
}

function textMatchesCity(text, city = {}) {
  if (city && city.key === ALL_CITY_KEY) return true
  const target = cleanText(text).toLowerCase()
  if (!target) return false
  return uniq([city.label, ...(city.aliases || [])])
    .some(alias => target.includes(alias.toLowerCase()))
}

module.exports = {
  ALL_CITY_KEY,
  ALL_CITY_LABEL,
  DEFAULT_CITY_KEY,
  DEFAULT_CITY_LABEL,
  RIDE_DEFAULT_CITY_KEY,
  RIDE_SERVICE_CITY_KEY,
  RIDE_SERVICE_CITY_LABEL,
  RIDE_SERVICE_CITY_KEYS,
  DEFAULT_CITY_TREE,
  MARKET_CITY_STORAGE_KEY,
  RIDE_CITY_STORAGE_KEY,
  normalizeCityTree,
  flattenCityTree,
  getCityByKey,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  cityGroupsHaveResults,
  getStoredCitySnapshot,
  isRideServiceCityKey,
  normalizeRideDisplayCityKey,
  normalizeRideServiceCityKey,
  getRideServiceCitySnapshot,
  rideCityKeysMatch,
  setStoredCitySnapshot,
  textMatchesCity
}
