const cloud = require("wx-server-sdk")
const crypto = require("crypto")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const GOODS_COLLECTION = "market_goods"
const FILES_COLLECTION = "MarketFiles"
const ADS_COLLECTION = "market_ads"
const AD_EVENTS_COLLECTION = "market_ad_events"
const VIEW_EVENTS_COLLECTION = "market_view_events"
const USER_COLLECTION = "userInfo"
const IMPORT_BATCH_COLLECTION = "MarketImportBatches"
const ADMIN_TEMPLATE_COLLECTION = "MarketAdminTemplates"
const ADMIN_SETTINGS_COLLECTION = "MarketAdminSettings"
const ADMIN_SESSION_COLLECTION = "MarketAdminSessions"
const ADMIN_BULK_PASSWORD_DOC_ID = "bulk_publish_password"
<<<<<<< HEAD
=======
const PUBLIC_CONFIG_DOC_ID = "default"
const PUBLIC_CONFIG_COLLECTIONS = new Set(["cityTree", "regionTree"])
>>>>>>> 184e3d19a3c40e80a00744bc03f3614508a50b61
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_PICKUP_MONTHS = 2
const MAX_SUBLET_MONTHS = 18
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const AD_DEFAULT_LIMIT = 20
const AD_MAX_LIMIT = 50
const DISTANCE_SORT_BATCH_SIZE = 100
const DISTANCE_SORT_SCAN_LIMIT = 2000
const VISIBLE_STATUSES = new Set(["", "online"])
const MUTABLE_STATUSES = new Set(["online", "offline", "sold"])
const LISTING_TYPES = new Set(["goods", "sublet"])
const SUBLET_CATEGORY_OPTIONS = ["Studio", "1B1B", "2B1B", "2B2B", "3B2B", "其他"]
const AD_TARGET_TYPES = new Set(["page", "tab", "miniProgram", "web", "copy", "contact", "serviceChat", "copyWechat", "none"])
const MARKET_VIEW_DAILY_LIMIT = 10
let viewEventsCollectionReady = false

const LIST_FIELDS = {
  _id: true,
  _openid: true,
  listingType: true,
  title: true,
  price: true,
  category: true,
  cityKey: true,
  cityLabel: true,
  region: true,
  regionState: true,
  regionArea: true,
  regionKey: true,
  regionDisplay: true,
  buildingName: true,
  location: true,
  condition: true,
  desc: true,
  imageFileID: true,
  thumbFileID: true,
  imageFileIDs: true,
  thumbFileIDs: true,
  hasImage: true,
  pickupStartDate: true,
  pickupEndDate: true,
  pickupRangeText: true,
  expireTime: true,
  expiresAtText: true,
  status: true,
  createTime: true,
  updateTime: true,
  buyerOpenid: true,
  managedByAdmin: true,
  managedByOpenid: true,
  managedSource: true,
  adminBatchId: true,
  adminExternalId: true,
  sellerName: true,
  sellerWechat: true,
  sellerPhone: true,
  sellerAvatar: true,
  sellerNote: true,
  wantCount: true,
  viewCount: true,
  availableStartDate: true,
  leaseEndDate: true,
  deposit: true,
  roomType: true,
  housingType: true,
  furnished: true,
  utilitiesIncluded: true,
  genderPreference: true,
  roommateCount: true
}

const AD_FIELDS = {
  _id: true,
  status: true,
  placement: true,
  title: true,
  subtitle: true,
  badgeText: true,
  ctaText: true,
  imageFileID: true,
  thumbFileID: true,
  imageUrl: true,
  targetType: true,
  targetPath: true,
  targetUrl: true,
  targetAppId: true,
  targetExtraData: true,
  contactSessionFrom: true,
  contactMessageTitle: true,
  contactMessagePath: true,
  contactMessageImg: true,
  showMessageCard: true,
  serviceCorpId: true,
  serviceUrl: true,
  wechatId: true,
  targetWechat: true,
  target: true,
  weight: true,
  priority: true,
  startAt: true,
  endAt: true,
  startAtMs: true,
  endAtMs: true,
  createTime: true,
  updateTime: true
}

function ok(data = {}) {
  return { ok: true, ...data }
}

function fail(error, extra = {}) {
  return { ok: false, error, message: error, ...extra }
}

function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function normalizeBooleanFlag(value) {
  if (value === true || value === 1 || value === "1") return true
  return normalizeText(value).toLowerCase() === "true"
}

function getNewYorkDateKey(nowMs = Date.now()) {
  try {
    const parts = {}
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(nowMs)).forEach(part => {
      if (part.type !== "literal") parts[part.type] = part.value
    })
    if (parts.year && parts.month && parts.day) return `${parts.year}-${parts.month}-${parts.day}`
  } catch (e) {}
  return new Date(nowMs).toISOString().slice(0, 10)
}

function normalizeListingType(value) {
  const type = normalizeText(value).toLowerCase()
  return LISTING_TYPES.has(type) ? type : "goods"
}

function normalizeSubletCategory(value) {
  const text = normalizeText(value)
  if (!text) return ""
  const key = text.replace(/[\s/_-]+/g, "").toLowerCase()
  const map = {
    studio: "Studio",
    "1b1b": "1B1B",
    "2b1b": "2B1B",
    "2b2b": "2B2B",
    "3b2b": "3B2B",
    other: "其他",
    others: "其他",
    "其他": "其他"
  }
  return map[key] || (SUBLET_CATEGORY_OPTIONS.includes(text) ? text : "其他")
}

function normalizeListingCategory(value, listingType) {
  if (normalizeListingType(listingType) === "sublet") return normalizeSubletCategory(value) || "其他"
  return normalizeText(value) || "其他"
}

function normalizeCityKey(value) {
  const raw = normalizeText(value).toLowerCase()
  if (["纽约", "新泽西", "纽约/新泽西"].includes(raw)) return "ny_nj"
  const key = raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_/-]/g, "").toLowerCase()
  if (["ny", "nj", "nyc", "ny/nj", "new_york", "new_jersey", "new-jersey", "jersey"].includes(key)) return "ny_nj"
  return key.replace(/\//g, "_")
}

function normalizeRegionKeys(value) {
  const source = Array.isArray(value) ? value : [value]
  const out = []
  const seen = new Set()
  source.forEach(item => {
    const key = normalizeText(item)
    if (!key || key === "all" || seen.has(key)) return
    seen.add(key)
    out.push(key)
  })
  return out
}

function getEventListingType(event = {}) {
  const filters = event.filters || {}
  return normalizeListingType(event.listingType || filters.listingType)
}

function normalizeFileID(fileID) {
  const value = normalizeText(fileID)
  return value.startsWith("cloud://") ? value : ""
}

function normalizeTargetType(value) {
  const raw = normalizeText(value)
  if (AD_TARGET_TYPES.has(raw)) return raw
  const lower = raw.toLowerCase()
  if (lower === "miniprogram") return "miniProgram"
  if (["servicechat", "customerservice", "wecom", "wechatservice"].includes(lower)) return "serviceChat"
  if (["wechat", "copywechat"].includes(lower)) return "copyWechat"
  if (AD_TARGET_TYPES.has(lower)) return lower
  return "page"
}

function uniqFileIDs(fileIDs) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeOptionalAmount(value) {
  const text = normalizeText(value)
  if (!text) return { ok: true, value: "" }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return { ok: false }
  return { ok: true, value: Number(n.toFixed(2)) }
}

function normalizeOptionalInteger(value) {
  const text = normalizeText(value)
  if (!text) return { ok: true, value: "" }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return { ok: false }
  return { ok: true, value: Math.floor(n) }
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value
  const text = normalizeText(value).toLowerCase()
  if (!text) return false
  if (["true", "1", "yes", "y", "是", "有", "带", "include", "included"].includes(text)) return true
  if (["false", "0", "no", "n", "否", "无", "不带", "exclude", "excluded"].includes(text)) return false
  return !!value
}

function hasLatLng(location = {}) {
  return toFiniteNumber(location.lat ?? location.latitude) !== null &&
    toFiniteNumber(location.lng ?? location.longitude) !== null
}

function normalizeLatLng(location = {}) {
  const lat = toFiniteNumber(location.lat ?? location.latitude)
  const lng = toFiniteNumber(location.lng ?? location.longitude)
  if (lat === null || lng === null) return null
  return { lat, lng }
}

function distanceMiles(a = {}, b = {}) {
  const p1 = normalizeLatLng(a)
  const p2 = normalizeLatLng(b)
  if (!p1 || !p2) return null

  const toRad = deg => deg * Math.PI / 180
  const earthMiles = 3958.8
  const dLat = toRad(p2.lat - p1.lat)
  const dLng = toRad(p2.lng - p1.lng)
  const s1 = Math.sin(dLat / 2)
  const s2 = Math.sin(dLng / 2)
  const h = s1 * s1 + Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * s2 * s2
  return earthMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function timestampMs(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : 0
  }
  if (value.$date) return timestampMs(value.$date)
  if (value.$numberLong) {
    const n = Number(value.$numberLong)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function isTimeWindowActive(item = {}, nowMs = Date.now()) {
  const startAtMs = Number(item.startAtMs) || timestampMs(item.startAt)
  const endAtMs = Number(item.endAtMs) || timestampMs(item.endAt)
  if (startAtMs && nowMs < startAtMs) return false
  if (endAtMs && nowMs > endAtMs) return false
  return true
}

function getDistanceSortOrigin(event = {}) {
  const sort = event.sort || {}
  const by = normalizeText(sort.by || sort.type || event.sortBy).toLowerCase()
  if (by !== "distance" && by !== "nearest") return null
  return normalizeLatLng(sort.origin || event.origin || event.myLocation || {})
}

function buildLocationForSave(regionStr, location = {}, meta = {}) {
  const displayName = normalizeText(location.displayName || location.name || location.address || regionStr)
  if (!displayName) return {}

  const regionState = normalizeText(meta.regionState || location.regionState)
  const regionArea = normalizeText(meta.regionArea || meta.areaLabel || location.regionArea || location.areaLabel)
  const regionKey = normalizeText(meta.regionKey || location.regionKey)
  const buildingName = normalizeText(meta.buildingName || location.buildingName)
  const cityKey = normalizeText(meta.cityKey || location.cityKey)
  const cityLabel = normalizeText(meta.cityLabel || location.cityLabel)
  return {
    displayName,
    name: normalizeText(location.name || displayName),
    buildingName,
    cityKey,
    cityLabel,
    regionState,
    regionArea,
    areaLabel: regionArea,
    regionKey,
    city: normalizeText(location.city),
    state: normalizeText(location.state || regionState),
    zip: normalizeText(location.zip),
    country: normalizeText(location.country || "US"),
    lat: toFiniteNumber(location.lat ?? location.latitude),
    lng: toFiniteNumber(location.lng ?? location.longitude),
    address: normalizeText(location.address),
    source: normalizeText(location.source || "manual"),
    region: normalizeText(location.region || location.bigregion || regionStr),
    coordinateAccuracy: normalizeText(location.coordinateAccuracy),
    provider: normalizeText(location.provider),
    updatedAtMs: Date.now()
  }
}

async function upsertUserRegion(openid, item = {}) {
  if (!openid || !item) return
  const regionState = normalizeText(item.regionState)
  const regionArea = normalizeText(item.regionArea)
  const regionKey = normalizeText(item.regionKey)
  if (!regionState || !regionArea || !regionKey) return

  const buildingName = normalizeText(item.buildingName)
  const cityKey = normalizeText(item.cityKey)
  const cityLabel = normalizeText(item.cityLabel)
  const regionDisplay = normalizeText(item.regionDisplay || item.region)
  const bigregion = [regionState, regionArea].filter(Boolean).join(" / ")
  const saveLocation = buildLocationForSave(regionDisplay || bigregion, item.location || {}, {
    regionState,
    regionArea,
    regionKey,
    buildingName,
    cityKey,
    cityLabel
  })

  const data = {
    cityKey,
    cityLabel,
    bigregion,
    address: buildingName,
    buildingName,
    regionState,
    regionArea,
    regionKey,
    regionDisplay: regionDisplay || [regionState, regionArea, buildingName].filter(Boolean).join(" / "),
    bigregionUpdatedAt: db.serverDate()
  }
  if (saveLocation.displayName) data.location = saveLocation

  try {
    const q = await db.collection(USER_COLLECTION).where({ _openid: openid }).limit(1).get()
    const row = (q.data || [])[0]
    if (row && row._id) {
      await db.collection(USER_COLLECTION).doc(row._id).update({ data })
    } else {
      await db.collection(USER_COLLECTION).add({
        data: {
          _openid: openid,
          ...data,
          createTime: db.serverDate()
        }
      })
    }
  } catch (e) {
    console.error("[marketApi] upsert userInfo failed:", e)
  }
}

function parseDateOnly(value) {
  const text = normalizeText(value)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

function formatDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== day) d.setDate(0)
  return d
}

function buildPickupWindow(payload = {}, oldItem = {}) {
  const listingType = normalizeListingType(payload.listingType || oldItem.listingType)
  const maxMonths = listingType === "sublet" ? MAX_SUBLET_MONTHS : MAX_PICKUP_MONTHS
  const today = startOfDay(new Date())
  const maxEnd = addMonths(today, maxMonths)
  const fallbackEnd = new Date(today.getTime())
  fallbackEnd.setDate(fallbackEnd.getDate() + 14)
  const safeFallbackEnd = fallbackEnd > maxEnd ? maxEnd : fallbackEnd

  const start = parseDateOnly(payload.pickupStartDate || oldItem.pickupStartDate) || today
  const end = parseDateOnly(payload.pickupEndDate || oldItem.pickupEndDate || oldItem.expiresAtText) || safeFallbackEnd

  if (end < start) return { ok: false, error: "pickup_end_before_start" }
  if (end > maxEnd) return { ok: false, error: listingType === "sublet" ? "lease_range_over_18_months" : "pickup_range_over_2_months" }

  const pickupStartDate = formatDateOnly(start)
  const pickupEndDate = formatDateOnly(end)
  return {
    ok: true,
    pickupStartDate,
    pickupEndDate,
    pickupRangeText: `${pickupStartDate} 至 ${pickupEndDate}`,
    expireTime: endOfDay(end).getTime(),
    expiresAtText: pickupEndDate
  }
}

function collectMarketFiles(payload = {}) {
  const files = []
  uniqFileIDs([payload.imageFileID, ...(Array.isArray(payload.imageFileIDs) ? payload.imageFileIDs : [])]).forEach(fileID => {
    files.push({ fileID, type: "image", folder: "market" })
  })
  uniqFileIDs([payload.thumbFileID, ...(Array.isArray(payload.thumbFileIDs) ? payload.thumbFileIDs : [])]).forEach(fileID => {
    files.push({ fileID, type: "thumb", folder: "market_thumb" })
  })

  const seen = new Set()
  return files.filter(file => {
    if (!file.fileID || seen.has(file.fileID)) return false
    seen.add(file.fileID)
    return true
  })
}

function collectFileIDs(payload = {}) {
  return uniqFileIDs([
    payload.imageFileID,
    payload.thumbFileID,
    ...(Array.isArray(payload.imageFileIDs) ? payload.imageFileIDs : []),
    ...(Array.isArray(payload.thumbFileIDs) ? payload.thumbFileIDs : [])
  ])
}

function marketFileDocId(fileID) {
  return crypto.createHash("sha1").update(String(fileID)).digest("hex")
}

async function attachMarketFiles(files, goodsId, openid) {
  if (!files.length || !goodsId || !openid) return
  const nowMs = Date.now()
  const col = db.collection(FILES_COLLECTION)

  await Promise.all(files.map(file => {
    return col.doc(marketFileDocId(file.fileID)).set({
      data: {
        fileID: file.fileID,
        type: file.type || "image",
        folder: file.folder || "",
        goodsId,
        status: "attached",
        _openid: openid,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        attachedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    }).catch(e => {
      console.error("[marketApi] attach MarketFiles failed:", e)
    })
  }))
}

async function markFilesDeleted(fileIDs, openid, goodsId) {
  if (!fileIDs.length) return
  try {
    for (let i = 0; i < fileIDs.length; i += 50) {
      const chunk = fileIDs.slice(i, i + 50)
      await db.collection(FILES_COLLECTION).where({
        fileID: _.in(chunk),
        _openid: openid
      }).update({
        data: {
          status: "deleted",
          deletedGoodsId: goodsId,
          deletedAt: db.serverDate(),
          updatedAt: db.serverDate(),
          updatedAtMs: Date.now()
        }
      })
    }
  } catch (e) {
    console.error("[marketApi] mark MarketFiles deleted failed:", e)
  }
}

async function deleteFiles(fileIDs) {
  const deleted = []
  const failed = []
  for (let i = 0; i < fileIDs.length; i += 50) {
    const chunk = fileIDs.slice(i, i + 50)
    try {
      const res = await cloud.deleteFile({ fileList: chunk })
      ;(res.fileList || []).forEach(row => {
        if (row.status === 0) deleted.push(row.fileID)
        else failed.push({ fileID: row.fileID, status: row.status, errMsg: row.errMsg || "" })
      })
    } catch (e) {
      chunk.forEach(fileID => {
        failed.push({ fileID, errMsg: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "delete_failed" })
      })
    }
  }
  return { deleted, failed }
}

function normalizeClientRequestId(value) {
  return normalizeText(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)
}

function buildIdempotentGoodsId(openid, clientRequestId) {
  const requestId = normalizeClientRequestId(clientRequestId)
  if (!openid || !requestId) return ""
  const hash = crypto.createHash("sha1").update(`${openid}:${requestId}`).digest("hex")
  return `market_${hash}`
}

function isVisibleMarketDoc(item = {}) {
  const status = normalizeText(item.status).toLowerCase()
  if (!VISIBLE_STATUSES.has(status)) return false
  const expireTime = Number(item.expireTime) || 0
  return !(expireTime && expireTime <= Date.now())
}

function formatPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : "0"
}

function formatAmountText(value, suffix = "") {
  const text = normalizeText(value)
  if (!text && text !== "0") return ""
  const n = Number(value)
  if (!Number.isFinite(n)) return text
  const amount = n.toFixed(n % 1 === 0 ? 0 : 2)
  return suffix ? `${amount}${suffix}` : amount
}

function buildLeaseText(item = {}) {
  const start = normalizeText(item.availableStartDate || item.pickupStartDate)
  const end = normalizeText(item.leaseEndDate || item.pickupEndDate || item.expiresAtText)
  if (start && end) return `${start} 至 ${end}`
  if (start) return `${start} 可入住`
  if (end) return `${end} 前有效`
  return "联系发布者确认"
}

function buildSubletMetaList(item = {}) {
  const rows = []
  const depositText = formatAmountText(item.deposit)
  const roomType = normalizeSubletCategory(item.roomType || item.category)
  if (depositText) rows.push({ label: "押金", value: `$ ${depositText}` })
  if (item.housingType) rows.push({ label: "房源类型", value: normalizeText(item.housingType) })
  if (roomType) rows.push({ label: "房间类型", value: roomType })
  rows.push({ label: "家具", value: item.furnished ? "带家具" : "未标注" })
  rows.push({ label: "水电网", value: item.utilitiesIncluded ? "已包含" : "未包含/未标注" })
  if (item.genderPreference) rows.push({ label: "室友要求", value: normalizeText(item.genderPreference) })
  const roommateCountText = formatAmountText(item.roommateCount)
  if (roommateCountText) rows.push({ label: "室友数", value: `${roommateCountText} 人` })
  return rows
}

function buildSubletSummary(item = {}) {
  const parts = [
    item.housingType,
    normalizeSubletCategory(item.roomType || item.category),
    item.furnished ? "带家具" : "",
    item.utilitiesIncluded ? "包水电网" : ""
  ].map(normalizeText).filter(Boolean)
  return parts.slice(0, 3).join(" · ")
}

function normalizeMarketItem(item = {}) {
  const sourceItem = { ...item }
  delete sourceItem.postDate
  delete sourceItem.postDateDisplay
  delete sourceItem.buyer_openid
  delete sourceItem.isSold
  delete sourceItem.sold

  const listingType = normalizeListingType(item.listingType)
  const title = normalizeText(item.title) || (listingType === "sublet" ? "未命名房源" : "未命名商品")
  const priceText = formatPrice(item.price)
  const status = normalizeText(item.status) || "online"
  const category = normalizeListingCategory(
    listingType === "sublet" ? (item.category || item.roomType) : item.category,
    listingType
  )
  const roomType = listingType === "sublet" ? category : normalizeText(item.roomType)
  const availableStartDate = normalizeText(item.availableStartDate || item.pickupStartDate)
  const leaseEndDate = normalizeText(item.leaseEndDate || item.pickupEndDate || item.expiresAtText)
  const depositText = formatAmountText(item.deposit)
  const normalizedSubletItem = listingType === "sublet" ? { ...item, category, roomType } : item
  const subletMetaList = listingType === "sublet" ? buildSubletMetaList(normalizedSubletItem) : []
  const subletSummary = listingType === "sublet" ? buildSubletSummary(normalizedSubletItem) : ""
  const leaseText = listingType === "sublet" ? buildLeaseText({ ...normalizedSubletItem, availableStartDate, leaseEndDate }) : ""
  const defaultCondition = listingType === "sublet"
    ? (subletSummary || availableStartDate || "转租")
    : "成色未填"
  const defaultDesc = listingType === "sublet" ? "发布者暂未填写详细描述。" : "卖家暂未填写详细描述。"
  return {
    ...sourceItem,
    _id: item._id,
    id: item._id,
    listingType,
    title,
    titleDisplay: title,
    price: Number(item.price) || 0,
    priceText,
    priceDisplay: priceText,
    priceDisplayWithUnit: listingType === "sublet" ? `${priceText}/月` : priceText,
    priceUnitText: listingType === "sublet" ? "月租" : "价格",
    category,
    categoryDisplay: category || (listingType === "sublet" ? "转租" : "二手"),
    cityKey: normalizeCityKey(item.cityKey),
    cityLabel: normalizeText(item.cityLabel),
    region: normalizeText(item.region),
    regionState: normalizeText(item.regionState || item.location?.regionState),
    regionArea: normalizeText(item.regionArea || item.location?.regionArea || item.location?.areaLabel),
    regionKey: normalizeText(item.regionKey || item.location?.regionKey),
    regionDisplay: normalizeText(item.regionDisplay || item.region),
    buildingName: normalizeText(item.buildingName || item.location?.buildingName),
    location: item.location || {},
    condition: normalizeText(item.condition) || defaultCondition,
    conditionText: normalizeText(item.condition) || defaultCondition,
    conditionDisplay: normalizeText(item.condition) || defaultCondition,
    desc: item.desc || "",
    descDisplay: item.desc || defaultDesc,
    imageFileID: normalizeFileID(item.imageFileID),
    thumbFileID: normalizeFileID(item.thumbFileID),
    imageFileIDs: Array.isArray(item.imageFileIDs) ? item.imageFileIDs.map(normalizeFileID).filter(Boolean) : [],
    thumbFileIDs: Array.isArray(item.thumbFileIDs) ? item.thumbFileIDs.map(normalizeFileID).filter(Boolean) : [],
    hasImage: !!(item.hasImage || item.imageFileID || item.thumbFileID || (Array.isArray(item.imageFileIDs) && item.imageFileIDs.length)),
    pickupStartDate: item.pickupStartDate || "",
    pickupEndDate: item.pickupEndDate || item.expiresAtText || "",
    pickupRangeText: item.pickupRangeText || "",
    pickupText: listingType === "sublet"
      ? (leaseText || "联系发布者确认")
      : (item.pickupRangeText || item.pickupEndDate || item.expiresAtText || "联系卖家确认"),
    locationText: item.pickup || item.region || (listingType === "sublet" ? "发布者未填写" : "卖家未填写"),
    expireTime: Number(item.expireTime) || 0,
    expiresAtText: item.expiresAtText || "",
    status,
    wantCount: Number(item.wantCount) || 0,
    wantCountText: listingType === "sublet" ? `${Number(item.wantCount) || 0} 人关注` : `${Number(item.wantCount) || 0} 人想要`,
    viewCount: Number(item.viewCount) || 0,
    viewCountText: `${Number(item.viewCount) || 0} 人浏览`,
    pickup: item.pickup || item.region || "",
    imageSrc: listingType === "sublet" ? "/images/sublease.png" : "/images/market.png",
    thumbUrl: "",
    imageUrls: [],
    availableStartDate,
    leaseEndDate,
    leaseText,
    deposit: item.deposit || "",
    depositText: depositText ? `$ ${depositText}` : "",
    roomType,
    housingType: normalizeText(item.housingType),
    furnished: item.furnished === true,
    furnishedText: item.furnished ? "带家具" : "未标注",
    utilitiesIncluded: item.utilitiesIncluded === true,
    utilitiesIncludedText: item.utilitiesIncluded ? "已包含" : "未包含/未标注",
    genderPreference: normalizeText(item.genderPreference),
    genderPreferenceDisplay: normalizeText(item.genderPreference) || "不限",
    roommateCount: item.roommateCount || "",
    roommateCountText: item.roommateCount || item.roommateCount === 0 ? `${item.roommateCount} 人` : "",
    subletMetaList,
    hasSubletMeta: subletMetaList.length > 0,
    subletSummary
  }
}

function normalizeMarketAd(ad = {}) {
  const target = ad.target && typeof ad.target === "object" ? ad.target : {}
  const targetType = normalizeTargetType(ad.targetType || target.type)
  const title = normalizeText(ad.title) || "校园推荐"
  const subtitle = normalizeText(ad.subtitle || ad.desc)
  const thumbFileID = normalizeFileID(ad.thumbFileID)
  const imageFileID = normalizeFileID(ad.imageFileID)
  return {
    _id: ad._id,
    id: ad._id,
    status: normalizeText(ad.status) || "online",
    placement: normalizeText(ad.placement || "market_feed"),
    title,
    subtitle,
    badgeText: normalizeText(ad.badgeText) || "广告",
    ctaText: normalizeText(ad.ctaText) || "查看",
    imageFileID,
    thumbFileID,
    imageUrl: normalizeText(ad.imageUrl),
    targetType,
    targetPath: normalizeText(ad.targetPath || target.path),
    targetUrl: normalizeText(ad.targetUrl || target.url),
    targetAppId: normalizeText(ad.targetAppId || target.appId),
    targetExtraData: ad.targetExtraData || target.extraData || {},
    contactSessionFrom: normalizeText(ad.contactSessionFrom || target.sessionFrom),
    contactMessageTitle: normalizeText(ad.contactMessageTitle || target.messageTitle || title),
    contactMessagePath: normalizeText(ad.contactMessagePath || target.messagePath || target.path),
    contactMessageImg: normalizeText(ad.contactMessageImg || target.messageImg || ad.imageUrl),
    showMessageCard: ad.showMessageCard !== false,
    serviceCorpId: normalizeText(ad.serviceCorpId || target.corpId),
    serviceUrl: normalizeText(ad.serviceUrl || target.serviceUrl || target.url),
    wechatId: normalizeText(ad.wechatId || ad.targetWechat || target.wechatId || target.wechat),
    weight: Math.max(1, Number(ad.weight) || 1),
    priority: Number(ad.priority) || 0,
    startAtMs: Number(ad.startAtMs) || timestampMs(ad.startAt),
    endAtMs: Number(ad.endAtMs) || timestampMs(ad.endAt),
    createTime: ad.createTime || null,
    updateTime: ad.updateTime || null,
    imageSrc: normalizeText(ad.imageUrl) || imageFileID || thumbFileID || "/images/market.png",
    hasImage: !!(ad.imageUrl || imageFileID || thumbFileID)
  }
}

function primaryFileID(item = {}, options = {}) {
  const detail = !!options.detail
  if (detail) {
    return item.imageFileID ||
      (Array.isArray(item.imageFileIDs) ? item.imageFileIDs[0] : "") ||
      ""
  }
  return item.thumbFileID ||
    item.imageFileID ||
    (Array.isArray(item.thumbFileIDs) ? item.thumbFileIDs[0] : "") ||
    (Array.isArray(item.imageFileIDs) ? item.imageFileIDs[0] : "") ||
    ""
}

async function enrichImageUrls(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).map(normalizeMarketItem)
  const detail = !!options.detail
  const fileIDs = []

  list.forEach(item => {
    const primary = primaryFileID(item, { detail })
    if (primary) fileIDs.push(primary)
    if (detail) {
      item.imageFileIDs.forEach(fileID => fileIDs.push(fileID))
    }
  })

  const uniq = Array.from(new Set(fileIDs.filter(Boolean)))
  const urlMap = {}
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50)
    try {
      const res = await cloud.getTempFileURL({ fileList: chunk })
      ;(res.fileList || []).forEach(row => {
        if (row.fileID && row.tempFileURL) urlMap[row.fileID] = row.tempFileURL
      })
    } catch (e) {
      console.error("[marketApi] getTempFileURL failed:", e)
    }
  }

  return list.map(item => {
    const primary = primaryFileID(item, { detail })
    const imageUrls = detail
      ? item.imageFileIDs
        .map(fileID => urlMap[fileID])
        .filter((url, index, arr) => url && arr.indexOf(url) === index)
      : []
    const imageSrc = (primary && urlMap[primary]) || primary || (item.listingType === "sublet" ? "/images/sublease.png" : "/images/market.png")
    return {
      ...item,
      thumbUrl: primary ? (urlMap[primary] || "") : "",
      imageSrc,
      imageUrl: detail ? (imageUrls[0] || "") : imageSrc,
      imageUrls
    }
  })
}

async function enrichAdImageUrls(ads) {
  const list = (Array.isArray(ads) ? ads : []).map(normalizeMarketAd)
  const fileIDs = Array.from(new Set(
    list
      .map(ad => ad.thumbFileID || ad.imageFileID)
      .filter(Boolean)
  ))
  const urlMap = {}
  for (let i = 0; i < fileIDs.length; i += 50) {
    const chunk = fileIDs.slice(i, i + 50)
    try {
      const res = await cloud.getTempFileURL({ fileList: chunk })
      ;(res.fileList || []).forEach(row => {
        if (row.fileID && row.tempFileURL) urlMap[row.fileID] = row.tempFileURL
      })
    } catch (e) {
      console.error("[marketApi] get ad tempFileURL failed:", e)
    }
  }
  return list.map(ad => {
    const key = ad.thumbFileID || ad.imageFileID
    const imageSrc = ad.imageUrl || (key && urlMap[key]) || ad.imageSrc
    return {
      ...ad,
      thumbUrl: key ? (urlMap[key] || "") : "",
      imageSrc,
      hasImage: !!imageSrc
    }
  })
}

function normalizePayloadForSave(payload = {}, oldItem = {}) {
  const data = {}
  const listingType = normalizeListingType(payload.listingType !== undefined ? payload.listingType : oldItem.listingType)

  if (payload.listingType !== undefined) {
    data.listingType = listingType
  }

  if (payload.title !== undefined) {
    data.title = normalizeText(payload.title)
    if (!data.title) return fail("missing_title")
  }

  if (payload.price !== undefined) {
    const price = Number(payload.price)
    if (Number.isNaN(price) || price < 0) return fail("invalid_price")
    data.price = price
  }

  if (payload.category !== undefined) data.category = normalizeListingCategory(payload.category, listingType)
  if (payload.cityKey !== undefined) data.cityKey = normalizeCityKey(payload.cityKey)
  if (payload.cityLabel !== undefined) data.cityLabel = normalizeText(payload.cityLabel)
  if (data.cityKey === "ny_nj") data.cityLabel = "纽约/新泽西"
  if (payload.region !== undefined) data.region = normalizeText(payload.region)
  if (payload.regionState !== undefined) data.regionState = normalizeText(payload.regionState)
  if (payload.regionArea !== undefined) data.regionArea = normalizeText(payload.regionArea)
  if (payload.regionKey !== undefined) data.regionKey = normalizeText(payload.regionKey)
  if (payload.regionDisplay !== undefined) data.regionDisplay = normalizeText(payload.regionDisplay)
  if (payload.buildingName !== undefined) data.buildingName = normalizeText(payload.buildingName)
  if (
    payload.location !== undefined ||
    payload.region !== undefined ||
    payload.regionState !== undefined ||
    payload.regionArea !== undefined ||
    payload.regionKey !== undefined ||
    payload.buildingName !== undefined
  ) {
    const meta = {
      cityKey: data.cityKey || oldItem.cityKey || payload.location?.cityKey,
      cityLabel: data.cityLabel || oldItem.cityLabel || payload.location?.cityLabel,
      regionState: data.regionState || oldItem.regionState || payload.location?.regionState,
      regionArea: data.regionArea || oldItem.regionArea || payload.location?.regionArea || payload.location?.areaLabel,
      regionKey: data.regionKey || oldItem.regionKey || payload.location?.regionKey,
      buildingName: data.buildingName || oldItem.buildingName || payload.location?.buildingName
    }
    data.location = buildLocationForSave(data.region || oldItem.region || "", payload.location || oldItem.location || {}, meta)
  }
  if (payload.condition !== undefined) data.condition = normalizeText(payload.condition) || "99新"
  if (payload.desc !== undefined) data.desc = String(payload.desc || "")
  if (payload.sellerName !== undefined) data.sellerName = normalizeText(payload.sellerName)
  if (payload.sellerWechat !== undefined) data.sellerWechat = normalizeText(payload.sellerWechat)
  if (payload.sellerPhone !== undefined) data.sellerPhone = normalizeText(payload.sellerPhone)
  if (payload.sellerAvatar !== undefined) data.sellerAvatar = normalizeFileID(payload.sellerAvatar) || normalizeText(payload.sellerAvatar)
  if (payload.sellerNote !== undefined) data.sellerNote = normalizeText(payload.sellerNote)

  if (payload.availableStartDate !== undefined) data.availableStartDate = normalizeText(payload.availableStartDate)
  if (payload.leaseEndDate !== undefined) data.leaseEndDate = normalizeText(payload.leaseEndDate)
  if (payload.deposit !== undefined) {
    const deposit = normalizeOptionalAmount(payload.deposit)
    if (!deposit.ok) return fail("invalid_deposit")
    data.deposit = deposit.value
  }
  if (payload.roomType !== undefined) {
    data.roomType = listingType === "sublet" ? normalizeSubletCategory(payload.roomType) : normalizeText(payload.roomType)
  }
  if (payload.housingType !== undefined) data.housingType = normalizeText(payload.housingType)
  if (payload.furnished !== undefined) data.furnished = normalizeBoolean(payload.furnished)
  if (payload.utilitiesIncluded !== undefined) data.utilitiesIncluded = normalizeBoolean(payload.utilitiesIncluded)
  if (payload.genderPreference !== undefined) data.genderPreference = normalizeText(payload.genderPreference)
  if (payload.roommateCount !== undefined) {
    const roommateCount = normalizeOptionalInteger(payload.roommateCount)
    if (!roommateCount.ok) return fail("invalid_roommate_count")
    data.roommateCount = roommateCount.value
  }

  if (payload.status !== undefined) {
    const status = normalizeText(payload.status || "online")
    if (!MUTABLE_STATUSES.has(status)) return fail("invalid_status")
    data.status = status
  }

  const pickupWindow = buildPickupWindow(payload, oldItem)
  if (!pickupWindow.ok) return fail(pickupWindow.error)
  Object.assign(data, pickupWindow)
  if (listingType === "sublet") {
    data.availableStartDate = data.availableStartDate || pickupWindow.pickupStartDate
    data.leaseEndDate = data.leaseEndDate || pickupWindow.pickupEndDate
    data.category = normalizeListingCategory(data.category || payload.category || oldItem.category || data.roomType || oldItem.roomType, listingType)
    data.roomType = normalizeSubletCategory(data.roomType || payload.roomType || oldItem.roomType || data.category || oldItem.category) || data.category
    data.condition = data.condition || "转租"
  }

  const nextImageFiles = uniqFileIDs([
    payload.imageFileID !== undefined ? payload.imageFileID : oldItem.imageFileID,
    ...(Array.isArray(payload.imageFileIDs) ? payload.imageFileIDs : (oldItem.imageFileIDs || []))
  ])
  const nextThumbFiles = uniqFileIDs([
    payload.thumbFileID !== undefined ? payload.thumbFileID : oldItem.thumbFileID,
    ...(Array.isArray(payload.thumbFileIDs) ? payload.thumbFileIDs : (oldItem.thumbFileIDs || []))
  ])

  data.imageFileID = nextImageFiles[0] || ""
  data.imageFileIDs = nextImageFiles
  data.thumbFileID = nextThumbFiles[0] || ""
  data.thumbFileIDs = nextThumbFiles
  data.hasImage = nextImageFiles.length > 0

  return ok({ data })
}

function buildCreateItemForSave(payload = {}, openid = "", options = {}) {
  const title = normalizeText(payload.title)
  const listingType = normalizeListingType(payload.listingType)
  const category = normalizeListingCategory(payload.category, listingType)
  const region = normalizeText(payload.region)
  const regionState = normalizeText(payload.regionState)
  const regionArea = normalizeText(payload.regionArea)
  const regionKey = normalizeText(payload.regionKey)
  if (!title || !category || !region || !regionState || !regionArea || !regionKey) return fail("missing_required_fields")

  const normalized = normalizePayloadForSave(payload)
  if (!normalized.ok) return normalized

  const clientRequestId = normalizeClientRequestId(payload.clientRequestId)
  const idempotentGoodsId = buildIdempotentGoodsId(openid, clientRequestId)
  const data = {
    ...normalized.data,
    listingType: normalized.data.listingType || listingType,
    title,
    category: normalized.data.category || category,
    region,
    condition: normalized.data.condition || "99新",
    desc: normalized.data.desc || "",
    wantCount: 0,
    viewCount: 0,
    createTime: db.serverDate(),
    updateTime: db.serverDate(),
    status: "online",
    clientRequestId,
    _openid: openid,
    ...(options.extraData && typeof options.extraData === "object" ? options.extraData : {})
  }

  return ok({
    data,
    files: collectMarketFiles(data),
    idempotentGoodsId
  })
}

async function createItem(event, openid) {
  if (!openid) return fail("not_logged_in")
  const payload = event.payload || event.data || event
  const built = buildCreateItemForSave(payload, openid)
  if (!built.ok) return built
  const { data, files, idempotentGoodsId } = built

  await upsertUserRegion(openid, data)
  let itemId = ""

  if (idempotentGoodsId) {
    const existing = await db.collection(GOODS_COLLECTION).doc(idempotentGoodsId).get().catch(() => null)
    if (existing && existing.data && existing.data._openid === openid) {
      await attachMarketFiles(files, idempotentGoodsId, openid)
      return ok({ id: idempotentGoodsId, itemId: idempotentGoodsId, status: existing.data.status || "online", deduped: true })
    }
    await db.collection(GOODS_COLLECTION).doc(idempotentGoodsId).set({ data })
    itemId = idempotentGoodsId
  } else {
    const res = await db.collection(GOODS_COLLECTION).add({ data })
    itemId = res._id
  }

  await attachMarketFiles(files, itemId, openid)
  return ok({ id: itemId, itemId, status: "online" })
}

async function adminStatus(event, openid) {
  if (!openid) return ok({ isAdmin: false, openid: "" })
  const session = await verifyAdminSession(event, openid, { silent: true })
  return ok({
    openid,
    isAdmin: !!session.ok,
    source: session.ok ? "password_session" : "",
    expiresAtMs: session.expiresAtMs || 0
  })
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex")
}

function readEnvPasswordConfig() {
  const code = normalizeText(process.env.MARKET_BULK_ADMIN_CODE || process.env.MARKET_BULK_ADMIN_PASSWORD)
  if (/^\d{6}$/.test(code)) {
    return {
      source: "env_code",
      code
    }
  }
  return null
}

async function readAdminPasswordConfig() {
  try {
    const doc = await db.collection(ADMIN_SETTINGS_COLLECTION).doc(ADMIN_BULK_PASSWORD_DOC_ID).get()
    const data = doc && doc.data
    if (data) {
      const status = normalizeText(data.status || "active").toLowerCase()
      if (status !== "disabled" && status !== "inactive") {
        const code = normalizeText(data.code || data.password || data.adminCode)
        if (/^\d{6}$/.test(code)) {
          return {
            source: ADMIN_SETTINGS_COLLECTION,
            code
          }
        }
      }
    }
  } catch (e) {}
  return readEnvPasswordConfig()
}

async function verifyAdminPasswordValue(password) {
  const value = normalizeText(password)
  if (!value) return { ok: false, error: "missing_password" }
  if (!/^\d{6}$/.test(value)) return { ok: false, error: "invalid_password_format" }
  const config = await readAdminPasswordConfig()
  if (!config) return { ok: false, error: "password_not_configured" }

  if (config.code && value === config.code) {
    return { ok: true, source: config.source }
  }
  return { ok: false, error: "invalid_password" }
}

async function ensureAdminSessionCollection() {
  if (typeof db.createCollection !== "function") return
  await db.createCollection(ADMIN_SESSION_COLLECTION).catch(e => {
    const text = String(e && (e.message || e.errMsg || e.code) || "")
    if (!/exist|already|collection/i.test(text)) {
      console.warn("[marketApi] create admin session collection failed:", e)
    }
  })
}

function getAdminTokenFromEvent(event = {}) {
  return normalizeText(event.adminToken || event.token || event.payload?.adminToken || event.data?.adminToken)
}

function buildAdminSessionDocId(token) {
  return `sess_${sha256(token).slice(0, 48)}`
}

async function createAdminSession(openid) {
  const token = crypto.randomBytes(32).toString("hex")
  const tokenHash = sha256(token)
  const id = buildAdminSessionDocId(token)
  const nowMs = Date.now()
  const expiresAtMs = nowMs + ADMIN_SESSION_TTL_MS
  await ensureAdminSessionCollection()
  await db.collection(ADMIN_SESSION_COLLECTION).doc(id).set({
    data: {
      _openid: openid,
      adminOpenid: openid,
      tokenHash,
      status: "active",
      createTime: db.serverDate(),
      updateTime: db.serverDate(),
      createTimeMs: nowMs,
      updateTimeMs: nowMs,
      expiresAtMs
    }
  })
  return { token, expiresAtMs }
}

async function verifyAdminSession(event = {}, openid = "", options = {}) {
  const token = getAdminTokenFromEvent(event)
  if (!openid) return { ok: false, error: "not_logged_in" }
  if (!token) return { ok: false, error: "admin_session_required" }
  const id = buildAdminSessionDocId(token)
  const doc = await db.collection(ADMIN_SESSION_COLLECTION).doc(id).get().catch(() => null)
  const row = doc && doc.data
  if (!row) return { ok: false, error: "admin_session_invalid" }
  if (row.tokenHash !== sha256(token)) return { ok: false, error: "admin_session_invalid" }
  if (normalizeText(row.status || "active").toLowerCase() !== "active") return { ok: false, error: "admin_session_invalid" }
  if (row._openid && row._openid !== openid) return { ok: false, error: "admin_session_invalid" }
  if (Number(row.expiresAtMs) && Number(row.expiresAtMs) < Date.now()) return { ok: false, error: "admin_session_expired" }
  if (!options.silent) {
    await db.collection(ADMIN_SESSION_COLLECTION).doc(id).update({
      data: {
        updateTime: db.serverDate(),
        updateTimeMs: Date.now()
      }
    }).catch(() => {})
  }
  return { ok: true, openid, expiresAtMs: Number(row.expiresAtMs) || 0 }
}

async function adminVerifyPassword(event, openid) {
  if (!openid) return fail("not_logged_in")
  const password = String(event.password || event.payload?.password || event.data?.password || "")
  const verified = await verifyAdminPasswordValue(password)
  if (!verified.ok) return fail(verified.error)
  const session = await createAdminSession(openid)
  return ok({
    openid,
    isAdmin: true,
    source: verified.source || "password",
    adminToken: session.token,
    expiresAtMs: session.expiresAtMs
  })
}

function buildAdminBatchId(value) {
  const explicit = normalizeClientRequestId(value)
  if (explicit) return explicit
  return `market_admin_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function buildAdminExternalId(item = {}, index = 0) {
  return normalizeClientRequestId(item.externalId || item.adminExternalId || item.importId || `row_${index + 1}`)
}

async function saveAdminCreatedItem(payload, openid, batchId, index) {
  const listingType = normalizeListingType(payload.listingType)
  const externalId = buildAdminExternalId(payload, index)
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId) ||
    (payload.externalId || payload.adminExternalId || payload.importId
      ? `admin_external_${externalId}`
      : `${batchId}_${externalId}`)
  const sellerName = normalizeText(payload.sellerName || payload.displayName || payload.contactName)
  const sellerWechat = normalizeText(payload.sellerWechat || payload.wechatID || payload.wechatId || payload.wechat)
  const sellerPhone = normalizeText(payload.sellerPhone || payload.phone)
  const sourcePayload = {
    ...payload,
    listingType,
    category: normalizeListingCategory(payload.category || payload.roomType || (listingType === "sublet" ? "Studio" : "其他"), listingType),
    condition: payload.condition || (listingType === "sublet" ? "转租" : "99新"),
    status: "online",
    clientRequestId
  }
  const built = buildCreateItemForSave(sourcePayload, openid, {
    extraData: {
      managedByAdmin: true,
      managedByOpenid: openid,
      managedSource: "admin_bulk",
      adminBatchId: batchId,
      adminExternalId: externalId,
      sellerName,
      sellerWechat,
      sellerPhone,
      sellerAvatar: normalizeFileID(payload.sellerAvatar) || normalizeText(payload.sellerAvatar),
      sellerNote: normalizeText(payload.sellerNote)
    }
  })
  if (!built.ok) return built

  const { data, files, idempotentGoodsId } = built
  let itemId = ""
  let deduped = false

  if (idempotentGoodsId) {
    const existing = await db.collection(GOODS_COLLECTION).doc(idempotentGoodsId).get().catch(() => null)
    if (existing && existing.data && existing.data._openid === openid) {
      itemId = idempotentGoodsId
      deduped = true
    } else {
      await db.collection(GOODS_COLLECTION).doc(idempotentGoodsId).set({ data })
      itemId = idempotentGoodsId
    }
  } else {
    const res = await db.collection(GOODS_COLLECTION).add({ data })
    itemId = res._id
  }

  await attachMarketFiles(files, itemId, openid)
  return ok({
    id: itemId,
    itemId,
    title: data.title,
    listingType,
    deduped,
    externalId,
    status: "online"
  })
}

async function adminBulkCreate(event, openid) {
  if (!openid) return fail("not_logged_in")
  const session = await verifyAdminSession(event, openid)
  if (!session.ok) return fail(session.error || "forbidden")

  const items = Array.isArray(event.items)
    ? event.items
    : (event.payload && Array.isArray(event.payload.items) ? event.payload.items : [])
  if (!items.length) return fail("missing_items")
  if (items.length > 50) return fail("too_many_items", { max: 50 })

  const batchId = buildAdminBatchId(event.batchId || event.payload?.batchId)
  const results = []
  const failures = []

  await db.collection(IMPORT_BATCH_COLLECTION).doc(batchId).set({
    data: {
      batchId,
      type: "market_admin_bulk",
      source: "marketTrade",
      _openid: openid,
      adminOpenid: openid,
      total: items.length,
      success: 0,
      failed: 0,
      status: "running",
      createTime: db.serverDate(),
      updateTime: db.serverDate()
    }
  }).catch(e => {
    console.error("[marketApi] create import batch failed:", e)
  })

  for (let i = 0; i < items.length; i += 1) {
    try {
      const row = items[i] && typeof items[i] === "object" ? items[i] : {}
      const result = await saveAdminCreatedItem(row, openid, batchId, i)
      if (result.ok) results.push({ index: i, ...result })
      else failures.push({ index: i, error: result.error || "create_failed" })
    } catch (e) {
      failures.push({
        index: i,
        error: "database_error",
        detail: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : ""
      })
    }
  }

  await db.collection(IMPORT_BATCH_COLLECTION).doc(batchId).update({
    data: {
      success: results.length,
      failed: failures.length,
      status: failures.length ? (results.length ? "partial" : "failed") : "done",
      results: results.map(item => ({
        index: item.index,
        id: item.id,
        listingType: item.listingType,
        title: item.title,
        externalId: item.externalId,
        deduped: !!item.deduped
      })),
      failures,
      updateTime: db.serverDate()
    }
  }).catch(e => {
    console.error("[marketApi] update import batch failed:", e)
  })

  return ok({
    batchId,
    total: items.length,
    success: results.length,
    failed: failures.length,
    results,
    failures
  })
}

function sanitizeAdminTemplateData(input = {}) {
  const listingType = normalizeListingType(input.listingType)
  const data = {
    listingType,
    title: normalizeText(input.title),
    price: toFiniteNumber(input.price) || 0,
    category: normalizeListingCategory(input.category || input.roomType || (listingType === "sublet" ? "Studio" : "其他"), listingType),
    condition: normalizeText(input.condition) || (listingType === "sublet" ? "转租" : "99新"),
    sellerName: normalizeText(input.sellerName || input.displayName || input.contactName),
    sellerWechat: normalizeText(input.sellerWechat || input.wechatID || input.wechatId || input.wechat),
    sellerPhone: normalizeText(input.sellerPhone || input.phone),
    cityKey: normalizeCityKey(input.cityKey),
    cityLabel: normalizeText(input.cityLabel),
    regionState: normalizeText(input.regionState),
    regionArea: normalizeText(input.regionArea),
    regionKey: normalizeText(input.regionKey),
    buildingName: normalizeText(input.buildingName),
    detailAddress: normalizeText(input.detailAddress),
    location: input.location && typeof input.location === "object" ? buildLocationForSave(
      normalizeText(input.regionDisplay || input.region || input.detailAddress),
      input.location,
      {
        cityKey: input.cityKey,
        cityLabel: input.cityLabel,
        regionState: input.regionState,
        regionArea: input.regionArea,
        regionKey: input.regionKey,
        buildingName: input.buildingName
      }
    ) : {},
    pickupStartDate: normalizeText(input.pickupStartDate),
    pickupEndDate: normalizeText(input.pickupEndDate),
    deposit: normalizeText(input.deposit),
    roomType: listingType === "sublet" ? normalizeSubletCategory(input.roomType || input.category) : "",
    housingType: normalizeText(input.housingType),
    furnished: normalizeBoolean(input.furnished),
    utilitiesIncluded: normalizeBoolean(input.utilitiesIncluded),
    genderPreference: normalizeText(input.genderPreference),
    roommateCount: normalizeText(input.roommateCount),
    externalId: normalizeClientRequestId(input.externalId)
  }
  return data
}

async function adminListTemplates(event, openid) {
  if (!openid) return fail("not_logged_in")
  const session = await verifyAdminSession(event, openid)
  if (!session.ok) return fail(session.error || "forbidden")
  const limit = Math.min(50, Math.max(1, Number(event.limit) || 20))
  const res = await db.collection(ADMIN_TEMPLATE_COLLECTION)
    .where({ _openid: openid, status: "active" })
    .limit(limit)
    .get()
  return ok({ templates: res.data || [], data: res.data || [] })
}

async function adminSaveTemplate(event, openid) {
  if (!openid) return fail("not_logged_in")
  const session = await verifyAdminSession(event, openid)
  if (!session.ok) return fail(session.error || "forbidden")
  const payload = event.template || event.payload || event.data || {}
  const name = normalizeText(payload.name || payload.templateName || payload.title || "代发模板").slice(0, 60)
  const templateData = sanitizeAdminTemplateData(payload.data || payload)
  if (!templateData.sellerName || !templateData.sellerWechat) return fail("missing_template_contact")
  if (!templateData.cityKey || !templateData.regionKey || !templateData.regionArea) return fail("missing_template_region")

  const explicitId = normalizeClientRequestId(payload.id || payload.templateId)
  const templateId = explicitId || crypto.createHash("sha1")
    .update(`${openid}:${name}:${templateData.sellerWechat}:${templateData.cityKey}:${templateData.regionKey}`)
    .digest("hex")
  const docId = `tpl_${templateId}`
  await db.collection(ADMIN_TEMPLATE_COLLECTION).doc(docId).set({
    data: {
      _openid: openid,
      adminOpenid: openid,
      name,
      status: "active",
      data: templateData,
      createTime: db.serverDate(),
      updateTime: db.serverDate()
    }
  })
  return ok({ id: docId, templateId: docId, name, template: { _id: docId, name, data: templateData } })
}

async function adminDeleteTemplate(event, openid) {
  if (!openid) return fail("not_logged_in")
  const session = await verifyAdminSession(event, openid)
  if (!session.ok) return fail(session.error || "forbidden")
  const id = normalizeText(event.id || event.templateId)
  if (!id) return fail("missing_id")
  const doc = await db.collection(ADMIN_TEMPLATE_COLLECTION).doc(id).get().catch(() => null)
  const row = doc && doc.data
  if (!row || row._openid !== openid) return fail("not_found")
  await db.collection(ADMIN_TEMPLATE_COLLECTION).doc(id).update({
    data: {
      status: "deleted",
      updateTime: db.serverDate()
    }
  })
  return ok({ id })
}

async function updateItem(event, openid) {
  if (!openid) return fail("not_logged_in")
  const id = normalizeText(event.id)
  const patch = event.patch || event.payload || {}
  if (!id) return fail("missing_id")
  if (!patch || typeof patch !== "object") return fail("missing_patch")

  const oldRes = await db.collection(GOODS_COLLECTION).doc(id).get().catch(() => null)
  const oldItem = oldRes && oldRes.data
  if (!oldItem || !oldItem._id) return fail("not_found")
  if (oldItem._openid !== openid) return fail("forbidden")

  const allowed = new Set([
    "title",
    "listingType",
    "price",
    "category",
    "cityKey",
    "cityLabel",
    "region",
    "regionState",
    "regionArea",
    "regionKey",
    "regionDisplay",
    "buildingName",
    "location",
    "condition",
    "desc",
    "imageFileID",
    "thumbFileID",
    "imageFileIDs",
    "thumbFileIDs",
    "hasImage",
    "pickupStartDate",
    "pickupEndDate",
    "status",
    "sellerName",
    "sellerWechat",
    "sellerPhone",
    "sellerAvatar",
    "sellerNote",
    "availableStartDate",
    "leaseEndDate",
    "deposit",
    "roomType",
    "housingType",
    "furnished",
    "utilitiesIncluded",
    "genderPreference",
    "roommateCount"
  ])
  const safePatch = {}
  Object.keys(patch).forEach(key => {
    if (allowed.has(key)) safePatch[key] = patch[key]
  })

  const normalized = normalizePayloadForSave(safePatch, oldItem)
  if (!normalized.ok) return normalized

  const oldFileIDs = collectFileIDs(oldItem)
  const nextFileIDs = collectFileIDs({ ...oldItem, ...normalized.data })
  const nextSet = new Set(nextFileIDs)
  const removedFileIDs = oldFileIDs.filter(fileID => !nextSet.has(fileID))

  const res = await db.collection(GOODS_COLLECTION).doc(id).update({
    data: {
      ...normalized.data,
      updateTime: db.serverDate()
    }
  })

  if (normalized.data.regionState && normalized.data.regionArea && normalized.data.regionKey) {
    await upsertUserRegion(openid, { ...oldItem, ...normalized.data })
  }
  await attachMarketFiles(collectMarketFiles({ ...oldItem, ...normalized.data }), id, openid)
  const deleteResult = await deleteFiles(removedFileIDs)
  await markFilesDeleted(removedFileIDs, openid, id)

  return ok({
    id,
    updated: res.stats.updated,
    removedFiles: removedFileIDs.length,
    deletedFiles: deleteResult.deleted.length,
    failedFiles: deleteResult.failed
  })
}

async function deleteItem(event, openid) {
  if (!openid) return fail("not_logged_in")
  const id = normalizeText(event.id)
  if (!id) return fail("missing_id")

  const doc = await db.collection(GOODS_COLLECTION).doc(id).get().catch(() => null)
  const item = doc && doc.data
  if (!item || !item._id) return fail("not_found")
  if (item._openid !== openid) return fail("forbidden")

  const fileIDs = collectFileIDs(item)
  const fileResult = await deleteFiles(fileIDs)
  await markFilesDeleted(fileIDs, openid, id)
  await db.collection(GOODS_COLLECTION).doc(id).remove()

  return ok({
    id,
    deletedFiles: fileResult.deleted.length,
    failedFiles: fileResult.failed
  })
}

function buildVisibleConditions(filters = {}) {
  const conditions = [{ status: "online" }]
  const listingType = normalizeListingType(filters.listingType)
  conditions.push(buildListingTypeCondition(listingType))
  const category = normalizeText(filters.category)
  if (category && category !== "全部") {
    conditions.push({ category: normalizeListingCategory(category, listingType) })
  }
  const cityKey = normalizeCityKey(filters.cityKey || filters.city)
  if (cityKey && cityKey !== "all") {
    conditions.push({ cityKey })
  }
  const regionKeys = normalizeRegionKeys(filters.regionKeys || filters.areaKeys)
  const regionKey = normalizeText(filters.regionKey || filters.areaKey)
  if (regionKeys.length) {
    conditions.push({ regionKey: _.in(regionKeys) })
  } else if (regionKey && regionKey !== "all") {
    conditions.push({ regionKey })
  }
  if (filters.region && filters.region !== "全部") {
    conditions.push({ region: normalizeText(filters.region) })
  }
  const keyword = normalizeText(filters.keyword)
  if (keyword) {
    const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const reg = db.RegExp({ regexp: safe, options: "i" })
    conditions.push(_.or([{ title: reg }, { desc: reg }]))
  }
  return conditions.length === 1 ? conditions[0] : _.and(conditions)
}

function buildListingTypeCondition(value) {
  const listingType = normalizeListingType(value)
  return { listingType }
}

function buildOwnerListCondition(openid, listingType, visibleOnly = false) {
  const conditions = [{ _openid: openid }, buildListingTypeCondition(listingType)]
  if (visibleOnly) conditions.push({ status: "online" })
  return _.and(conditions)
}

function buildListBaseQuery(condition) {
  let query = db.collection(GOODS_COLLECTION).where(condition)
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  return query
}

async function queryPaged(query, event = {}) {
  const limit = clampLimit(event.limit)
  const skip = Math.max(0, Number(event.skip) || 0)
  const res = await query
    .orderBy("createTime", "desc")
    .skip(skip)
    .limit(limit)
    .get()
  const rows = res.data || []
  const items = normalizeBooleanFlag(event.fastList || event.skipImageUrls)
    ? rows.map(normalizeMarketItem)
    : await enrichImageUrls(rows)
  return ok({
    items,
    data: items,
    skip,
    limit,
    nextSkip: skip + rows.length,
    hasMore: rows.length === limit
  })
}

async function queryDistancePaged(condition, event = {}, origin) {
  const limit = clampLimit(event.limit)
  const skip = Math.max(0, Number(event.skip) || 0)
  const scanLimit = DISTANCE_SORT_SCAN_LIMIT
  const rows = []
  let offset = 0

  while (rows.length < scanLimit) {
    const batchLimit = Math.min(DISTANCE_SORT_BATCH_SIZE, scanLimit - rows.length)
    const res = await buildListBaseQuery(condition)
      .orderBy("createTime", "desc")
      .skip(offset)
      .limit(batchLimit)
      .get()
    const batch = res.data || []
    if (!batch.length) break
    rows.push(...batch)
    offset += batch.length
    if (batch.length < batchLimit) break
  }

  const sorted = rows.map(item => {
    const miles = distanceMiles(origin, item.location || {})
    return Number.isFinite(miles) ? { ...item, distanceMiles: miles } : { ...item, distanceMiles: null }
  }).sort((a, b) => {
    const da = Number.isFinite(a.distanceMiles) ? a.distanceMiles : Number.POSITIVE_INFINITY
    const db = Number.isFinite(b.distanceMiles) ? b.distanceMiles : Number.POSITIVE_INFINITY
    if (da !== db) return da - db
    return timestampMs(b.createTime) - timestampMs(a.createTime)
  })

  const pageRows = sorted.slice(skip, skip + limit)
  const items = normalizeBooleanFlag(event.fastList || event.skipImageUrls)
    ? pageRows.map(normalizeMarketItem)
    : await enrichImageUrls(pageRows)
  return ok({
    items,
    data: items,
    skip,
    limit,
    nextSkip: skip + pageRows.length,
    hasMore: skip + pageRows.length < sorted.length,
    distanceSorted: true,
    distanceScanCount: rows.length,
    distanceScanLimit: DISTANCE_SORT_SCAN_LIMIT
  })
}

async function listItems(event) {
  const condition = buildVisibleConditions(event.filters || {})
  const origin = getDistanceSortOrigin(event)
  if (origin) return queryDistancePaged(condition, event, origin)

  const query = buildListBaseQuery(condition)
  return queryPaged(query, event)
}

async function ensureViewEventsCollection() {
  if (viewEventsCollectionReady) return
  if (typeof db.createCollection === "function") {
    await db.createCollection(VIEW_EVENTS_COLLECTION).catch(e => {
      const text = String(e && (e.message || e.errMsg || e.code) || "")
      if (!/exist|already|collection/i.test(text)) {
        console.warn("[marketApi] create view collection failed:", e)
      }
    })
  }
  viewEventsCollectionReady = true
}

function buildViewEventId(goodsId, openid, dayKey) {
  return crypto.createHash("sha1").update(`${goodsId}:${openid}:${dayKey}`).digest("hex")
}

async function trackMarketItemView(goodsId, openid, item = {}) {
  if (!goodsId || !openid) return { counted: false, reason: "missing_openid", viewCount: Number(item.viewCount) || 0 }

  const dayKey = getNewYorkDateKey()
  const docId = buildViewEventId(goodsId, openid, dayKey)
  const nowMs = Date.now()

  try {
    await ensureViewEventsCollection()
    const ref = db.collection(VIEW_EVENTS_COLLECTION).doc(docId)
    const existing = await ref.get().catch(() => null)
    const row = existing && existing.data
    const count = Number(row && row.count) || 0
    if (count >= MARKET_VIEW_DAILY_LIMIT) {
      return { counted: false, reason: "daily_limit", viewCount: Number(item.viewCount) || 0, dailyCount: count }
    }

    if (row) {
      await ref.update({
        data: {
          count: _.inc(1),
          updateTime: db.serverDate(),
          updateTimeMs: nowMs
        }
      })
    } else {
      await ref.set({
        data: {
          goodsId,
          _openid: openid,
          dayKey,
          count: 1,
          createTime: db.serverDate(),
          updateTime: db.serverDate(),
          createTimeMs: nowMs,
          updateTimeMs: nowMs
        }
      })
    }

    await db.collection(GOODS_COLLECTION).doc(goodsId).update({
      data: {
        viewCount: _.inc(1),
        lastViewAt: db.serverDate()
      }
    })

    return {
      counted: true,
      viewCount: (Number(item.viewCount) || 0) + 1,
      dailyCount: count + 1
    }
  } catch (e) {
    console.error("[marketApi] track view failed:", e)
    return { counted: false, reason: "track_failed", viewCount: Number(item.viewCount) || 0 }
  }
}

async function detail(event, openid) {
  const id = normalizeText(event.id)
  if (!id) return fail("missing_id")
  const doc = await db.collection(GOODS_COLLECTION).doc(id).get().catch(() => null)
  const item = doc && doc.data
  if (!item || !item._id) return fail("not_found")
  const isOwner = !!(openid && item._openid === openid)
  if (!isOwner && !isVisibleMarketDoc(item)) return fail("not_found")
  const viewResult = normalizeBooleanFlag(event.trackView)
    ? await trackMarketItemView(id, openid, item)
    : { counted: false, viewCount: Number(item.viewCount) || 0 }
  const nextItem = viewResult.counted ? { ...item, viewCount: viewResult.viewCount } : item
  const enriched = await enrichImageUrls([nextItem], { detail: true })
  return ok({
    item: enriched[0],
    data: enriched[0],
    imgUrls: enriched[0].imageUrls || [],
    imgUrl: enriched[0].imageUrl || "",
    isOwner,
    view: {
      counted: !!viewResult.counted,
      dailyCount: Number(viewResult.dailyCount) || 0,
      dailyLimit: MARKET_VIEW_DAILY_LIMIT,
      reason: viewResult.reason || ""
    }
  })
}

async function myList(event, openid) {
  if (!openid) return fail("not_logged_in")
  let query = db.collection(GOODS_COLLECTION).where(buildOwnerListCondition(openid, getEventListingType(event)))
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  return queryPaged(query, event)
}

async function sellerList(event) {
  const sellerOpenid = normalizeText(event.openid || event.sellerOpenid)
  if (!sellerOpenid) return fail("missing_openid")
  let query = db.collection(GOODS_COLLECTION).where(buildOwnerListCondition(sellerOpenid, getEventListingType(event), true))
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  const result = await queryPaged(query, event)
  if (!result.ok) return result
  const visible = (result.items || []).filter(isVisibleMarketDoc)
  return ok({ ...result, items: visible, data: visible, hasMore: result.hasMore })
}

async function listAds(event = {}) {
  const placement = normalizeText(event.placement || "market_feed")
  const limit = Math.min(AD_MAX_LIMIT, Math.max(1, Number(event.limit) || AD_DEFAULT_LIMIT))
  const nowMs = Date.now()

  try {
    let query = db.collection(ADS_COLLECTION).where({ status: "online" })
    if (typeof query.field === "function") query = query.field(AD_FIELDS)
    const res = await query.limit(limit).get()
    const rows = (res.data || [])
      .map(normalizeMarketAd)
      .filter(ad => {
        if (ad.status !== "online") return false
        if (ad.placement && ad.placement !== placement) return false
        return isTimeWindowActive(ad, nowMs)
      })
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority
        return timestampMs(b.updateTime || b.createTime) - timestampMs(a.updateTime || a.createTime)
      })

    const ads = await enrichAdImageUrls(rows)
    return ok({ ads, data: ads, placement })
  } catch (e) {
    console.error("[marketApi] listAds failed:", e)
    return ok({ ads: [], data: [], placement, warning: "ads_unavailable" })
  }
}

async function trackAdClick(event = {}, openid = "") {
  const adId = normalizeText(event.adId || event.id)
  if (!adId) return fail("missing_ad_id")
  const data = {
    adId,
    type: "click",
    placement: normalizeText(event.placement || "market_feed"),
    listingType: getEventListingType(event),
    _openid: openid || "",
    createTime: db.serverDate(),
    createTimeMs: Date.now()
  }
  try {
    await db.collection(AD_EVENTS_COLLECTION).add({ data })
    return ok({ recorded: true })
  } catch (e) {
    console.error("[marketApi] trackAdClick failed:", e)
    return ok({ recorded: false, warning: "ad_click_untracked" })
  }
}

<<<<<<< HEAD
=======
function getRequestedConfigCollections(event = {}) {
  const source = Array.isArray(event.collections)
    ? event.collections
    : [event.collection || event.name]
  const out = []
  const seen = new Set()
  source.forEach(item => {
    const collection = normalizeText(item)
    if (!PUBLIC_CONFIG_COLLECTIONS.has(collection) || seen.has(collection)) return
    seen.add(collection)
    out.push(collection)
  })
  return out
}

async function publicConfig(event = {}) {
  const collections = getRequestedConfigCollections(event)
  if (!collections.length) return fail("invalid_config_collection")

  const docs = {}
  await Promise.all(collections.map(async collection => {
    const doc = await db.collection(collection).doc(PUBLIC_CONFIG_DOC_ID).get().catch(() => null)
    docs[collection] = doc && doc.data ? doc.data : null
  }))
  return ok({ docs, data: docs })
}

>>>>>>> 184e3d19a3c40e80a00744bc03f3614508a50b61
async function getWechatMap(openids) {
  const uniq = Array.from(new Set((openids || []).filter(Boolean)))
  const map = {}
  for (let i = 0; i < uniq.length; i += 20) {
    const chunk = uniq.slice(i, i + 20)
    try {
      const res = await db.collection(USER_COLLECTION).where({ _openid: _.in(chunk) }).field({
        _openid: true,
        wechatID: true,
        wechatId: true,
        wechat: true
      }).get()
      ;(res.data || []).forEach(row => {
        if (row._openid) map[row._openid] = row.wechatID || row.wechatId || row.wechat || ""
      })
    } catch (e) {
      console.error("[marketApi] getWechatMap failed:", e)
    }
  }
  return map
}

async function tradeList(event, openid) {
  if (!openid) return fail("not_logged_in")
  const type = event.type === "bought" ? "bought" : "sold"
  const queryCondition = type === "sold"
    ? { _openid: openid, status: "sold" }
    : { buyerOpenid: openid, status: "sold" }
  let query = db.collection(GOODS_COLLECTION).where(queryCondition)
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  const result = await queryPaged(query, event)
  if (!result.ok) return result
  const otherOpenids = (result.items || []).map(item => type === "sold"
    ? (item.buyerOpenid || "")
    : (item._openid || ""))
  const wxMap = await getWechatMap(otherOpenids)
  const items = (result.items || []).map(item => {
    const otherOpenid = type === "sold"
      ? (item.buyerOpenid || "")
      : (item._openid || "")
    return {
      ...item,
      otherOpenid,
      contactWechat: wxMap[otherOpenid] || ""
    }
  })
  return ok({ ...result, items, data: items, type, openid })
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = normalizeText(event.action)

  try {
    if (action === "list") return listItems(event)
    if (action === "detail") return detail(event, OPENID)
    if (action === "myList") return myList(event, OPENID)
    if (action === "sellerList") return sellerList(event)
    if (action === "tradeList") return tradeList(event, OPENID)
    if (action === "adminStatus") return adminStatus(event, OPENID)
    if (action === "adminSessionStatus") return adminStatus(event, OPENID)
    if (action === "adminVerifyPassword") return adminVerifyPassword(event, OPENID)
    if (action === "adminBulkCreate") return adminBulkCreate(event, OPENID)
    if (action === "adminListTemplates") return adminListTemplates(event, OPENID)
    if (action === "adminSaveTemplate") return adminSaveTemplate(event, OPENID)
    if (action === "adminDeleteTemplate") return adminDeleteTemplate(event, OPENID)
    if (action === "listAds") return listAds(event)
    if (action === "trackAdClick") return trackAdClick(event, OPENID)
<<<<<<< HEAD
=======
    if (action === "publicConfig") return publicConfig(event)
>>>>>>> 184e3d19a3c40e80a00744bc03f3614508a50b61
    if (action === "create") return createItem(event, OPENID)
    if (action === "update") return updateItem(event, OPENID)
    if (action === "delete") return deleteItem(event, OPENID)
    return fail("unknown_action")
  } catch (e) {
    console.error("[marketApi] failed:", action, e)
    return fail("database_error", { detail: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "" })
  }
}
