const cloud = require("wx-server-sdk")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const SUMMARY_COLLECTION = "ride_city_demand"
const EVENT_COLLECTION = "ride_city_demand_events"
const SERVICE_CITY_KEY = "ny_nj"

function cleanText(value, maxLength = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

function normalizeCityKey(value) {
  const cleaned = cleanText(value, 80)
  if (!cleaned) return ""
  return cleaned.replace(/[^\w-]/g, "_").slice(0, 80)
}

function normalizeAliases(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const output = []
  value.forEach((item) => {
    const text = cleanText(item, 80)
    if (!text || seen.has(text)) return
    seen.add(text)
    output.push(text)
  })
  return output.slice(0, 12)
}

async function addSummaryDoc(docId, data) {
  await db.collection(SUMMARY_COLLECTION).add({
    data: {
      _id: docId,
      ...data
    }
  })
}

async function incrementSummary(summaryRef, docId, updateData, createData) {
  const updateRes = await summaryRef.update({ data: updateData })
  const updated = Number(
    (updateRes && updateRes.stats && updateRes.stats.updated) ||
    (updateRes && updateRes.updated) ||
    0
  )

  if (updated > 0) return

  try {
    await addSummaryDoc(docId, createData)
  } catch (addErr) {
    await summaryRef.update({ data: updateData })
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  const openid = cleanText(wxContext.OPENID, 80)
  const cityKey = normalizeCityKey(event.cityKey)
  const cityLabel = cleanText(event.cityLabel, 80) || cityKey
  const cityAliases = normalizeAliases(event.cityAliases)
  const sourcePage = cleanText(event.sourcePage, 40) || "unknown"

  if (!cityKey) {
    return { success: false, errorMsg: "missing_city_key" }
  }

  if (cityKey === SERVICE_CITY_KEY) {
    return { success: true, skipped: true, cityKey, cityLabel }
  }

  const now = db.serverDate()
  const docId = `ride_city_${cityKey}`
  const summaryRef = db.collection(SUMMARY_COLLECTION).doc(docId)
  const updateData = {
    cityKey,
    cityLabel,
    cityAliases,
    sourcePage,
    requestCount: _.inc(1),
    updatedAt: now
  }

  if (openid) {
    updateData.requestOpenids = _.addToSet(openid)
  }

  const createData = {
    cityKey,
    cityLabel,
    cityAliases,
    sourcePage,
    requestCount: 1,
    requestOpenids: openid ? [openid] : [],
    createdAt: now,
    updatedAt: now
  }

  try {
    await incrementSummary(summaryRef, docId, updateData, createData)
  } catch (err) {
    try {
      await addSummaryDoc(docId, createData)
    } catch (addErr) {
      await summaryRef.update({ data: updateData })
    }
  }

  try {
    await db.collection(EVENT_COLLECTION).add({
      data: {
        cityKey,
        cityLabel,
        cityAliases,
        sourcePage,
        openid,
        createdAt: now
      }
    })
  } catch (err) {
    console.warn("ride demand event insert failed:", err)
  }

  return {
    success: true,
    cityKey,
    cityLabel
  }
}
