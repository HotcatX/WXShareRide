const ALL_AREA_KEY = "all"
const ALL_AREA_LABEL = "全部区域"
const REGION_TREE_STORAGE_KEY = "market_region_tree_v4"
const REGION_TREE_CACHE_MS = 90 * 24 * 60 * 60 * 1000

const STATE_CODES = [
  "NY_NJ", "CA", "MA", "PA", "CT", "RI", "NH", "VT", "ME",
  "MD", "VA", "DC", "DE", "NC", "SC", "GA", "FL", "IL", "MI",
  "OH", "IN", "WI", "MN", "IA", "MO", "KS", "NE", "TX", "WA",
  "OR", "AZ", "CO", "UT", "NV", "NM", "TN", "KY", "AL", "LA",
  "OK", "AR", "MS", "ID", "MT", "WY", "ND", "SD", "AK", "HI", "WV"
]

const CORE_STATE_LABELS = {
  NY_NJ: "纽约/新泽西"
}

const CORE_STATE_AREAS = {
  NY_NJ: [
    { key: "ny_manhattan_uptown", label: "曼哈顿上城", aliases: ["上城", "Uptown", "Upper Manhattan"] },
    { key: "ny_manhattan_midtown", label: "曼哈顿中城", aliases: ["中城", "Midtown"] },
    { key: "ny_manhattan_downtown", label: "曼哈顿下城", aliases: ["下城", "Downtown", "Lower Manhattan"] },
    { key: "ny_lic_queens", label: "LIC/Queens", aliases: ["LIC", "Queens", "Long Island City", "LIC / Queens"] },
    { key: "nj_fort_lee", label: "Fortlee", aliases: ["Fort Lee", "FL"] },
    { key: "nj_newport", label: "Newport", aliases: ["New Port"] },
    { key: "nj_grove_st", label: "Grove St", aliases: ["Grove Street", "Grove"] },
    { key: "nj_jsq", label: "JSQ", aliases: ["Journal Square"] },
    { key: "nj_harrison", label: "Harrison", aliases: [] },
    { key: "ny_nj_other", label: "其他", aliases: ["其他NY", "NY其他", "其他NJ", "NJ其他", "Other NY", "Other NJ", "Other"] }
  ]
}

function cleanText(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return ""
  return String(value).replace(/\s+/g, " ").trim()
}

function slugKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
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

function buildAllStateArea(stateKey) {
  const key = cleanText(stateKey).toUpperCase()
  return {
    key: `${key.toLowerCase()}_all`,
    label: ALL_AREA_LABEL,
    aliases: [key, `${key}州`, `全${key}州`]
  }
}

function buildDefaultRegionTree() {
  return STATE_CODES.map(code => ({
    key: code,
    label: CORE_STATE_LABELS[code] || code,
    areas: CORE_STATE_AREAS[code] || [buildAllStateArea(code)]
  }))
}

const DEFAULT_REGION_TREE = buildDefaultRegionTree()

function normalizeArea(area, stateKey) {
  if (!area) return null
  if (typeof area === "string") {
    const label = cleanText(area)
    if (!label) return null
    return {
      key: `${stateKey.toLowerCase()}_${slugKey(label) || "area"}`,
      label,
      aliases: [label]
    }
  }

  const label = cleanText(area.label || area.name || area.title || area.value || area.key)
  if (!label) return null
  const key = cleanText(area.key || area.id || area.value) || `${stateKey.toLowerCase()}_${slugKey(label) || "area"}`
  return {
    key,
    label,
    aliases: uniq([label, ...(Array.isArray(area.aliases) ? area.aliases : [])])
  }
}

function normalizeState(state = {}) {
  const rawKey = cleanText(state.key || state.code || state.value || state.label || state.name)
  const key = normalizeStateKey(rawKey)
  if (!key) return null
  const label = CORE_STATE_LABELS[key] || cleanText(state.label || state.name || state.title || key) || key
  let areas = []
  if (Array.isArray(state.areas)) {
    areas = state.areas.map(area => normalizeArea(area, key)).filter(Boolean)
  }
  if (!areas.length) areas = [buildAllStateArea(key)]

  const deduped = []
  const seen = new Set()
  areas.forEach(area => {
    const areaKey = cleanText(area.key)
    if (!areaKey || seen.has(areaKey)) return
    seen.add(areaKey)
    deduped.push({
      ...area,
      stateKey: key,
      aliases: uniq([area.label, ...(area.aliases || [])])
    })
  })

  return {
    key,
    label,
    areas: deduped
  }
}

function normalizeRegionTree(source) {
  let tree = source
  if (tree && Array.isArray(tree.states)) tree = tree.states
  if (!Array.isArray(tree) || !tree.length) tree = DEFAULT_REGION_TREE

  const normalized = tree.map(normalizeState).filter(Boolean)
  const merged = []
  const byKey = new Map()
  normalized.forEach(state => {
    const existing = byKey.get(state.key)
    if (!existing) {
      const next = {
        ...state,
        label: CORE_STATE_LABELS[state.key] || state.label,
        areas: []
      }
      byKey.set(state.key, next)
      merged.push(next)
    }
    const target = byKey.get(state.key)
    const seen = new Set((target.areas || []).map(area => area.key))
    ;(state.areas || []).forEach(area => {
      if (!area.key || seen.has(area.key)) return
      seen.add(area.key)
      target.areas.push({
        ...area,
        stateKey: target.key
      })
    })
  })
  return merged.length ? merged : DEFAULT_REGION_TREE
}

function flattenAreas(tree) {
  const rows = []
  normalizeRegionTree(tree).forEach(state => {
    state.areas.forEach(area => {
      rows.push({
        ...area,
        stateKey: state.key,
        stateLabel: state.label
      })
    })
  })
  return rows
}

function findState(tree, stateKey) {
  const key = normalizeStateKey(stateKey)
  const states = normalizeRegionTree(tree)
  return states.find(state =>
    state.key === key ||
    cleanText(state.label).toUpperCase() === key
  ) || null
}

function normalizeStateKey(value) {
  const key = cleanText(value).toUpperCase()
  if (key === "NY" || key === "NJ" || key === "NY/NJ" || key === "纽约" || key === "新泽西" || key === "纽约/新泽西") {
    return "NY_NJ"
  }
  return key
}

function findArea(state, areaKeyOrLabel) {
  if (!state) return null
  const target = cleanText(areaKeyOrLabel)
  const lower = target.toLowerCase()
  if (!target) return null
  return (state.areas || []).find(area =>
    area.key === target ||
    cleanText(area.label).toLowerCase() === lower ||
    (area.aliases || []).some(alias => cleanText(alias).toLowerCase() === lower)
  ) || null
}

function buildRegionDisplay(stateLabel, areaLabel, buildingName = "") {
  return [stateLabel, areaLabel, buildingName]
    .map(cleanText)
    .filter(Boolean)
    .join(" / ")
}

function buildRegionBaseDisplay(stateLabel, areaLabel) {
  return buildRegionDisplay(stateLabel, areaLabel)
}

function resolveRegionSelection(tree, input = {}) {
  const stateKey = normalizeStateKey(input.stateKey || input.regionState || input.state)
  if (!stateKey) return null
  const state = findState(tree, stateKey)
  if (!state) return null

  const areaKey = cleanText(input.areaKey || input.regionKey)
  const areaLabel = cleanText(input.regionArea || input.areaLabel || input.area)
  if (!areaKey && !areaLabel) return null
  const area = findArea(state, areaKey) || findArea(state, areaLabel)
  if (!area) return null

  const buildingName = cleanText(input.buildingName)
  return {
    stateKey: state.key,
    stateLabel: state.label,
    areaKey: area.key,
    areaLabel: area.label,
    regionKey: area.key,
    buildingName,
    baseDisplay: buildRegionBaseDisplay(state.label, area.label),
    display: buildRegionDisplay(state.label, area.label, buildingName),
    aliases: uniq([area.label, ...(area.aliases || [])])
  }
}

function normalizeUserRegion(user = {}, tree = DEFAULT_REGION_TREE) {
  const location = user.location && typeof user.location === "object" ? user.location : {}
  const areaLabel = cleanText(user.regionArea || location.regionArea || location.areaLabel)
  const stateKey = normalizeStateKey(user.regionState || location.regionState || location.state)
  const areaKey = cleanText(user.regionKey || location.regionKey)
  const buildingCandidate = cleanText(
    user.buildingName ||
    location.buildingName
  )

  if (!stateKey || !areaKey || !areaLabel) return null

  const selection = resolveRegionSelection(tree, {
    stateKey,
    areaKey,
    areaLabel
  })

  const buildingName = buildingCandidate
  if (!selection) {
    const displayAreaLabel = areaKey.toLowerCase().endsWith("_all") ? ALL_AREA_LABEL : areaLabel
    return {
      stateKey,
      stateLabel: stateKey,
      areaKey,
      areaLabel: displayAreaLabel,
      regionKey: areaKey,
      buildingName,
      baseDisplay: buildRegionBaseDisplay(stateKey, displayAreaLabel),
      display: buildRegionDisplay(stateKey, displayAreaLabel, buildingName),
      aliases: [displayAreaLabel]
    }
  }

  const displayAreaLabel = areaKey.toLowerCase().endsWith("_all") ? ALL_AREA_LABEL : selection.areaLabel
  return {
    ...selection,
    areaLabel: displayAreaLabel,
    buildingName,
    display: buildRegionDisplay(selection.stateLabel, displayAreaLabel, buildingName)
  }
}

function buildItemRegionAreaText(item = {}) {
  const location = item.location && typeof item.location === "object" ? item.location : {}
  const areaKey = cleanText(item.regionKey || location.regionKey).toLowerCase()
  if (areaKey && areaKey.endsWith("_all")) return ALL_AREA_LABEL
  return cleanText(
    item.regionArea ||
    item.areaLabel ||
    location.regionArea ||
    location.areaLabel
  ) || "区域未填"
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

module.exports = {
  ALL_AREA_KEY,
  ALL_AREA_LABEL,
  REGION_TREE_STORAGE_KEY,
  REGION_TREE_CACHE_MS,
  DEFAULT_REGION_TREE,
  cleanText,
  normalizeRegionTree,
  flattenAreas,
  findState,
  findArea,
  buildRegionDisplay,
  buildRegionBaseDisplay,
  resolveRegionSelection,
  normalizeUserRegion,
  buildItemRegionAreaText,
  readCachedRegionTree,
  writeCachedRegionTree
}
