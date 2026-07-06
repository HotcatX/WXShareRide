const CITY_TREE_COLLECTION = 'CITY_TREE'

const REGION_TREE_STORAGE_KEY = 'city_region_tree_v2'
const REGION_TREE_CACHE_MS = 90 * 24 * 60 * 60 * 1000

const DEFAULT_REGION_TREE = [
  {
    key: 'NY',
    label: 'NY',
    groups: [
      {
        key: 'Queens',
        label: 'Queens',
        areas: ['LIC核心区', 'LIC非核心区', 'Queens深处']
      },
      {
        key: '曼岛上城',
        label: '曼岛上城',
        areas: ['哥大步行楼', 'Inwood', '96 St 周边']
      },
      {
        key: '曼岛下城',
        label: '曼岛下城',
        areas: ['华尔街']
      },
      {
        key: '曼岛中城',
        label: '曼岛中城',
        areas: ['中城西', '中城中', '中城东']
      }
    ]
  },
  {
    key: 'NJ',
    label: 'NJ',
    groups: [
      {
        key: 'Fort Lee',
        label: 'Fort Lee',
        areas: ['Fort Lee 核心区', 'Fort Lee 非核心区']
      },
      {
        key: 'JC',
        label: 'JC',
        areas: ['Newport', 'Grove St', 'JSQ']
      },
      {
        key: '其他区域',
        label: '其他区域',
        areas: ['Harrison', 'Union City', 'Hoboken']
      }
    ]
  }
]

const REGION_DISPLAY_CONFIG = {
  stateOrder: ["NY", "NJ"],
  stateLabels: {
    NJ: "新泽西",
    NY: "纽约"
  },
  groupOrder: {
    NJ: ["Fort Lee", "JC", "其他区域"],
    NY: ["曼岛上城", "曼岛中城", "曼岛下城", "Queens"]
  },
  groupLabels: {}
}

function cleanText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function uniq(values = []) {
  const out = []
  const seen = new Set()
  values.forEach(value => {
    const text = cleanText(value)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) return
    seen.add(key)
    out.push(text)
  })
  return out
}

function normalizeStateKey(value) {
  const text = cleanText(value).toUpperCase()
  if (text === 'NEW YORK' || text === '纽约') return 'NY'
  if (text === 'NEW JERSEY' || text === '新泽西') return 'NJ'
  return text
}

function normalizeGroup(groupKey, areas = []) {
  const key = cleanText(groupKey)
  if (!key || !Array.isArray(areas)) return null

  return {
    key,
    label: key,
    areas: uniq(areas)
  }
}

function normalizeCloudDoc(doc = {}) {
  const stateKey = normalizeStateKey(doc._id || doc.key || doc.state)
  if (!stateKey) return null

  const groups = []

  Object.keys(doc).forEach(field => {
    if (!field || field.startsWith('_')) return

    const value = doc[field]
    if (!Array.isArray(value)) return

    const group = normalizeGroup(field, value)
    if (group && group.areas.length) groups.push(group)
  })

  return {
    key: stateKey,
    label: stateKey,
    groups
  }
}

function normalizeState(state = {}) {
  const stateKey = normalizeStateKey(state.key || state._id || state.state)
  if (!stateKey) return null

  if (Array.isArray(state.groups)) {
    return {
      key: stateKey,
      label: cleanText(state.label) || stateKey,
      groups: state.groups
        .map(group => normalizeGroup(group.key || group.label, group.areas))
        .filter(group => group && group.areas.length)
    }
  }

  return normalizeCloudDoc(state)
}

function normalizeRegionTree(source) {
  let tree = source

  if (tree && Array.isArray(tree.data)) tree = tree.data
  if (tree && Array.isArray(tree.states)) tree = tree.states
  if (!Array.isArray(tree) || !tree.length) tree = DEFAULT_REGION_TREE

  const result = []
  const byState = new Map()

  tree.map(normalizeState).filter(Boolean).forEach(state => {
    if (!byState.has(state.key)) {
      byState.set(state.key, {
        key: state.key,
        label: state.label || state.key,
        groups: []
      })
      result.push(byState.get(state.key))
    }

    const target = byState.get(state.key)
    const groupMap = new Map(target.groups.map(group => [group.key, group]))

    state.groups.forEach(group => {
      if (!groupMap.has(group.key)) {
        const next = {
          key: group.key,
          label: group.label || group.key,
          areas: []
        }
        groupMap.set(group.key, next)
        target.groups.push(next)
      }

      const targetGroup = groupMap.get(group.key)
      targetGroup.areas = uniq([
        ...targetGroup.areas,
        ...group.areas
      ])
    })
  })

  function applyRegionDisplayConfig(tree = []) {
    const stateOrderMap = new Map(REGION_DISPLAY_CONFIG.stateOrder.map((key, index) => [key, index]))
  
    return tree
      .map(state => {
        const groupOrder = REGION_DISPLAY_CONFIG.groupOrder[state.key] || []
        const groupOrderMap = new Map(groupOrder.map((key, index) => [key, index]))
  
        return {
          ...state,
          label: REGION_DISPLAY_CONFIG.stateLabels[state.key] || state.label || state.key,
          groups: (state.groups || [])
            .map(group => ({
              ...group,
              label: (REGION_DISPLAY_CONFIG.groupLabels || {})[group.key] || group.label || group.key
            }))
            .sort((a, b) => {
              const ai = groupOrderMap.has(a.key) ? groupOrderMap.get(a.key) : 999
              const bi = groupOrderMap.has(b.key) ? groupOrderMap.get(b.key) : 999
              return ai - bi
            })
        }
      })
      .sort((a, b) => {
        const ai = stateOrderMap.has(a.key) ? stateOrderMap.get(a.key) : 999
        const bi = stateOrderMap.has(b.key) ? stateOrderMap.get(b.key) : 999
        return ai - bi
      })
  }

  return applyRegionDisplayConfig(result.length ? result : DEFAULT_REGION_TREE)
}

/**
 * cityTree 功能：第一层大地区
 * 以后代替原来的 getCitySnapshot / flattenCityTree / getCountryGroups
 */
function getCityOptions(tree) {
  return normalizeRegionTree(tree).map(state => ({
    key: state.key,
    label: state.label || state.key
  }))
}

function getCityByKey(tree, cityKey) {
  const key = normalizeStateKey(cityKey)
  return normalizeRegionTree(tree).find(state => state.key === key) || null
}

function getCitySnapshot(tree, cityKey) {
  const city = getCityByKey(tree, cityKey)
  if (!city) return null

  return {
    key: city.key,
    label: city.label || city.key
  }
}

function findState(tree, stateKey) {
  return getCityByKey(tree, stateKey)
}

function findGroup(tree, stateKey, groupKey) {
  const state = findState(tree, stateKey)
  if (!state) return null

  const key = cleanText(groupKey)
  const lower = key.toLowerCase()

  return (state.groups || []).find(group =>
    group.key === key ||
    cleanText(group.label).toLowerCase() === lower
  ) || null
}

function findArea(tree, stateKey, groupKey, areaName) {
  const group = findGroup(tree, stateKey, groupKey)
  if (!group) return ''

  const target = cleanText(areaName)
  const lower = target.toLowerCase()

  return (group.areas || []).find(area =>
    cleanText(area).toLowerCase() === lower
  ) || ''
}

function getStateOptions(tree) {
  return getCityOptions(tree)
}

function getGroupOptions(tree, stateKey) {
  const state = findState(tree, stateKey)
  if (!state) return []

  return (state.groups || []).map(group => ({
    key: group.key,
    label: group.label || group.key
  }))
}

function getAreaOptions(tree, stateKey, groupKey) {
  const group = findGroup(tree, stateKey, groupKey)
  if (!group) return []

  return (group.areas || []).map(area => ({
    key: area,
    label: area
  }))
}

function buildRegionDisplay(region = {}) {
  return [
    region.regionState,
    region.regionGroup,
    region.regionArea,
    region.buildingName
  ].map(cleanText).filter(Boolean).join(' / ')
}

function normalizeRegionSelection(input = {}) {
  const regionState = normalizeStateKey(
    input.regionState ||
    input.cityKey ||
    input.state ||
    input.stateKey
  )

  const regionGroup = cleanText(
    input.regionGroup ||
    input.group ||
    input.groupKey
  )

  const regionArea = cleanText(
    input.regionArea ||
    input.area ||
    input.areaKey
  )

  const buildingName = cleanText(input.buildingName)

  return {
    regionState,
    cityKey: regionState,
    cityLabel: regionState,
    regionGroup,
    regionArea,
    buildingName,
    regionDisplay: buildRegionDisplay({
      regionState,
      regionGroup,
      regionArea,
      buildingName
    })
  }
}

function validateRegionSelection(tree, input = {}) {
  const selection = normalizeRegionSelection(input)

  if (!selection.regionState) return false
  if (!selection.regionGroup) return false
  if (!selection.regionArea) return false

  return !!findArea(
    tree,
    selection.regionState,
    selection.regionGroup,
    selection.regionArea
  )
}

function normalizeUserRegion(user = {}) {
  const location = user.location && typeof user.location === 'object'
    ? user.location
    : {}

  return normalizeRegionSelection({
    regionState: user.regionState || user.cityKey || location.regionState || location.cityKey,
    regionGroup: user.regionGroup || location.regionGroup,
    regionArea: user.regionArea || location.regionArea,
    buildingName: user.buildingName || location.buildingName
  })
}

function readCachedRegionTree() {
  try {
    const cached = wx.getStorageSync(REGION_TREE_STORAGE_KEY)
    if (!cached || !cached.ts || !cached.tree) return null
    if (Date.now() - Number(cached.ts) > REGION_TREE_CACHE_MS) return null
    return normalizeRegionTree(cached.tree)
  } catch (e) {
    return null
  }
}

function writeCachedRegionTree(tree) {
  try {
    wx.setStorageSync(REGION_TREE_STORAGE_KEY, {
      ts: Date.now(),
      tree: normalizeRegionTree(tree)
    })
  } catch (e) {}
}

async function loadCityTreeDocsFromDB() {
  const db = wx.cloud.database()
  const pageSize = 100
  let skip = 0
  let all = []

  while (true) {
    const res = await db.collection(CITY_TREE_COLLECTION)
      .skip(skip)
      .limit(pageSize)
      .get()

    const rows = res.data || []
    all = all.concat(rows)

    if (rows.length < pageSize) break
    skip += pageSize
  }

  return all
}

async function loadRegionTreeConfig(options = {}) {
  const cached = options.useCache !== false ? readCachedRegionTree() : null

  try {
    const docs = await loadCityTreeDocsFromDB()
    const tree = normalizeRegionTree(docs)

    writeCachedRegionTree(tree)

    return {
      tree,
      fromCloud: true,
      fromCache: false
    }
  } catch (e) {
    return {
      tree: cached || normalizeRegionTree(DEFAULT_REGION_TREE),
      fromCloud: false,
      fromCache: !!cached,
      error: e
    }
  }
}

// 为了替代原 cityTree.js，保留一个同名方法
async function loadCityTreeConfig(options = {}) {
  const result = await loadRegionTreeConfig(options)
  return result.tree
}

module.exports = {
  CITY_TREE_COLLECTION,
  REGION_TREE_STORAGE_KEY,
  REGION_TREE_CACHE_MS,
  DEFAULT_REGION_TREE,

  cleanText,
  normalizeStateKey,
  normalizeRegionTree,

  // cityTree 替代功能
  loadCityTreeConfig,
  getCityOptions,
  getCityByKey,
  getCitySnapshot,

  // regionTree 功能
  findState,
  findGroup,
  findArea,
  getStateOptions,
  getGroupOptions,
  getAreaOptions,

  normalizeRegionSelection,
  normalizeUserRegion,
  validateRegionSelection,
  buildRegionDisplay,

  readCachedRegionTree,
  writeCachedRegionTree,
  loadRegionTreeConfig
}