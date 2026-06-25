const ALL_CITY_KEY = "all"
const ALL_CITY_LABEL = "全部"
const DEFAULT_CITY_KEY = "ny_nj"
const DEFAULT_CITY_LABEL = "纽约/新泽西"
const MARKET_CITY_STORAGE_KEY = "market_active_city_v2"
const RIDE_CITY_STORAGE_KEY = "ride_active_city_v1"

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
            key: "ny_nj",
            label: "纽约/新泽西",
            aliases: ["纽约", "新泽西", "New York", "NYC", "Manhattan", "Brooklyn", "Queens", "Flushing", "Jersey", "NJ", "Newark", "Hoboken", "Jersey City", "Fort Lee", "Edison", "New Brunswick", "Princeton"]
          },
          { key: "boston", label: "波士顿", aliases: ["波士顿", "Boston", "Cambridge"] },
          { key: "chicago", label: "芝加哥", aliases: ["芝加哥", "Chicago"] },
          { key: "la", label: "洛杉矶", aliases: ["洛杉矶", "LA", "Los Angeles", "Irvine", "Pasadena"] },
          { key: "bay_area", label: "旧金山湾区", aliases: ["旧金山", "湾区", "San Francisco", "Bay Area", "San Jose", "Berkeley", "Palo Alto", "Oakland"] },
          { key: "seattle", label: "西雅图", aliases: ["西雅图", "Seattle", "Bellevue"] }
        ]
      },
      {
        title: "东北部",
        cities: [
          { key: "ny_nj", label: "纽约/新泽西", aliases: ["纽约", "新泽西", "New York", "NYC", "NJ", "Jersey", "Fort Lee", "Jersey City", "Hoboken"] },
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

function normalizeCity(city = {}) {
  const key = cleanText(city.key || city.id || city.value)
  const label = cleanText(city.label || city.name || city.title)
  if (!key || !label) return null
  return {
    key,
    label,
    aliases: uniq([label, ...(Array.isArray(city.aliases) ? city.aliases : [])])
  }
}

function normalizeCityTree(source) {
  let tree = source
  if (tree && Array.isArray(tree.tree)) tree = tree.tree
  if (tree && Array.isArray(tree.countries)) tree = tree.countries
  if (!Array.isArray(tree) || !tree.length) tree = DEFAULT_CITY_TREE

  const normalized = tree.map(country => {
    const groups = (Array.isArray(country.groups) ? country.groups : []).map(group => {
      const cities = (Array.isArray(group.cities) ? group.cities : [])
        .map(normalizeCity)
        .filter(Boolean)
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
  const target = cleanText(key) || DEFAULT_CITY_KEY
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

function getCountryTabs(tree, activeCode = "US") {
  return normalizeCityTree(tree).map(country => ({
    code: country.code,
    label: country.label,
    className: country.code === activeCode ? "active" : ""
  }))
}

function getCountryGroups(tree, activeCode = "US", activeCityKey = DEFAULT_CITY_KEY, options = {}) {
  const normalized = normalizeCityTree(tree)
  const country = normalized.find(item => item.code === activeCode) || normalized[0]
  return (country ? country.groups : []).map((group, groupIndex) => {
    const cities = options.includeAll && groupIndex === 0
      ? [{ key: ALL_CITY_KEY, label: ALL_CITY_LABEL, aliases: [] }, ...group.cities.filter(city => city.key !== ALL_CITY_KEY)]
      : group.cities
    return {
      ...group,
      cities: cities.map(city => ({
        ...city,
        className: city.key === activeCityKey ? "active" : ""
      }))
    }
  })
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
  DEFAULT_CITY_TREE,
  MARKET_CITY_STORAGE_KEY,
  RIDE_CITY_STORAGE_KEY,
  normalizeCityTree,
  flattenCityTree,
  getCityByKey,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  getStoredCitySnapshot,
  setStoredCitySnapshot,
  textMatchesCity
}
