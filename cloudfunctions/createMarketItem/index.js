const cloud = require("wx-server-sdk")
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const crypto = require("crypto")

const MARKET_FILES_COLLECTION = "MarketFiles"
const MAX_PICKUP_MONTHS = 2

function normalizeLocationText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function buildLocationForSave(regionStr, location = {}) {
  const displayName = normalizeLocationText(location.displayName || location.name || location.address || regionStr)
  if (!displayName) return {}

  const lat = toFiniteNumber(location.lat ?? location.latitude)
  const lng = toFiniteNumber(location.lng ?? location.longitude)
  const parts = displayName.split("/").map(s => s.trim()).filter(Boolean)
  return {
    displayName,
    name: normalizeLocationText(location.name || displayName),
    buildingName: normalizeLocationText(location.buildingName || parts.slice(2).join(" / ")),
    city: normalizeLocationText(location.city || parts[1]),
    state: normalizeLocationText(location.state || parts[0]),
    zip: normalizeLocationText(location.zip),
    country: normalizeLocationText(location.country || "US"),
    lat,
    lng,
    address: normalizeLocationText(location.address),
    source: normalizeLocationText(location.source || "manual"),
    updatedAtMs: Date.now()
  }
}

function parseRegion(regionStr) {
  const parts = String(regionStr || "")
    .split("/")
    .map(s => s.trim())
    .filter(Boolean)

  // "NJ / JC / Journal Sq" => ["NJ","JC","Journal Sq"]
  const p1 = parts[0] || ""
  const p2 = parts[1] || ""
  const rest = parts.slice(2)

  const bigregion = [p1, p2].filter(Boolean).join(" / ")
  const address = rest.length ? rest.join(" / ") : (p2 || p1)

  return { bigregion, address }
}

async function upsertUserRegion(openid, regionStr, location = {}) {
  if (!openid || !regionStr) return
  const { bigregion, address } = parseRegion(regionStr)
  const saveLocation = buildLocationForSave(regionStr, location)
  if (!bigregion && !address && !saveLocation.displayName) return

  const updateData = {
    bigregion,
    address: saveLocation.address || address,
    bigregionUpdatedAt: db.serverDate()
  }
  if (saveLocation.displayName) updateData.location = saveLocation

  try {
    const q = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
    const row = (q.data || [])[0]
    if (row && row._id) {
      await db.collection("userInfo").doc(row._id).update({
        data: updateData
      })
    } else {
      await db.collection("userInfo").add({
        data: {
          _openid: openid,
          ...updateData,
          createTime: db.serverDate()
        }
      })
    }
  } catch (e) {
    // 地址同步失败不阻塞发布
    console.error("[createMarketItem] upsert userInfo failed:", e)
  }
}

function normalizeFileID(fileID) {
  const value = String(fileID || "").trim()
  return value.startsWith("cloud://") ? value : ""
}

function uniqFileIDs(fileIDs) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function collectMarketFiles(payload = {}) {
  const files = []
  const imageFileID = normalizeFileID(payload.imageFileID)
  const thumbFileID = normalizeFileID(payload.thumbFileID)
  const imageFileIDs = Array.isArray(payload.imageFileIDs) ? payload.imageFileIDs : []
  const thumbFileIDs = Array.isArray(payload.thumbFileIDs) ? payload.thumbFileIDs : []

  uniqFileIDs([imageFileID, ...imageFileIDs]).forEach(fileID => {
    files.push({ fileID, type: "image", folder: "market" })
  })
  uniqFileIDs([thumbFileID, ...thumbFileIDs]).forEach(fileID => {
    files.push({ fileID, type: "thumb", folder: "market_thumb" })
  })

  const seen = new Set()
  return files.filter(file => {
    if (!file.fileID || seen.has(file.fileID)) return false
    seen.add(file.fileID)
    return true
  })
}

function marketFileDocId(fileID) {
  return crypto.createHash("sha1").update(String(fileID)).digest("hex")
}

function normalizeClientRequestId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)
}

function buildIdempotentGoodsId(openid, clientRequestId) {
  const requestId = normalizeClientRequestId(clientRequestId)
  if (!openid || !requestId) return ""
  const hash = crypto.createHash("sha1").update(`${openid}:${requestId}`).digest("hex")
  return `market_${hash}`
}

async function attachMarketFiles(files, goodsId, openid) {
  if (!files.length || !goodsId || !openid) return
  const col = db.collection(MARKET_FILES_COLLECTION)

  await Promise.all(files.map(file => {
    const nowMs = Date.now()
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
      console.error("[createMarketItem] attach MarketFiles failed:", e)
    })
  }))
}

function parseDateOnly(value) {
  const text = String(value || "").trim()
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

function buildPickupWindow(event = {}) {
  const today = startOfDay(new Date())
  const maxEnd = addMonths(today, MAX_PICKUP_MONTHS)
  const fallbackEnd = new Date(today.getTime())
  fallbackEnd.setDate(fallbackEnd.getDate() + 14)
  const safeFallbackEnd = fallbackEnd > maxEnd ? maxEnd : fallbackEnd

  const start = parseDateOnly(event.pickupStartDate) || today
  const end = parseDateOnly(event.pickupEndDate) || safeFallbackEnd

  if (end < start) {
    return { ok: false, message: "pickup_end_before_start" }
  }
  if (end > maxEnd) {
    return { ok: false, message: "pickup_range_over_2_months" }
  }

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

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: "not logged in" }

  const {
    title,
    price,
    category,
    region,
    location,
    condition,
    desc,
    imageFileID,
    thumbFileID,
    imageFileIDs,
    thumbFileIDs
  } = event || {}

  if (!title || !category || !region) {
    return { ok: false, message: "missing required fields" }
  }

  const priceNum = Number(price)
  if (Number.isNaN(priceNum) || priceNum < 0) {
    return { ok: false, message: "invalid price" }
  }

  const saveLocation = buildLocationForSave(region, location || {})
  // ✅ 发布时同步用户地址到 userInfo（失败不阻塞发布）
  await upsertUserRegion(OPENID, region, saveLocation)
  const pickupWindow = buildPickupWindow(event || {})
  if (!pickupWindow.ok) return { ok: false, message: pickupWindow.message }
  const files = collectMarketFiles({ imageFileID, thumbFileID, imageFileIDs, thumbFileIDs })
  const firstImageFileID = normalizeFileID(imageFileID) || files.find(file => file.type === "image")?.fileID || ""
  const firstThumbFileID = normalizeFileID(thumbFileID) || files.find(file => file.type === "thumb")?.fileID || ""

  const now = new Date()
  const postDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const clientRequestId = normalizeClientRequestId(event && event.clientRequestId)
  const idempotentGoodsId = buildIdempotentGoodsId(OPENID, clientRequestId)

  const goodsData = {
    title: String(title).trim(),
    price: priceNum,
    category,
    region,
    location: saveLocation,
    condition: condition || "99新",
    desc: desc || "",
    imageFileID: firstImageFileID,
    thumbFileID: firstThumbFileID,
    imageFileIDs: uniqFileIDs([firstImageFileID, ...(Array.isArray(imageFileIDs) ? imageFileIDs : [])]),
    thumbFileIDs: uniqFileIDs([firstThumbFileID, ...(Array.isArray(thumbFileIDs) ? thumbFileIDs : [])]),
    hasImage: !!firstImageFileID,
    pickupStartDate: pickupWindow.pickupStartDate,
    pickupEndDate: pickupWindow.pickupEndDate,
    pickupRangeText: pickupWindow.pickupRangeText,
    expireTime: pickupWindow.expireTime,
    expiresAtText: pickupWindow.expiresAtText,

    wantCount: 0,
    viewCount: 0,

    postDate,
    createTime: db.serverDate(),
    updateTime: db.serverDate(),
    status: "online",
    clientRequestId,
    _openid: OPENID
  }

  let goodsId = ""
  if (idempotentGoodsId) {
    const existing = await db.collection("market_goods").doc(idempotentGoodsId).get().catch(() => null)
    if (existing && existing.data && existing.data._openid === OPENID) {
      await attachMarketFiles(files, idempotentGoodsId, OPENID)
      return { ok: true, id: idempotentGoodsId, itemId: idempotentGoodsId, status: existing.data.status || "online", deduped: true }
    }

    await db.collection("market_goods").doc(idempotentGoodsId).set({ data: goodsData })
    goodsId = idempotentGoodsId
  } else {
    const res = await db.collection("market_goods").add({ data: goodsData })
    goodsId = res._id
  }

  await attachMarketFiles(files, goodsId, OPENID)

  // 兼容：前端可能读 id / itemId
  return { ok: true, id: goodsId, itemId: goodsId, status: "online" }
}
