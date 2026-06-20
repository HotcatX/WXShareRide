const cloud = require("wx-server-sdk")
const crypto = require("crypto")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const USER_COLLECTION = "userInfo"
const CODE_COLLECTION = "referral_codes"
const VISIT_COLLECTION = "referral_visits"
const BINDING_COLLECTION = "referral_bindings"
const STATS_COLLECTION = "referral_stats"

function ok(data = {}) {
  return { ok: true, ...data }
}

function fail(error, extra = {}) {
  return { ok: false, error, message: error, ...extra }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function sanitizeReferralCode(value) {
  return normalizeText(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)
}

function hashText(value, length = 24) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length)
}

function buildReferralCode(openid) {
  return `ref_${hashText(openid, 12)}`
}

async function upsertReferralCode(code, openid) {
  const referralCode = sanitizeReferralCode(code)
  if (!referralCode || !openid) return

  await db.collection(CODE_COLLECTION).doc(referralCode).set({
    data: {
      referralCode,
      referrerOpenid: openid,
      updatedAt: db.serverDate(),
      updatedAtMs: Date.now()
    }
  })
}

function safeQuery(query = {}) {
  if (!query || typeof query !== "object") return {}
  const out = {}
  Object.keys(query).slice(0, 20).forEach(key => {
    const cleanKey = normalizeText(key).slice(0, 60)
    if (!cleanKey) return
    out[cleanKey] = normalizeText(query[key]).slice(0, 300)
  })
  return out
}

async function ensureUserReferralCode(openid) {
  if (!openid) return ""

  const code = buildReferralCode(openid)
  const res = await db.collection(USER_COLLECTION).where({ _openid: openid }).limit(1).get()
  const user = (res.data || [])[0] || null

  if (!user) {
    await db.collection(USER_COLLECTION).add({
      data: {
        _openid: openid,
        referralCode: code,
        profileCompleted: false,
        status: "normal",
        tripDriver: [],
        tripPassenger: [],
        tripDriverHistory: [],
        tripPassengerHistory: [],
        createdTime: db.serverDate(),
        updateTime: db.serverDate()
      }
    })
    await upsertReferralCode(code, openid)
    return code
  }

  const existingCode = sanitizeReferralCode(user.referralCode)
  if (existingCode) {
    await upsertReferralCode(existingCode, openid)
    return existingCode
  }

  await db.collection(USER_COLLECTION).doc(user._id).update({
    data: {
      referralCode: code,
      updateTime: db.serverDate()
    }
  })
  await upsertReferralCode(code, openid)
  return code
}

async function findReferrer(referralCode) {
  const code = sanitizeReferralCode(referralCode)
  if (!code) return null

  const codeDoc = await db.collection(CODE_COLLECTION).doc(code).get().catch(() => null)
  const mappedOpenid = codeDoc && codeDoc.data && codeDoc.data.referrerOpenid
  if (mappedOpenid) {
    const userRes = await db.collection(USER_COLLECTION)
      .where({ _openid: mappedOpenid })
      .limit(1)
      .get()
    const user = (userRes.data || [])[0] || null
    if (user) return user
  }

  const fallbackRes = await db.collection(USER_COLLECTION)
    .where({ referralCode: code })
    .limit(1)
    .get()
  const user = (fallbackRes.data || [])[0] || null
  if (user && user._openid) await upsertReferralCode(code, user._openid)
  return user
}

async function updateStats(referrer, data = {}) {
  if (!referrer || !referrer._openid) return
  const statsId = `stats_${hashText(referrer._openid, 32)}`
  const col = db.collection(STATS_COLLECTION)
  const exists = await col.doc(statsId).get().catch(() => null)
  const incData = {}

  if (data.visitCount) incData.visitCount = _.inc(data.visitCount)
  if (data.boundUserCount) incData.boundUserCount = _.inc(data.boundUserCount)

  if (exists && exists.data) {
    await col.doc(statsId).update({
      data: {
        ...incData,
        referralCode: referrer.referralCode,
        referrerOpenid: referrer._openid,
        lastEventAt: db.serverDate(),
        updatedAtMs: Date.now()
      }
    })
    return
  }

  await col.doc(statsId).set({
    data: {
      referralCode: referrer.referralCode,
      referrerOpenid: referrer._openid,
      visitCount: data.visitCount || 0,
      boundUserCount: data.boundUserCount || 0,
      createdAt: db.serverDate(),
      lastEventAt: db.serverDate(),
      updatedAtMs: Date.now()
    }
  })
}

async function trackVisit(event, visitorOpenid) {
  const referralCode = sanitizeReferralCode(event.referralCode || event.ref)
  if (!referralCode) return ok({ tracked: false, reason: "missing_referral_code" })

  const referrer = await findReferrer(referralCode)
  if (!referrer || !referrer._openid) return ok({ tracked: false, reason: "invalid_referral_code" })
  if (visitorOpenid && visitorOpenid === referrer._openid) return ok({ tracked: false, reason: "self_referral" })

  const visitId = `visit_${hashText(`${referralCode}:${visitorOpenid || ""}:${Date.now()}:${Math.random()}`, 32)}`
  await db.collection(VISIT_COLLECTION).doc(visitId).set({
    data: {
      referralCode,
      referrerOpenid: referrer._openid,
      visitorOpenid: visitorOpenid || "",
      source: normalizeText(event.source).slice(0, 80),
      scene: normalizeText(event.scene).slice(0, 40),
      path: normalizeText(event.path).slice(0, 200),
      query: safeQuery(event.query),
      capturedAtMs: Number(event.capturedAtMs) || 0,
      createdAt: db.serverDate(),
      createdAtMs: Date.now()
    }
  })
  await updateStats(referrer, { visitCount: 1 })
  return ok({ tracked: true })
}

async function bindReferral(event, referredOpenid) {
  if (!referredOpenid) return fail("not_logged_in")

  const referralCode = sanitizeReferralCode(event.referralCode || event.ref)
  if (!referralCode) return ok({ bound: false, reason: "missing_referral_code" })

  const referrer = await findReferrer(referralCode)
  if (!referrer || !referrer._openid) return ok({ bound: false, reason: "invalid_referral_code" })
  if (referrer._openid === referredOpenid) return ok({ bound: false, reason: "self_referral" })

  const bindingId = `binding_${hashText(referredOpenid, 32)}`
  const existing = await db.collection(BINDING_COLLECTION).doc(bindingId).get().catch(() => null)
  if (existing && existing.data) {
    return ok({
      bound: false,
      existing: true,
      referrerOpenid: existing.data.referrerOpenid || "",
      referralCode: existing.data.referralCode || ""
    })
  }

  await db.collection(BINDING_COLLECTION).doc(bindingId).set({
    data: {
      referralCode,
      referrerOpenid: referrer._openid,
      referredOpenid,
      source: normalizeText(event.source).slice(0, 80),
      scene: normalizeText(event.scene).slice(0, 40),
      path: normalizeText(event.path).slice(0, 200),
      query: safeQuery(event.query),
      capturedAtMs: Number(event.capturedAtMs) || 0,
      createdAt: db.serverDate(),
      createdAtMs: Date.now()
    }
  })

  const userRes = await db.collection(USER_COLLECTION).where({ _openid: referredOpenid }).limit(1).get()
  const user = (userRes.data || [])[0] || null
  if (user && !user.referredByOpenid) {
    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        referredByOpenid: referrer._openid,
        referredByCode: referralCode,
        referredAt: db.serverDate(),
        updateTime: db.serverDate()
      }
    })
  }

  await updateStats(referrer, { boundUserCount: 1 })
  return ok({ bound: true, referrerOpenid: referrer._openid, referralCode })
}

async function getStats(openid) {
  if (!openid) return fail("not_logged_in")
  const referralCode = await ensureUserReferralCode(openid)
  const statsId = `stats_${hashText(openid, 32)}`
  const statsDoc = await db.collection(STATS_COLLECTION).doc(statsId).get().catch(() => null)
  const bindingRes = await db.collection(BINDING_COLLECTION)
    .where({ referrerOpenid: openid })
    .orderBy("createdAtMs", "desc")
    .limit(20)
    .get()

  return ok({
    referralCode,
    stats: statsDoc && statsDoc.data ? statsDoc.data : {
      referralCode,
      referrerOpenid: openid,
      visitCount: 0,
      boundUserCount: 0
    },
    recentBindings: bindingRes.data || []
  })
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = normalizeText(event.action)

  try {
    if (action === "getMyReferralCode") {
      if (!OPENID) return fail("not_logged_in")
      return ok({ referralCode: await ensureUserReferralCode(OPENID) })
    }
    if (action === "trackVisit") return trackVisit(event, OPENID)
    if (action === "bindReferral") return bindReferral(event, OPENID)
    if (action === "getStats") return getStats(OPENID)
    return fail("unknown_action")
  } catch (e) {
    console.error("[referralApi] failed:", action, e)
    return fail("database_error", {
      detail: e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : ""
    })
  }
}
