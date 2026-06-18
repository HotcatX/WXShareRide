const cloud = require("wx-server-sdk")
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function normalizeLocationText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function buildLocationForSave(regionStr, location = {}) {
  const displayName = normalizeLocationText(location.displayName || regionStr)
  if (!displayName) return {}

  const parts = displayName.split("/").map(s => s.trim()).filter(Boolean)
  return {
    displayName,
    buildingName: normalizeLocationText(location.buildingName || parts.slice(2).join(" / ")),
    city: normalizeLocationText(location.city || parts[1]),
    state: normalizeLocationText(location.state || parts[0]),
    zip: normalizeLocationText(location.zip),
    country: normalizeLocationText(location.country || "US"),
    lat: typeof location.lat === "number" ? location.lat : null,
    lng: typeof location.lng === "number" ? location.lng : null,
    address: normalizeLocationText(location.address),
    source: normalizeLocationText(location.source || "manual")
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

async function upsertUserRegion(openid, regionStr) {
  if (!openid || !regionStr) return
  const { bigregion, address } = parseRegion(regionStr)
  if (!bigregion && !address) return

  try {
    const q = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
    const row = (q.data || [])[0]
    if (row && row._id) {
      await db.collection("userInfo").doc(row._id).update({
        data: {
          bigregion,
          address,
          bigregionUpdatedAt: db.serverDate()
        }
      })
    } else {
      await db.collection("userInfo").add({
        data: {
          _openid: openid,
          bigregion,
          address,
          bigregionUpdatedAt: db.serverDate(),
          createTime: db.serverDate()
        }
      })
    }
  } catch (e) {
    // 地址同步失败不阻塞发布
    console.error("[createMarketItem] upsert userInfo failed:", e)
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  const { title, price, category, region, location, condition, desc, imageFileID } = event

  if (!title || !category || !region) {
    return { ok: false, message: "missing required fields" }
  }

  const priceNum = Number(price)
  if (Number.isNaN(priceNum) || priceNum < 0) {
    return { ok: false, message: "invalid price" }
  }

  // ✅ 发布时同步用户地址到 userInfo（失败不阻塞发布）
  await upsertUserRegion(OPENID, region)
  const saveLocation = buildLocationForSave(region, location || {})

  const now = new Date()
  const postDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

  const res = await db.collection("market_goods").add({
    data: {
      title: String(title).trim(),
      price: priceNum,
      category,
      region,
      location: saveLocation,
      condition: condition || "99新",
      desc: desc || "",
      imageFileID: imageFileID || "",

      wantCount: 0,
      viewCount: 0,

      postDate,
      createTime: db.serverDate(),
      _openid: OPENID
    }
  })

  // 兼容：前端可能读 id / itemId
  return { ok: true, id: res._id, itemId: res._id }
}
