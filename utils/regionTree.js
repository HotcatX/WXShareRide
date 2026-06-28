const ALL_AREA_KEY = "all"
const ALL_AREA_LABEL = "全部区域"
const REGION_TREE_STORAGE_KEY = "market_region_tree_v8"
const REGION_TREE_CACHE_MS = 90 * 24 * 60 * 60 * 1000
const AREA_PANEL_ALL_KEY = "all"

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
    { key: "ny_columbia_walkup", label: "哥大步行楼", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_uptown", groupLabel: "曼哈顿上城", aliases: ["哥大步行楼", "Columbia Walkup"] },
    { key: "ny_inwood", label: "Inwood", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_uptown", groupLabel: "曼哈顿上城", aliases: ["Inwood"] },
    { key: "ny_96_st", label: "96街周边", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_uptown", groupLabel: "曼哈顿上城", aliases: ["96街", "96街周边", "96th St"] },
    { key: "ny_midtown_west", label: "中城西", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_midtown", groupLabel: "曼哈顿中城", aliases: ["Midtown West"] },
    { key: "ny_midtown_central", label: "中城中", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_midtown", groupLabel: "曼哈顿中城", aliases: ["Midtown Central"] },
    { key: "ny_midtown_east", label: "中城东", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_midtown", groupLabel: "曼哈顿中城", aliases: ["Midtown East"] },
    { key: "ny_manhattan_downtown", label: "曼哈顿下城", sectionKey: "ny", sectionLabel: "纽约", groupKey: "manhattan_downtown", groupLabel: "曼哈顿下城", aliases: ["下城", "Downtown", "Lower Manhattan"] },
    { key: "ny_lic_queens", label: "LIC/Queens", sectionKey: "ny", sectionLabel: "纽约", groupKey: "queens", groupLabel: "Queens", aliases: ["LIC", "Queens", "Long Island City", "LIC / Queens"] },
    { key: "ny_other", label: "其他", sectionKey: "ny", sectionLabel: "纽约", groupKey: "ny_other", groupLabel: "其他", aliases: ["其他NY", "NY其他", "Other NY"] },
    { key: "nj_fort_lee", label: "Fortlee", sectionKey: "nj", sectionLabel: "NJ", groupKey: "nj_north", groupLabel: "新泽西北方", aliases: ["Fort Lee", "FL"] },
    { key: "nj_newport", label: "Newport", sectionKey: "nj", sectionLabel: "NJ", groupKey: "nj_south", groupLabel: "新泽西南方", aliases: ["New Port"] },
    { key: "nj_grove_st", label: "Grove St", sectionKey: "nj", sectionLabel: "NJ", groupKey: "nj_south", groupLabel: "新泽西南方", aliases: ["Grove Street", "Grove"] },
    { key: "nj_jsq", label: "JSQ", sectionKey: "nj", sectionLabel: "NJ", groupKey: "nj_south", groupLabel: "新泽西南方", aliases: ["Journal Square"] },
    { key: "nj_harrison", label: "Harrison", sectionKey: "nj", sectionLabel: "NJ", groupKey: "nj_deep", groupLabel: "新泽西深处", aliases: [] },
    { key: "nj_other", label: "其他", sectionKey: "nj", sectionLabel: "NJ", groupKey: "nj_other", groupLabel: "其他", aliases: ["其他NJ", "NJ其他", "Other NJ"] }
  ]
}

const AREA_SECTION_LABELS = {
  nj: "NJ",
  ny: "纽约"
}

const AREA_GROUP_LABELS = {
  ny: "纽约",
  nj: "NJ",
  manhattan_uptown: "曼哈顿上城",
  manhattan_midtown: "曼哈顿中城",
  manhattan_downtown: "曼哈顿下城",
  queens: "Queens",
  ny_other: "其他",
  nj_north: "新泽西北方",
  nj_south: "新泽西南方",
  nj_deep: "新泽西深处",
  nj_other: "其他"
}

const AREA_SECTION_ORDER = ["ny", "nj", "other"]
const AREA_SECTION_TAB_ORDER = ["all", "ny", "nj", "other"]
const AREA_SECTION_TAB_LABELS = {
  all: ALL_AREA_LABEL,
  nj: "新泽西",
  ny: "纽约",
  other: "其他"
}
const AREA_GROUP_ORDER = [
  "nj_north",
  "nj_south",
  "nj_deep",
  "nj_other",
  "nj",
  "manhattan_uptown",
  "manhattan_midtown",
  "manhattan_downtown",
  "queens",
  "ny_other",
  "other"
]

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

function getDefaultAreaSectionKey(areaKey) {
  const key = cleanText(areaKey).toLowerCase()
  if (key.startsWith("nj_")) return "nj"
  if (key.startsWith("ny_")) return "ny"
  return ""
}

function getDefaultAreaGroupKey(areaKey) {
  const key = cleanText(areaKey).toLowerCase()
  if (key.startsWith("nj_")) return "nj"
  if (["ny_columbia_walkup", "ny_inwood", "ny_96_st"].includes(key)) return "manhattan_uptown"
  if (["ny_midtown_west", "ny_midtown_central", "ny_midtown_east"].includes(key)) return "manhattan_midtown"
  if (key === "ny_manhattan_downtown") return "manhattan_downtown"
  if (key === "ny_lic_queens") return "queens"
  if (key === "ny_other") return "ny_other"
  if (key.startsWith("ny_")) return "ny"
  return ""
}

function normalizeAreaSectionKey(sectionKey, areaKey) {
  const inferred = getDefaultAreaSectionKey(areaKey)
  if (inferred) return inferred
  const raw = cleanText(sectionKey).toLowerCase()
  if (raw === "ny" || raw === "new york" || raw === "纽约") return "ny"
  if (raw === "nj" || raw === "new jersey" || raw === "新泽西") return "nj"
  return raw
}

function getAreaPanelSectionKey(area = {}) {
  const areaKey = cleanText(area && area.key)
  if (!areaKey || areaKey === ALL_AREA_KEY || areaKey.endsWith("_all")) return AREA_PANEL_ALL_KEY
  return normalizeAreaSectionKey(area.sectionKey, areaKey) ||
    normalizeAreaGroupKey(area.groupKey, areaKey) ||
    "other"
}

function getAreaPanelSectionLabel(sectionKey, area = {}) {
  return AREA_SECTION_TAB_LABELS[sectionKey] ||
    cleanText(area.sectionLabel || area.sectionName || area.parentLabel) ||
    AREA_SECTION_LABELS[sectionKey] ||
    sectionKey
}

function resolveAreaPanelSectionKey(areas = [], activeSectionKey = "", activeAreaKeys = []) {
  const list = Array.isArray(areas) ? areas : []
  const available = new Set(list.map(getAreaPanelSectionKey).filter(Boolean))
  const requested = cleanText(activeSectionKey).toLowerCase()
  if (requested && available.has(requested)) return requested
  const selectedKeys = new Set((Array.isArray(activeAreaKeys) ? activeAreaKeys : [activeAreaKeys]).map(cleanText).filter(Boolean))
  const selectedArea = list.find(area => selectedKeys.has(cleanText(area && area.key)))
  if (selectedArea) return getAreaPanelSectionKey(selectedArea)
  if (available.has(AREA_PANEL_ALL_KEY)) return AREA_PANEL_ALL_KEY
  if (available.has("ny")) return "ny"
  if (available.has("nj")) return "nj"
  return Array.from(available)[0] || ""
}

function buildAreaSectionTabs(areas = [], activeSectionKey = "", activeAreaKeys = []) {
  const list = Array.isArray(areas) ? areas : []
  const byKey = new Map()
  list.forEach(area => {
    const key = getAreaPanelSectionKey(area)
    if (!key || byKey.has(key)) return
    byKey.set(key, {
      key,
      label: getAreaPanelSectionLabel(key, area)
    })
  })
  const selectedKey = resolveAreaPanelSectionKey(list, activeSectionKey, activeAreaKeys)
  return Array.from(byKey.values()).sort((a, b) => {
    const ai = AREA_SECTION_TAB_ORDER.indexOf(a.key)
    const bi = AREA_SECTION_TAB_ORDER.indexOf(b.key)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  }).map(tab => ({
    ...tab,
    className: tab.key === selectedKey ? "active" : ""
  }))
}

function normalizeAreaGroupKey(groupKey, areaKey) {
  const raw = cleanText(groupKey).toLowerCase()
  if (raw && raw !== "new york" && raw !== "纽约" && raw !== "new jersey" && raw !== "新泽西") return raw
  const inferred = getDefaultAreaGroupKey(areaKey)
  if (inferred) return inferred
  if (raw === "ny" || raw === "new york" || raw === "纽约") return "ny"
  if (raw === "nj" || raw === "new jersey" || raw === "新泽西") return "nj"
  const key = cleanText(areaKey).toLowerCase()
  if (key.startsWith("ny_")) return "ny"
  if (key.startsWith("nj_")) return "nj"
  return raw
}

function normalizeArea(area, stateKey) {
  if (!area) return null
  if (typeof area === "string") {
    const label = cleanText(area)
    if (!label) return null
    const key = `${stateKey.toLowerCase()}_${slugKey(label) || "area"}`
    const groupKey = normalizeAreaGroupKey("", key)
    const sectionKey = normalizeAreaSectionKey("", key)
    return {
      key,
      label,
      sectionKey,
      sectionLabel: AREA_SECTION_LABELS[sectionKey] || "",
      groupKey,
      groupLabel: AREA_GROUP_LABELS[groupKey] || "",
      aliases: [label]
    }
  }

  const label = cleanText(area.label || area.name || area.title || area.value || area.key)
  if (!label) return null
  const key = cleanText(area.key || area.id || area.value) || `${stateKey.toLowerCase()}_${slugKey(label) || "area"}`
  const groupKey = normalizeAreaGroupKey(area.groupKey || area.group || area.sectionKey, key)
  const sectionKey = normalizeAreaSectionKey(area.sectionKey || area.section || area.parentKey, key)
  return {
    key,
    label,
    sectionKey,
    sectionLabel: cleanText(area.sectionLabel || area.sectionName || area.parentLabel) || AREA_SECTION_LABELS[sectionKey] || "",
    groupKey,
    groupLabel: AREA_GROUP_LABELS[groupKey] || cleanText(area.groupLabel || area.groupName || area.sectionLabel) || "",
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

function buildAreaSections(areas = [], options = {}) {
  const sections = []
  const bySectionKey = new Map()
  const visibleSectionKey = cleanText(options.visibleSectionKey).toLowerCase()

  const getSection = (sectionKey, sectionLabel, className = "", displayTitle = sectionLabel) => {
    const key = sectionKey || "other"
    if (!bySectionKey.has(key)) {
      const section = {
        key,
        title: displayTitle || "",
        sectionLabel: sectionLabel || "",
        className,
        groups: [],
        areas: []
      }
      bySectionKey.set(key, section)
      sections.push(section)
    }
    return bySectionKey.get(key)
  }

  const getGroup = (section, groupKey, groupLabel) => {
    const key = groupKey || `${section.key}_plain`
    let group = section.groups.find(item => item.key === key)
    if (!group) {
      const parentLabel = section.sectionLabel || section.title
      group = {
        key,
        title: groupLabel || "",
        showTitle: !!(groupLabel && groupLabel !== parentLabel),
        areas: []
      }
      section.groups.push(group)
    }
    return group
  }

  ;(Array.isArray(areas) ? areas : []).forEach(area => {
    const areaKey = cleanText(area && area.key)
    if (!areaKey) return
    if (areaKey === ALL_AREA_KEY || areaKey.endsWith("_all")) {
      if (visibleSectionKey) return
      sections.push({
        key: areaKey,
        title: "",
        className: "area-section-all",
        groups: [{
          key: `${areaKey}_group`,
          title: "",
          areas: [area]
        }],
        areas: [area]
      })
      return
    }

    const groupKey = normalizeAreaGroupKey(area.groupKey, areaKey) || "other"
    const groupLabel = cleanText(area.groupLabel) || AREA_GROUP_LABELS[groupKey] || ""
    const sectionKey = normalizeAreaSectionKey(area.sectionKey, areaKey) || groupKey || "other"
    if (visibleSectionKey && sectionKey !== visibleSectionKey) return
    const sectionLabel = cleanText(area.sectionLabel) || AREA_SECTION_LABELS[sectionKey] || ""
    const displayTitle = visibleSectionKey === sectionKey ? "" : sectionLabel
    const section = getSection(sectionKey, sectionLabel, sectionLabel ? "area-section-block" : "area-section-plain", displayTitle)
    const group = getGroup(section, groupKey, groupLabel)
    group.areas.push(area)
    section.areas.push(area)
  })

  const sortedSections = sections.filter(section => section.areas.length).sort((a, b) => {
    if (a.className === "area-section-all") return -1
    if (b.className === "area-section-all") return 1
    const ai = AREA_SECTION_ORDER.indexOf(a.key)
    const bi = AREA_SECTION_ORDER.indexOf(b.key)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })

  sortedSections.forEach(section => {
    section.groups.sort((a, b) => {
      const ai = AREA_GROUP_ORDER.indexOf(a.key)
      const bi = AREA_GROUP_ORDER.indexOf(b.key)
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
    })
  })

  return sortedSections
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
  buildAreaSectionTabs,
  buildAreaSections,
  resolveAreaPanelSectionKey,
  resolveRegionSelection,
  normalizeUserRegion,
  buildItemRegionAreaText,
  readCachedRegionTree,
  writeCachedRegionTree
}
