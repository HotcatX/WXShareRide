const cloud = require("wx-server-sdk")
const crypto = require("crypto")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const GOODS_COLLECTION = "market_goods"
const FILES_COLLECTION = "MarketFiles"
const USER_COLLECTION = "userInfo"
const MAX_PICKUP_MONTHS = 2
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const VISIBLE_STATUSES = new Set(["", "online"])
const MUTABLE_STATUSES = new Set(["online", "offline", "sold"])

const LIST_FIELDS = {
  _id: true,
  _openid: true,
  title: true,
  price: true,
  category: true,
  region: true,
  location: true,
  condition: true,
  postDate: true,
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
  buyer_openid: true,
  isSold: true,
  sold: true
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

function normalizeFileID(fileID) {
  const value = normalizeText(fileID)
  return value.startsWith("cloud://") ? value : ""
}

function uniqFileIDs(fileIDs) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function hasLatLng(location = {}) {
  return toFiniteNumber(location.lat ?? location.latitude) !== null &&
    toFiniteNumber(location.lng ?? location.longitude) !== null
}

function buildLocationForSave(regionStr, location = {}) {
  const displayName = normalizeText(location.displayName || location.name || location.address || regionStr)
  if (!displayName) return {}

  const parts = displayName.split("/").map(s => s.trim()).filter(Boolean)
  return {
    displayName,
    name: normalizeText(location.name || displayName),
    buildingName: normalizeText(location.buildingName || parts.slice(2).join(" / ")),
    city: normalizeText(location.city || parts[1]),
    state: normalizeText(location.state || parts[0]),
    zip: normalizeText(location.zip),
    country: normalizeText(location.country || "US"),
    lat: toFiniteNumber(location.lat ?? location.latitude),
    lng: toFiniteNumber(location.lng ?? location.longitude),
    address: normalizeText(location.address),
    source: normalizeText(location.source || "manual"),
    updatedAtMs: Date.now()
  }
}

function parseRegion(regionStr) {
  const parts = normalizeText(regionStr).split("/").map(s => s.trim()).filter(Boolean)
  const p1 = parts[0] || ""
  const p2 = parts[1] || ""
  const rest = parts.slice(2)
  return {
    bigregion: [p1, p2].filter(Boolean).join(" / "),
    address: rest.length ? rest.join(" / ") : (p2 || p1)
  }
}

async function upsertUserRegion(openid, regionStr, location = {}) {
  if (!openid || !regionStr) return
  const { bigregion, address } = parseRegion(regionStr)
  const saveLocation = buildLocationForSave(regionStr, location)
  if (!bigregion && !address && !saveLocation.displayName) return

  const data = {
    bigregion,
    address: saveLocation.address || address,
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
  const today = startOfDay(new Date())
  const maxEnd = addMonths(today, MAX_PICKUP_MONTHS)
  const fallbackEnd = new Date(today.getTime())
  fallbackEnd.setDate(fallbackEnd.getDate() + 14)
  const safeFallbackEnd = fallbackEnd > maxEnd ? maxEnd : fallbackEnd

  const start = parseDateOnly(payload.pickupStartDate || oldItem.pickupStartDate) || today
  const end = parseDateOnly(payload.pickupEndDate || oldItem.pickupEndDate || oldItem.expiresAtText) || safeFallbackEnd

  if (end < start) return { ok: false, error: "pickup_end_before_start" }
  if (end > maxEnd) return { ok: false, error: "pickup_range_over_2_months" }

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

function normalizeMarketItem(item = {}) {
  const title = normalizeText(item.title) || "未命名商品"
  const priceText = formatPrice(item.price)
  const status = normalizeText(item.status) || "online"
  return {
    ...item,
    _id: item._id,
    id: item._id,
    title,
    titleDisplay: title,
    price: Number(item.price) || 0,
    priceText,
    priceDisplay: priceText,
    category: normalizeText(item.category) || "其他",
    categoryDisplay: normalizeText(item.category) || "二手",
    region: normalizeText(item.region),
    location: item.location || {},
    condition: normalizeText(item.condition) || "成色未填",
    conditionText: normalizeText(item.condition) || "成色未填",
    conditionDisplay: normalizeText(item.condition) || "成色未填",
    desc: item.desc || "",
    descDisplay: item.desc || "卖家暂未填写详细描述。",
    postDate: item.postDate || "刚刚发布",
    postDateDisplay: item.postDate || "刚刚发布",
    imageFileID: normalizeFileID(item.imageFileID),
    thumbFileID: normalizeFileID(item.thumbFileID),
    imageFileIDs: Array.isArray(item.imageFileIDs) ? item.imageFileIDs.map(normalizeFileID).filter(Boolean) : [],
    thumbFileIDs: Array.isArray(item.thumbFileIDs) ? item.thumbFileIDs.map(normalizeFileID).filter(Boolean) : [],
    hasImage: !!(item.hasImage || item.imageFileID || item.thumbFileID || (Array.isArray(item.imageFileIDs) && item.imageFileIDs.length)),
    pickupStartDate: item.pickupStartDate || "",
    pickupEndDate: item.pickupEndDate || item.expiresAtText || "",
    pickupRangeText: item.pickupRangeText || "",
    pickupText: item.pickupRangeText || item.pickupEndDate || item.expiresAtText || "联系卖家确认",
    locationText: item.pickup || item.region || "卖家未填写",
    expireTime: Number(item.expireTime) || 0,
    expiresAtText: item.expiresAtText || "",
    status,
    wantCount: Number(item.wantCount) || 0,
    wantCountText: `${Number(item.wantCount) || 0} 人想要`,
    viewCount: Number(item.viewCount) || 0,
    viewCountText: `${Number(item.viewCount) || 0} 人浏览`,
    pickup: item.pickup || item.region || "",
    imageSrc: "/images/market.png",
    thumbUrl: "",
    imageUrls: []
  }
}

function primaryFileID(item = {}) {
  return item.thumbFileID || item.imageFileID || (Array.isArray(item.thumbFileIDs) ? item.thumbFileIDs[0] : "") || (Array.isArray(item.imageFileIDs) ? item.imageFileIDs[0] : "")
}

async function enrichImageUrls(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).map(normalizeMarketItem)
  const detail = !!options.detail
  const fileIDs = []

  list.forEach(item => {
    const primary = primaryFileID(item)
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
    const primary = primaryFileID(item)
    const imageUrls = detail ? item.imageFileIDs.map(fileID => urlMap[fileID]).filter(Boolean) : []
    const imageSrc = (primary && urlMap[primary]) || primary || "/images/market.png"
    return {
      ...item,
      thumbUrl: primary ? (urlMap[primary] || "") : "",
      imageSrc,
      imageUrl: imageUrls[0] || imageSrc,
      imageUrls
    }
  })
}

function normalizePayloadForSave(payload = {}, oldItem = {}) {
  const data = {}

  if (payload.title !== undefined) {
    data.title = normalizeText(payload.title)
    if (!data.title) return fail("missing_title")
  }

  if (payload.price !== undefined) {
    const price = Number(payload.price)
    if (Number.isNaN(price) || price < 0) return fail("invalid_price")
    data.price = price
  }

  if (payload.category !== undefined) data.category = normalizeText(payload.category) || "其他"
  if (payload.region !== undefined) data.region = normalizeText(payload.region)
  if (payload.location !== undefined || payload.region !== undefined) {
    data.location = buildLocationForSave(data.region || oldItem.region || "", payload.location || oldItem.location || {})
  }
  if (payload.condition !== undefined) data.condition = normalizeText(payload.condition) || "99新"
  if (payload.desc !== undefined) data.desc = String(payload.desc || "")

  if (payload.status !== undefined) {
    const status = normalizeText(payload.status || "online")
    if (!MUTABLE_STATUSES.has(status)) return fail("invalid_status")
    data.status = status
  }

  const pickupWindow = buildPickupWindow(payload, oldItem)
  if (!pickupWindow.ok) return fail(pickupWindow.error)
  Object.assign(data, pickupWindow)

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

async function createItem(event, openid) {
  if (!openid) return fail("not_logged_in")
  const payload = event.payload || event.data || event
  const title = normalizeText(payload.title)
  const category = normalizeText(payload.category)
  const region = normalizeText(payload.region)
  if (!title || !category || !region) return fail("missing_required_fields")

  const normalized = normalizePayloadForSave(payload)
  if (!normalized.ok) return normalized

  const now = new Date()
  const postDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId)
  const idempotentGoodsId = buildIdempotentGoodsId(openid, clientRequestId)
  const data = {
    ...normalized.data,
    title,
    category,
    region,
    condition: normalized.data.condition || "99新",
    desc: normalized.data.desc || "",
    wantCount: 0,
    viewCount: 0,
    postDate,
    createTime: db.serverDate(),
    updateTime: db.serverDate(),
    status: "online",
    clientRequestId,
    _openid: openid
  }

  await upsertUserRegion(openid, region, data.location || {})
  const files = collectMarketFiles(data)
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
    "price",
    "category",
    "region",
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
    "status"
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

  if (normalized.data.region) await upsertUserRegion(openid, normalized.data.region, normalized.data.location || {})
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
  if (filters.category && filters.category !== "全部") {
    conditions.push({ category: filters.category })
  }
  if (filters.region && filters.region !== "全部") {
    const region = filters.region
    if (region.endsWith("/ 全部")) {
      const prefix = region.replace(/\/\s*全部\s*$/, "/")
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      conditions.push({ region: db.RegExp({ regexp: `^${esc}`, options: "i" }) })
    } else {
      conditions.push({ region })
    }
  }
  const keyword = normalizeText(filters.keyword)
  if (keyword) {
    const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const reg = db.RegExp({ regexp: safe, options: "i" })
    conditions.push(_.or([{ title: reg }, { desc: reg }]))
  }
  return conditions.length === 1 ? conditions[0] : _.and(conditions)
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
  const items = await enrichImageUrls(rows)
  return ok({
    items,
    data: items,
    skip,
    limit,
    nextSkip: skip + rows.length,
    hasMore: rows.length === limit
  })
}

async function listItems(event) {
  let query = db.collection(GOODS_COLLECTION).where(buildVisibleConditions(event.filters || {}))
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  return queryPaged(query, event)
}

async function detail(event, openid) {
  const id = normalizeText(event.id)
  if (!id) return fail("missing_id")
  const doc = await db.collection(GOODS_COLLECTION).doc(id).get().catch(() => null)
  const item = doc && doc.data
  if (!item || !item._id) return fail("not_found")
  const isOwner = !!(openid && item._openid === openid)
  if (!isOwner && !isVisibleMarketDoc(item)) return fail("not_found")
  const enriched = await enrichImageUrls([item], { detail: true })
  return ok({
    item: enriched[0],
    data: enriched[0],
    imgUrls: enriched[0].imageUrls || [],
    imgUrl: enriched[0].imageUrl || "",
    isOwner
  })
}

async function myList(event, openid) {
  if (!openid) return fail("not_logged_in")
  let query = db.collection(GOODS_COLLECTION).where({ _openid: openid })
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  return queryPaged(query, event)
}

async function sellerList(event) {
  const sellerOpenid = normalizeText(event.openid || event.sellerOpenid)
  if (!sellerOpenid) return fail("missing_openid")
  let query = db.collection(GOODS_COLLECTION).where({ _openid: sellerOpenid, status: "online" })
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  const result = await queryPaged(query, event)
  if (!result.ok) return result
  const visible = (result.items || []).filter(isVisibleMarketDoc)
  return ok({ ...result, items: visible, data: visible, hasMore: result.hasMore })
}

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
    ? _.or([
      { _openid: openid, isSold: true },
      { _openid: openid, sold: true },
      { _openid: openid, status: "sold" }
    ])
    : _.or([
      { buyerOpenid: openid, isSold: true },
      { buyerOpenid: openid, sold: true },
      { buyerOpenid: openid, status: "sold" },
      { buyer_openid: openid, isSold: true },
      { buyer_openid: openid, sold: true },
      { buyer_openid: openid, status: "sold" }
    ])
  let query = db.collection(GOODS_COLLECTION).where(queryCondition)
  if (typeof query.field === "function") query = query.field(LIST_FIELDS)
  const result = await queryPaged(query, event)
  if (!result.ok) return result
  const otherOpenids = (result.items || []).map(item => type === "sold"
    ? (item.buyerOpenid || item.buyer_openid || "")
    : (item._openid || ""))
  const wxMap = await getWechatMap(otherOpenids)
  const items = (result.items || []).map(item => {
    const otherOpenid = type === "sold"
      ? (item.buyerOpenid || item.buyer_openid || "")
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
    if (action === "create") return createItem(event, OPENID)
    if (action === "update") return updateItem(event, OPENID)
    if (action === "delete") return deleteItem(event, OPENID)
    return fail("unknown_action")
  } catch (e) {
    console.error("[marketApi] failed:", action, e)
    return fail("database_error", { detail: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : "" })
  }
}
