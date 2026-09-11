const {
  buildProfileDisplayLocation,
  buildProfileApartmentDisplay
} = require("./profileDisplay")

const MARKET_SELLER_PROFILE_CACHE_KEY = "market_seller_profile_cache_v2"
const SELLER_PROFILE_FRESH_MS = 10 * 60 * 1000
const SELLER_PROFILE_MAX_STALE_MS = 24 * 60 * 60 * 1000
const MAX_PROFILE_CACHE_SIZE = 120
const PROFILE_BATCH_SIZE = 20
const pendingProfiles = new Map()

function cleanText(value) {
  return String(value || "").trim()
}

function getProfileCacheStore() {
  try {
    const store = wx.getStorageSync(MARKET_SELLER_PROFILE_CACHE_KEY)
    return store && typeof store === "object" && !Array.isArray(store) ? store : {}
  } catch (e) {
    return {}
  }
}

function setProfileCacheStore(store = {}) {
  try {
    wx.setStorageSync(MARKET_SELLER_PROFILE_CACHE_KEY, store)
  } catch (e) {}
}

function pruneProfileCache(store = {}) {
  const keys = Object.keys(store)
  if (keys.length <= MAX_PROFILE_CACHE_SIZE) return store

  keys
    .sort((a, b) => (Number(store[a]?.ts) || 0) - (Number(store[b]?.ts) || 0))
    .slice(0, keys.length - MAX_PROFILE_CACHE_SIZE)
    .forEach(key => delete store[key])

  return store
}

function normalizeCachedProfile(openid, entry, options = {}) {
  if (!openid || !entry || !entry.profile) return null
  const age = Date.now() - Number(entry.ts || 0)
  if (!Number.isFinite(age) || age < 0 || age > SELLER_PROFILE_MAX_STALE_MS) return null
  if (!options.allowStale && age > SELLER_PROFILE_FRESH_MS) return null

  return {
    ...entry.profile,
    _openid: openid,
    openid,
    cachedAt: Number(entry.ts || 0),
    isFresh: age <= SELLER_PROFILE_FRESH_MS
  }
}

function readMarketSellerProfile(openid, options = {}) {
  const key = cleanText(openid)
  if (!key) return null
  return normalizeCachedProfile(key, getProfileCacheStore()[key], {
    allowStale: options.allowStale !== false
  })
}

function readMarketSellerProfiles(openids = [], options = {}) {
  const store = getProfileCacheStore()
  const out = {}
  ;(Array.isArray(openids) ? openids : []).forEach(rawOpenid => {
    const openid = cleanText(rawOpenid)
    const profile = normalizeCachedProfile(openid, store[openid], {
      allowStale: options.allowStale !== false
    })
    if (profile) out[openid] = profile
  })
  return out
}

function writeMarketSellerProfile(openid, profile = {}) {
  const key = cleanText(openid || profile._openid || profile.openid)
  if (!key) return null
  const normalized = normalizeMarketSellerProfile({ ...profile, _openid: key })
  const store = pruneProfileCache(getProfileCacheStore())
  store[key] = {
    ts: Date.now(),
    profile: normalized
  }
  setProfileCacheStore(store)
  return normalized
}

function writeMarketSellerProfiles(profiles = {}) {
  const list = Array.isArray(profiles) ? profiles : Object.values(profiles || {})
  if (!list.length) return {}

  const store = pruneProfileCache(getProfileCacheStore())
  const out = {}
  list.forEach(profile => {
    const openid = cleanText(profile && (profile._openid || profile.openid))
    if (!openid) return
    const normalized = normalizeMarketSellerProfile({ ...profile, _openid: openid })
    store[openid] = {
      ts: Date.now(),
      profile: normalized
    }
    out[openid] = normalized
  })
  setProfileCacheStore(store)
  return out
}

function normalizeMarketSellerProfile(user = {}) {
  const openid = cleanText(user._openid || user.openid)
  const name = cleanText(user.name || user.nickName || user.nickname) || "未设置昵称"
  const avatarRaw = cleanText(user.avatarRaw || user.avatarUrl || user.avatar || (user.userInfo && user.userInfo.avatarUrl))
  const avatarDisplay = cleanText(user.avatarDisplay) || avatarRaw || "/images/profile.png"
  const region = cleanText(buildProfileDisplayLocation(user) || user.regionDisplay)
  const apartment = cleanText(buildProfileApartmentDisplay(user))
  const bio = cleanText(user.bio || user.bioDisplay || user.intro || user.signature)

  return {
    _openid: openid,
    openid,
    name,
    nameDisplay: name,
    avatarRaw,
    avatarDisplay,
    avatarInitial: cleanText(user.avatarInitial) || name.slice(0, 1) || "卖",
    region,
    regionDisplay: region || "区域未填",
    apartment,
    apartmentDisplay: apartment,
    wechatID: cleanText(user.wechatID || user.wechatId || user.wechat),
    phone: cleanText(user.phone),
    bio,
    bioDisplay: bio || "发布者暂未填写个人简介。"
  }
}

async function resolveAvatarProfiles(profiles = {}) {
  const list = Object.values(profiles || {})
  const avatarFileIDs = Array.from(new Set(list
    .map(profile => profile && profile.avatarRaw)
    .filter(fileID => cleanText(fileID).startsWith("cloud://"))))

  if (!avatarFileIDs.length) return profiles

  const urlMap = {}
  for (let i = 0; i < avatarFileIDs.length; i += 50) {
    const chunk = avatarFileIDs.slice(i, i + 50)
    const result = await wx.cloud.getTempFileURL({ fileList: chunk }).catch(() => null)
    ;(result && result.fileList || []).forEach(file => {
      if (file.fileID && file.tempFileURL) urlMap[file.fileID] = file.tempFileURL
    })
  }

  Object.keys(profiles).forEach(openid => {
    const profile = profiles[openid]
    if (profile && urlMap[profile.avatarRaw]) profile.avatarDisplay = urlMap[profile.avatarRaw]
  })

  return profiles
}

async function fetchProfileBatch(targets) {
  const res = await wx.cloud.callFunction({
    name: "getUserInfoByOpenids",
    data: { openids: targets }
  })

  const result = res && res.result
  if (!result || result.ok !== true || !Array.isArray(result.data)) {
    throw new Error((result && result.errorMsg) || "无法获取卖家资料")
  }
  const profiles = {}
  result.data.forEach(user => {
    const profile = normalizeMarketSellerProfile(user)
    if (profile._openid) profiles[profile._openid] = profile
  })

  targets.forEach(openid => {
    if (!profiles[openid]) {
      profiles[openid] = normalizeMarketSellerProfile({ _openid: openid, name: "" })
    }
  })

  await resolveAvatarProfiles(profiles)
  writeMarketSellerProfiles(profiles)
  return profiles
}

async function fetchAndCacheMarketSellerProfiles(openids = [], options = {}) {
  const targets = Array.from(new Set((Array.isArray(openids) ? openids : []).map(cleanText).filter(Boolean)))
  const cached = options.force ? {} : readMarketSellerProfiles(targets, { allowStale: false })
  const missing = targets.filter(openid => !cached[openid] && !pendingProfiles.has(openid))
  // Match the cloud function's 20-user limit; overlapping requests share each user.
  for (let i = 0; i < missing.length; i += PROFILE_BATCH_SIZE) {
    const batch = missing.slice(i, i + PROFILE_BATCH_SIZE)
    const request = Promise.resolve().then(() => fetchProfileBatch(batch))
    batch.forEach(openid => {
      const task = request.then(profiles => profiles[openid]).finally(() => {
        if (pendingProfiles.get(openid) === task) pendingProfiles.delete(openid)
      })
      pendingProfiles.set(openid, task)
    })
  }
  const out = {}
  await Promise.all(targets.map(async openid => {
    const profile = cached[openid] || await pendingProfiles.get(openid)
    if (profile) out[openid] = profile
  }))
  return out
}

module.exports = {
  SELLER_PROFILE_FRESH_MS,
  readMarketSellerProfile,
  readMarketSellerProfiles,
  writeMarketSellerProfile,
  writeMarketSellerProfiles,
  normalizeMarketSellerProfile,
  fetchAndCacheMarketSellerProfiles
}
