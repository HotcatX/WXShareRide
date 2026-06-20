const MARKET_MAIN_IMAGE_QUALITY = 52
const MARKET_THUMB_IMAGE_QUALITY = 42
const MARKET_MAX_IMAGE_COUNT = 6
const MARKET_PICKUP_MAX_MONTHS = 2
const MARKET_SUBLET_MAX_MONTHS = 18
const MARKET_DEFAULT_PICKUP_DAYS = 14
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const { showDataError } = require("../../../utils/error")

const GOODS_CATEGORY_OPTIONS = [
 "家具", "厨具", "电器", "服包鞋饰", "电子产品", "运动装备", "食品", "其他"
]
const SUBLET_CATEGORY_OPTIONS = ["单间", "主卧", "客厅", "Studio", "1B1B", "2B2B", "整租", "其他"]
const SUBLET_HOUSING_OPTIONS = ["未填写", "公寓", "Condo", "House", "宿舍", "其他"]
const SUBLET_GENDER_OPTIONS = ["不限", "限女生", "限男生", "情侣可", "无室友"]
const LISTING_TYPE_CONFIG = {
  goods: {
    createKicker: "New listing",
    editKicker: "Edit listing",
    createTitle: "发布闲置",
    editTitle: "编辑商品",
    submitCreate: "发布闲置",
    submitEdit: "保存修改",
    submittingCreate: "发布中...",
    submittingEdit: "保存中...",
    photoTitle: "商品图片",
    titlePlaceholder: "商品名称（必填）",
    descPlaceholder: "描述品牌、状态、购买渠道、瑕疵等",
    detailTitle: "商品信息",
    categoryLabel: "类型",
    priceLabel: "价格",
    conditionLabel: "新旧程度",
    startLabel: "可取开始",
    endLabel: "可取结束",
    mapLocationLabel: "精确定位（用于计算距离）",
    regionLocationLabel: "显示位置",
    defaultCategory: "其他",
    defaultCondition: "99新",
    categoryOptions: GOODS_CATEGORY_OPTIONS,
    conditionOptions: ["全新", "99新", "9新", "7新", "5新", "3新"],
    showConditionRow: true
  },
  sublet: {
    createKicker: "New sublet",
    editKicker: "Edit sublet",
    createTitle: "发布转租",
    editTitle: "编辑转租",
    submitCreate: "发布转租",
    submitEdit: "保存修改",
    submittingCreate: "发布中...",
    submittingEdit: "保存中...",
    photoTitle: "房源图片",
    titlePlaceholder: "房源标题（必填）",
    descPlaceholder: "描述房型、室友、家具、交通、租期和费用等",
    detailTitle: "房源信息",
    categoryLabel: "房型",
    priceLabel: "月租",
    conditionLabel: "房源状态",
    startLabel: "入住时间",
    endLabel: "租期结束",
    mapLocationLabel: "精确定位（用于计算距离）",
    regionLocationLabel: "显示位置",
    defaultCategory: "单间",
    defaultCondition: "转租",
    categoryOptions: SUBLET_CATEGORY_OPTIONS,
    conditionOptions: ["可立即入住", "租期可议", "仅限女生", "仅限男生"],
    showConditionRow: false
  }
}

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function getListingTypeConfig(type) {
  return LISTING_TYPE_CONFIG[normalizeListingType(type)] || LISTING_TYPE_CONFIG.goods
}

function createSubmitRequestId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function markMarketGoodsChanged() {
  try {
    wx.setStorageSync(MARKET_REFRESH_KEY, Date.now())
  } catch (e) {}
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    throw new Error((result && (result.error || result.message)) || "market_api_failed")
  }
  return result
}

// ========== 图片压缩（上传前压缩，压缩失败使用原图，保证不出错） ==========
function compressForUpload(srcPath, quality = 70) {
  return new Promise(resolve => {
    if (!srcPath) return resolve(srcPath)
    wx.compressImage({
      src: srcPath,
      quality,
      success: res => resolve(res.tempFilePath || srcPath),
      fail: () => resolve(srcPath)
    })
  })
}

async function prepareMainImageForUpload(page, imgPath) {
  return compressForUpload(imgPath, MARKET_MAIN_IMAGE_QUALITY)
}

// ========== 生成缩略图 ==========
function genThumbFromFirstImage(page, imgPath) {
  return compressForUpload(imgPath, MARKET_THUMB_IMAGE_QUALITY)
}

// ========== 上传单张到云存储 ==========
function uploadOne(localPath, folder = "market", onProgress) {
  if (!localPath) return Promise.resolve("")
  const match = String(localPath).match(/\.([a-z0-9]+)(?:\?|$)/i)
  const rawExt = match ? match[1].toLowerCase() : "jpg"
  const ext = ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(rawExt) ? rawExt : "jpg"
  const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`

  return new Promise((resolve, reject) => {
    const uploadTask = wx.cloud.uploadFile({
      cloudPath,
      filePath: localPath,
      success: res => resolve(res.fileID || ""),
      fail: reject
    })

    if (uploadTask && typeof uploadTask.onProgressUpdate === "function") {
      uploadTask.onProgressUpdate(res => {
        if (typeof onProgress === "function") {
          onProgress(Math.max(0, Math.min(100, Number(res.progress) || 0)))
        }
      })
    }
  })
}

function normalizeFileID(fileID) {
  const value = String(fileID || "").trim()
  return value.startsWith("cloud://") ? value : ""
}

function uniqFileIDs(fileIDs) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function previewImagesFromState(state = {}) {
  const images = Array.isArray(state.images) ? state.images.filter(Boolean) : []
  if (!images.length && state.image) images.push(state.image)
  return Array.from(new Set(images))
}

function orderedImageFileIDsFromState(state = {}) {
  const fromList = Array.isArray(state.imageFileIDs) ? state.imageFileIDs.map(normalizeFileID).filter(Boolean) : []
  if (fromList.length) return Array.from(new Set(fromList))
  const primary = normalizeFileID(state.imageFileID)
  return primary ? [primary] : []
}

function orderedThumbFileIDsFromState(state = {}) {
  const fromList = Array.isArray(state.thumbFileIDs) ? state.thumbFileIDs.map(normalizeFileID) : []
  if (fromList.length) return fromList
  const primary = normalizeFileID(state.thumbFileID)
  return primary ? [primary] : []
}

function firstValidFileID(fileIDs = []) {
  return fileIDs.map(normalizeFileID).find(Boolean) || ""
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== day) d.setDate(0)
  return d
}

function addDays(date, days) {
  const d = new Date(date.getTime())
  d.setDate(d.getDate() + days)
  return d
}

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function parseDate(value) {
  const text = String(value || "").trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (formatDate(date) !== text) return null
  return date
}

function endOfDayTime(value) {
  const d = parseDate(value)
  if (!d) return 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}

function buildDefaultPickupWindow(listingType = "goods") {
  const today = startOfDay(new Date())
  const normalizedType = normalizeListingType(listingType)
  const maxMonths = normalizedType === "sublet" ? MARKET_SUBLET_MAX_MONTHS : MARKET_PICKUP_MAX_MONTHS
  const max = addMonths(today, maxMonths)
  const defaultEnd = addDays(today, normalizedType === "sublet" ? 180 : MARKET_DEFAULT_PICKUP_DAYS)
  const safeEnd = defaultEnd > max ? max : defaultEnd
  const start = formatDate(today)
  const end = formatDate(safeEnd)
  const maxText = formatDate(max)
  return {
    pickupStartMin: start,
    pickupStartMax: maxText,
    pickupEndMin: start,
    pickupEndMax: maxText,
    pickupStartDate: start,
    pickupEndDate: end,
    pickupRangeText: `${start} 至 ${end}`
  }
}

function normalizePickupWindow(startText, endText, listingType = "goods") {
  const base = buildDefaultPickupWindow(listingType)
  const minDate = parseDate(base.pickupStartMin)
  const maxDate = parseDate(base.pickupEndMax)
  let startDate = parseDate(startText) || parseDate(base.pickupStartDate)
  let endDate = parseDate(endText) || parseDate(base.pickupEndDate)

  if (startDate < minDate) startDate = minDate
  if (startDate > maxDate) startDate = maxDate
  if (endDate < startDate) endDate = startDate
  if (endDate > maxDate) endDate = maxDate

  const start = formatDate(startDate)
  const end = formatDate(endDate)
  return {
    ...base,
    pickupEndMin: start,
    pickupStartDate: start,
    pickupEndDate: end,
    pickupRangeText: `${start} 至 ${end}`
  }
}

function normalizeLocationText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function optionIndexOf(options = [], value = "", fallbackIndex = 0) {
  const idx = options.indexOf(normalizeLocationText(value))
  return idx >= 0 ? idx : fallbackIndex
}

function normalizeOptionalNumberText(value) {
  return String(value || "").replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1")
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

function buildPostDisplayPatch(state = {}) {
  const isEdit = !!state.isEdit
  const submitting = !!state.submitting
  const config = getListingTypeConfig(state.activeListingType)
  const showSubletFields = normalizeListingType(state.activeListingType) === "sublet"
  const category = normalizeLocationText(state.category) || "其他"
  const locationInput = normalizeLocationText(state.locationInput)
  const regionInput = normalizeLocationText(state.region)
  const housingType = normalizeLocationText(state.housingType)
  const genderPreference = normalizeLocationText(state.genderPreference) || "不限"
  const imageCount = Math.min(MARKET_MAX_IMAGE_COUNT, Math.max(
    previewImagesFromState(state).length,
    orderedImageFileIDsFromState(state).length
  ))

  return {
    postModeKicker: isEdit ? config.editKicker : config.createKicker,
    postPageTitle: isEdit ? config.editTitle : config.createTitle,
    photoSectionTitle: config.photoTitle,
    titlePlaceholder: config.titlePlaceholder,
    descPlaceholder: config.descPlaceholder,
    detailSectionTitle: config.detailTitle,
    categoryLabel: config.categoryLabel,
    priceLabel: config.priceLabel,
    conditionLabel: config.conditionLabel,
    pickupStartLabel: config.startLabel,
    pickupEndLabel: config.endLabel,
    mapLocationLabel: config.mapLocationLabel,
    regionLocationLabel: config.regionLocationLabel,
    showConditionRow: !!config.showConditionRow,
    showSubletFields,
    categoryDisplay: category,
    housingTypeDisplay: housingType || "未填写",
    genderPreferenceDisplay: genderPreference,
    furnishedDisplay: state.furnished ? "带家具" : "未标注",
    utilitiesIncludedDisplay: state.utilitiesIncluded ? "已包含" : "未包含",
    locationDisplay: locationInput || "去个人资料选择位置",
    locationMutedClass: locationInput ? "" : "muted",
    regionLocationDisplay: regionInput || "去个人资料选择地区",
    regionLocationMutedClass: regionInput ? "" : "muted",
    imageCountText: `${imageCount}/${MARKET_MAX_IMAGE_COUNT}`,
    canAddImage: imageCount < MARKET_MAX_IMAGE_COUNT && !state.imageUploading,
    submitDisabledClass: submitting ? "disabled" : "",
    submitText: submitting
      ? (isEdit ? config.submittingEdit : config.submittingCreate)
      : (isEdit ? config.submitEdit : config.submitCreate)
  }
}

function buildLocationMeta(displayName, source = {}) {
  const name = normalizeLocationText(displayName || source.displayName || source.name || source.address)
  if (!name) return {}

  const parts = name.split("/").map(s => s.trim()).filter(Boolean)
  const legacyState = parts[0] || ""
  const legacyArea = parts[1] || ""
  const legacyBuilding = parts.slice(2).join(" / ")

  return {
    displayName: name,
    buildingName: source.buildingName || legacyBuilding || "",
    city: source.city || legacyArea || "",
    state: source.state || legacyState || "",
    zip: source.zip || "",
    country: source.country || "US",
    lat: toFiniteNumber(source.lat ?? source.latitude),
    lng: toFiniteNumber(source.lng ?? source.longitude),
    address: source.address || "",
    region: source.region || "",
    source: source.source || "manual",
    coordinateAccuracy: source.coordinateAccuracy || "",
    provider: source.provider || ""
  }
}

function isEmptyProfileRegion(value) {
  const parts = normalizeLocationText(value).split("/").map(s => s.trim()).filter(Boolean)
  if (!parts.length) return true
  return parts.every(part => part === "无" || part === "—")
}

function buildProfileRegionDisplay(user = {}) {
  const bigregion = normalizeLocationText(user.bigregion)
  const address = normalizeLocationText(user.address)
  const hasRegion = bigregion && !isEmptyProfileRegion(bigregion)

  if (hasRegion) return bigregion

  return address
}

function buildProfileMapLocationDisplay(user = {}) {
  const location = user.location || {}
  if (!hasLatLng(location)) return ""
  return normalizeLocationText(
    location.displayName ||
    location.name ||
    location.address ||
    ""
  )
}

function buildItemMapLocationDisplay(item = {}) {
  const location = item.location || {}
  if (!location || typeof location !== "object") return ""
  if (!hasLatLng(location)) return ""
  return normalizeLocationText(
    location.displayName ||
    location.name ||
    location.address ||
    ""
  )
}

Page({
  data: {
    statusBarHeight: 0,
    activeListingType: "goods",

    // ✅ 编辑模式
    isEdit: false,
    editId: '',
    editLoading: false,

    // image 仅用于预览（本地路径）
    image: "",
    imageFileID: "",

    images: [],
    imageFileIDs: [],
    thumbFileID: "",
    thumbFileIDs: [],
    imageUploading: false,
    imageUploadProgress: 0,
    imageUploadText: "上传中",
    imageCountText: `0/${MARKET_MAX_IMAGE_COUNT}`,
    canAddImage: true,

    title: "",
    desc: "",

    category: LISTING_TYPE_CONFIG.goods.defaultCategory,
    price: "",
    condition: LISTING_TYPE_CONFIG.goods.defaultCondition,
    region: "",
    locationInput: "",
    location: {},
    ...buildDefaultPickupWindow("goods"),

    categoryOptions: LISTING_TYPE_CONFIG.goods.categoryOptions,
    categoryIndex: LISTING_TYPE_CONFIG.goods.categoryOptions.indexOf(LISTING_TYPE_CONFIG.goods.defaultCategory),
    deposit: "",
    housingType: "",
    housingTypeOptions: SUBLET_HOUSING_OPTIONS,
    housingTypeIndex: 0,
    furnished: false,
    utilitiesIncluded: false,
    genderPreference: "不限",
    genderPreferenceOptions: SUBLET_GENDER_OPTIONS,
    genderPreferenceIndex: 0,
    roommateCount: "",
    profileWechatID: "",

    // condition sheet
    conditionSheetVisible: false,
    conditionOptions: LISTING_TYPE_CONFIG.goods.conditionOptions,

    submitting: false,
    postModeKicker: LISTING_TYPE_CONFIG.goods.createKicker,
    postPageTitle: LISTING_TYPE_CONFIG.goods.createTitle,
    photoSectionTitle: LISTING_TYPE_CONFIG.goods.photoTitle,
    titlePlaceholder: LISTING_TYPE_CONFIG.goods.titlePlaceholder,
    descPlaceholder: LISTING_TYPE_CONFIG.goods.descPlaceholder,
    detailSectionTitle: LISTING_TYPE_CONFIG.goods.detailTitle,
    categoryLabel: LISTING_TYPE_CONFIG.goods.categoryLabel,
    priceLabel: LISTING_TYPE_CONFIG.goods.priceLabel,
    conditionLabel: LISTING_TYPE_CONFIG.goods.conditionLabel,
    pickupStartLabel: LISTING_TYPE_CONFIG.goods.startLabel,
    pickupEndLabel: LISTING_TYPE_CONFIG.goods.endLabel,
    mapLocationLabel: LISTING_TYPE_CONFIG.goods.mapLocationLabel,
    regionLocationLabel: LISTING_TYPE_CONFIG.goods.regionLocationLabel,
    showConditionRow: true,
    showSubletFields: false,
    categoryDisplay: LISTING_TYPE_CONFIG.goods.defaultCategory,
    housingTypeDisplay: "未填写",
    genderPreferenceDisplay: "不限",
    furnishedDisplay: "未标注",
    utilitiesIncludedDisplay: "未包含",
    locationDisplay: "去个人资料选择位置",
    locationMutedClass: "muted",
    regionLocationDisplay: "去个人资料选择地区",
    regionLocationMutedClass: "muted",
    submitDisabledClass: "",
    submitText: LISTING_TYPE_CONFIG.goods.submitCreate,
    dockVisibleClass: "dock-hidden"
  },

  onReady() {
    setTimeout(() => {
      this._setPostData({ dockVisibleClass: "" })
    }, 320)
  },

  _setPostData(patch = {}) {
    const nextState = { ...this.data, ...patch }
    this.setData({
      ...patch,
      ...buildPostDisplayPatch(nextState)
    })
  },

  onLoad(options) {
    const sys = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const id = options?.id || ''
    const mode = options?.mode || ''
    const isEdit = !!id && String(mode).toLowerCase() === 'edit'
    const activeListingType = normalizeListingType(options?.type || options?.listingType)
    const config = getListingTypeConfig(activeListingType)

    this._setPostData({
      statusBarHeight: sys.statusBarHeight || 0,
      activeListingType,
      isEdit,
      editId: isEdit ? id : '',
      category: config.defaultCategory,
      categoryOptions: config.categoryOptions,
      categoryIndex: config.categoryOptions.indexOf(config.defaultCategory),
      condition: config.defaultCondition,
      conditionOptions: config.conditionOptions,
      housingTypeIndex: 0,
      housingType: "",
      genderPreferenceIndex: 0,
      genderPreference: "不限",
      ...normalizePickupWindow(this.data.pickupStartDate, this.data.pickupEndDate, activeListingType)
    })

    if (isEdit) {
      this._loadExistingItem(id)
    } else {
      this._applyDefaultLocation()
    }
    this._hasLoaded = true
  },

  onShow() {
    if (!this._hasLoaded || this.data.isEdit || this._locationTouched) return
    this._applyProfileLocation()
  },

  async _applyDefaultLocation() {
    await this._applyProfileLocation()
  },

  async _applyProfileLocation() {
    if (this.data.isEdit || this._locationTouched) return false

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      const user = (res?.result?.data || [])[0] || null
      const profileWechatID = normalizeLocationText(user?.wechatID)
      const regionDisplay = buildProfileRegionDisplay(user || {})
      const locationDisplay = buildProfileMapLocationDisplay(user || {})
      if (this.data.isEdit || this._locationTouched) return false
      if (!regionDisplay && !locationDisplay) {
        this._setPostData({ profileWechatID })
        return false
      }

      const location = locationDisplay ? buildLocationMeta(locationDisplay, {
        ...(user?.location || {}),
        region: regionDisplay,
        source: user?.location ? (user.location.source || "profile") : "profile"
      }) : {}
      this._setPostData({
        profileWechatID,
        region: regionDisplay,
        locationInput: locationDisplay,
        location
      })
      return true
    } catch (e) {
      showDataError("资料加载失败", e, "个人资料从数据库加载失败，请稍后重试。")
      return false
    }
  },

  // =========================
  // 编辑模式：加载已有商品并回填表单
  // =========================
  async _loadExistingItem(id) {
    // 编辑必须登录
    const myOpenid = wx.getStorageSync('openid') || ''
    const isGuest = !!wx.getStorageSync('isGuest')
    if (!myOpenid || isGuest) {
      wx.setStorageSync('needLoginToast', '请先登录再编辑商品')
      wx.setStorageSync('pendingPage', { url: `/pages/market/marketPost/marketPost?id=${id}&mode=edit` })
      wx.navigateTo({ url: '/pages/other/login/login' })
      return
    }

    try {
      this.setData({ editLoading: true })
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "detail", id }
      })
      const result = getMarketApiResult(res)
      const x = result.item || result.data || {}
      const activeListingType = normalizeListingType(x.listingType)
      const config = getListingTypeConfig(activeListingType)
      const itemName = activeListingType === "sublet" ? "房源" : "商品"

      if (!result.isOwner) {
        wx.showToast({ title: `只能编辑自己发布的${itemName}`, icon: 'none' })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 600)
        return
      }

      const rawCategory = x.category || ''
      const category = config.categoryOptions.includes(rawCategory) ? rawCategory : config.defaultCategory
      const categoryIndex = config.categoryOptions.indexOf(category)
      const locationDisplayName = buildItemMapLocationDisplay(x)

      // 图片：回填 fileIDs + 预览 temp urls
      const fileIds = Array.isArray(x.imageFileIDs) && x.imageFileIDs.length
        ? x.imageFileIDs.map(normalizeFileID).filter(Boolean)
        : (x.imageFileID ? [x.imageFileID] : [])
      const thumbIds = Array.isArray(x.thumbFileIDs) && x.thumbFileIDs.length
        ? x.thumbFileIDs.map(normalizeFileID)
        : (x.thumbFileID ? [x.thumbFileID] : [])

      const tempUrls = Array.isArray(result.imgUrls) && result.imgUrls.length
        ? result.imgUrls
        : (Array.isArray(x.imageUrls) && x.imageUrls.length ? x.imageUrls : (x.imageUrl ? [x.imageUrl] : []))

      this._setPostData({
        activeListingType,
        title: x.title || '',
        desc: x.desc || '',
        category,
        categoryIndex,
        categoryOptions: config.categoryOptions,
        conditionOptions: config.conditionOptions,
        price: (x.price === 0 || x.price) ? String(x.price) : '',
        condition: x.condition || config.defaultCondition,
        deposit: (x.deposit === 0 || x.deposit) ? String(x.deposit) : '',
        housingType: x.housingType || '',
        housingTypeIndex: optionIndexOf(SUBLET_HOUSING_OPTIONS, x.housingType, 0),
        furnished: x.furnished === true,
        utilitiesIncluded: x.utilitiesIncluded === true,
        genderPreference: x.genderPreference || '不限',
        genderPreferenceIndex: optionIndexOf(SUBLET_GENDER_OPTIONS, x.genderPreference || '不限', 0),
        roommateCount: (x.roommateCount === 0 || x.roommateCount) ? String(x.roommateCount) : '',
        region: x.region || '',
        locationInput: locationDisplayName,
        location: x.location || buildLocationMeta(locationDisplayName || x.region || '', { region: x.region || '' }),

        // 单图预览仍用 image
        image: tempUrls[0] || '',
        images: tempUrls,

        // 提交用 fileID
        imageFileID: fileIds[0] || '',
        imageFileIDs: fileIds,

        thumbFileID: firstValidFileID(thumbIds),
        thumbFileIDs: thumbIds,

        ...normalizePickupWindow(
          x.pickupStartDate || '',
          x.pickupEndDate || x.expiresAtText || '',
          activeListingType
        )
      })
    } catch (e) {
      console.error(e)
      showDataError("内容加载失败", e, "详情从数据库加载失败，请稍后重试。")
    } finally {
      this.setData({ editLoading: false })
    }
  },

  // ========== 顶部返回 ==========
  onBack() {
    wx.navigateBack({ delta: 1 })
  },

  noop() {},

  onTapProfileLocation() {
    wx.navigateTo({ url: "/pages/profile/editInfo/editInfo?from=marketPost" })
  },

  async _getMyUserInfo() {
    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      return (res?.result?.data || [])[0] || {}
    } catch (e) {
      console.error("[marketPost] getUserInfo failed:", e)
      showDataError("资料加载失败", e, "个人资料从数据库加载失败，请稍后重试。")
      return null
    }
  },

  _promptEditProfile(title, content) {
    wx.showModal({
      title,
      content,
      confirmText: "去填写",
      cancelText: "取消",
      success: res => {
        if (res.confirm) this.onTapProfileLocation()
      }
    })
  },

  _applyProfileToForm(user = {}) {
    const profileWechatID = normalizeLocationText(user.wechatID)
    const regionDisplay = buildProfileRegionDisplay(user || {})
    const locationDisplay = buildProfileMapLocationDisplay(user || {})
    const updates = { profileWechatID }

    if (!this._locationTouched && (regionDisplay || locationDisplay)) {
      const location = locationDisplay ? buildLocationMeta(locationDisplay, {
        ...(user.location || {}),
        region: regionDisplay,
        source: user.location ? (user.location.source || "profile") : "profile"
      }) : {}
      Object.assign(updates, {
        region: regionDisplay,
        locationInput: locationDisplay,
        location
      })
    }

    this._setPostData(updates)
    return updates
  },

  // ========== 登录检查（发布前必须登录且非游客） ==========
  ensureLoginBeforePost() {
    const openid = wx.getStorageSync("openid") || ""
    const isGuest = !!wx.getStorageSync("isGuest")
    if (openid && !isGuest) return true

    wx.setStorageSync("needLoginToast", "请先登录再发布/编辑")
    wx.setStorageSync("pendingPage", {
      url: this.data.isEdit && this.data.editId
        ? `/pages/market/marketPost/marketPost?id=${this.data.editId}&mode=edit&type=${this.data.activeListingType || "goods"}`
        : `/pages/market/marketPost/marketPost?type=${this.data.activeListingType || "goods"}`
    })
    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  _setImageUploadProgress(progress, text = "上传中") {
    const safeProgress = Math.max(0, Math.min(100, Math.round(progress)))
    const current = Number(this.data.imageUploadProgress) || 0
    const nextProgress = safeProgress < current && safeProgress < 100 ? current : safeProgress
    const now = Date.now()

    if (
      nextProgress < 100 &&
      now - (this._lastImageUploadProgressAt || 0) < 120 &&
      nextProgress - current < 3 &&
      text === this.data.imageUploadText
    ) {
      return
    }

    this._lastImageUploadProgressAt = now
    this.setData({
      imageUploadProgress: nextProgress,
      imageUploadText: text
    })
  },

  // ========== 选择图片（最多 6 张，首图字段兼容旧列表） ==========
  async onChooseImage() {
    if (!this.ensureLoginBeforePost()) return
    if (this.data.imageUploading) {
      wx.showToast({ title: "图片上传中", icon: "none" })
      return
    }

    try {
      const baseImages = previewImagesFromState(this.data)
      const baseImageFileIDs = orderedImageFileIDsFromState(this.data)
      const baseThumbFileIDs = orderedThumbFileIDsFromState(this.data)
      const currentCount = Math.max(baseImages.length, baseImageFileIDs.length)
      const remaining = MARKET_MAX_IMAGE_COUNT - currentCount
      if (remaining <= 0) {
        wx.showToast({ title: `最多上传${MARKET_MAX_IMAGE_COUNT}张`, icon: "none" })
        return
      }

      const res = await wx.chooseMedia({
        count: remaining,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"]
      })

      const tempFiles = (res.tempFiles || []).map(x => x.tempFilePath).filter(Boolean).slice(0, remaining)
      if (!tempFiles.length) return

      this._lastImageUploadProgressAt = 0
      const previewImages = baseImages.concat(tempFiles)
      this._setPostData({
        image: previewImages[0] || "",
        images: previewImages,
        imageUploading: true,
        imageUploadProgress: 1,
        imageUploadText: tempFiles.length > 1 ? `准备上传 1/${tempFiles.length}` : "准备上传"
      })

      const uploaded = []
      let failedCount = 0
      for (let i = 0; i < tempFiles.length; i += 1) {
        const localPath = tempFiles[i]
        const stepBase = (i / tempFiles.length) * 100
        const stepSize = 100 / tempFiles.length
        const labelSuffix = tempFiles.length > 1 ? ` ${i + 1}/${tempFiles.length}` : ""
        try {
          this._setImageUploadProgress(stepBase + stepSize * 0.04, `压缩${labelSuffix}`)
          const [mainUploadPath, thumbLocal] = await Promise.all([
            prepareMainImageForUpload(this, localPath),
            genThumbFromFirstImage(this, localPath)
          ])

          let mainProgress = 0
          let thumbProgress = thumbLocal ? 0 : 100
          const updateUploadProgress = () => {
            const weighted = 16 + mainProgress * 0.74 + thumbProgress * 0.10
            this._setImageUploadProgress(
              Math.min(99, stepBase + stepSize * (weighted / 100)),
              `上传${labelSuffix}`
            )
          }

          const thumbUploadPromise = thumbLocal
            ? compressForUpload(thumbLocal, MARKET_THUMB_IMAGE_QUALITY)
              .then(path => {
                thumbProgress = 18
                updateUploadProgress()
                return uploadOne(path, "market_thumb", progress => {
                  thumbProgress = progress
                  updateUploadProgress()
                })
              })
            : Promise.resolve("")

          const [fileID, thumbFID] = await Promise.all([
            uploadOne(mainUploadPath, "market", progress => {
              mainProgress = progress
              updateUploadProgress()
            }),
            thumbUploadPromise
          ])

          if (!fileID) throw new Error("empty_file_id")
          uploaded.push({ localPath, fileID, thumbFID: thumbFID || "" })
        } catch (uploadError) {
          failedCount += 1
          console.error("[marketPost] image upload failed:", uploadError)
        }
      }

      const nextImages = baseImages.concat(uploaded.map(item => item.localPath))
      const nextImageFileIDs = uniqFileIDs(baseImageFileIDs.concat(uploaded.map(item => item.fileID)))
      const nextThumbFileIDs = baseThumbFileIDs.concat(uploaded.map(item => item.thumbFID || ""))
      const uploadText = failedCount ? "部分完成" : "已完成"
      this._setPostData({
        image: nextImages[0] || "",
        images: nextImages,
        imageFileID: nextImageFileIDs[0] || "",
        imageFileIDs: nextImageFileIDs,
        thumbFileID: firstValidFileID(nextThumbFileIDs),
        thumbFileIDs: nextThumbFileIDs,
        imageUploading: false,
        imageUploadProgress: uploaded.length ? 100 : 0,
        imageUploadText: uploadText
      })

      if (!uploaded.length) {
        wx.showToast({ title: "上传失败", icon: "none" })
      } else if (failedCount) {
        wx.showToast({ title: "部分图片上传失败", icon: "none" })
      } else {
        wx.showToast({ title: "上传成功", icon: "success" })
      }
    } catch (e) {
      if (String(e && e.errMsg || "").toLowerCase().includes("cancel")) return
      console.error(e)
      wx.showToast({ title: "选择/上传失败", icon: "none" })
      this._setPostData({
        imageUploading: false,
        images: previewImagesFromState(this.data),
        image: previewImagesFromState(this.data)[0] || ""
      })
    }
  },

  onPreviewPostImage(e) {
    const images = previewImagesFromState(this.data)
    if (!images.length) return
    const index = Number(e.currentTarget?.dataset?.index || 0)
    wx.previewImage({
      urls: images,
      current: images[index] || images[0]
    })
  },

  onRemoveImage(e) {
    if (this.data.imageUploading) {
      wx.showToast({ title: "图片上传中", icon: "none" })
      return
    }
    const index = Number(e.currentTarget?.dataset?.index)
    const images = previewImagesFromState(this.data)
    if (!Number.isInteger(index) || index < 0 || index >= images.length) return

    const imageFileIDs = orderedImageFileIDsFromState(this.data)
    const thumbFileIDs = orderedThumbFileIDsFromState(this.data)
    images.splice(index, 1)
    if (index < imageFileIDs.length) imageFileIDs.splice(index, 1)
    if (index < thumbFileIDs.length) thumbFileIDs.splice(index, 1)

    this._setPostData({
      image: images[0] || "",
      images,
      imageFileID: imageFileIDs[0] || "",
      imageFileIDs,
      thumbFileID: firstValidFileID(thumbFileIDs),
      thumbFileIDs
    })
  },

  // ========== 输入 ==========
  onTitleInput(e) {
    this.setData({ title: e.detail.value || "" })
  },
  onDescInput(e) {
    this.setData({ desc: e.detail.value || "" })
  },
  onPriceInput(e) {
    this.setData({ price: normalizeOptionalNumberText(e.detail.value) })
  },
  onDepositInput(e) {
    this._setPostData({ deposit: normalizeOptionalNumberText(e.detail.value) })
  },
  onRoommateCountInput(e) {
    this._setPostData({ roommateCount: String(e.detail.value || "").replace(/[^\d]/g, "") })
  },

  onPickupStartDateChange(e) {
    const start = e.detail.value || this.data.pickupStartDate
    this.setData(normalizePickupWindow(start, this.data.pickupEndDate, this.data.activeListingType))
  },

  onPickupEndDateChange(e) {
    const end = e.detail.value || this.data.pickupEndDate
    this.setData(normalizePickupWindow(this.data.pickupStartDate, end, this.data.activeListingType))
  },

  // ========== 分类 picker ==========
  onCategoryPickerChange(e) {
    const idx = Number(e.detail.value)
    const options = this.data.categoryOptions || getListingTypeConfig(this.data.activeListingType).categoryOptions
    const fallback = getListingTypeConfig(this.data.activeListingType).defaultCategory
    const fallbackIndex = Math.max(0, options.indexOf(fallback))
    const categoryIndex = idx >= 0 && idx < options.length ? idx : fallbackIndex
    const category = options[categoryIndex] || fallback
    this._setPostData({ categoryIndex, category })
  },

  onHousingTypePickerChange(e) {
    const idx = Number(e.detail.value)
    const options = this.data.housingTypeOptions || SUBLET_HOUSING_OPTIONS
    const housingTypeIndex = idx >= 0 && idx < options.length ? idx : 0
    const housingType = options[housingTypeIndex] === "未填写" ? "" : (options[housingTypeIndex] || "")
    this._setPostData({ housingTypeIndex, housingType })
  },

  onGenderPreferencePickerChange(e) {
    const idx = Number(e.detail.value)
    const options = this.data.genderPreferenceOptions || SUBLET_GENDER_OPTIONS
    const genderPreferenceIndex = idx >= 0 && idx < options.length ? idx : 0
    const genderPreference = options[genderPreferenceIndex] || "不限"
    this._setPostData({ genderPreferenceIndex, genderPreference })
  },

  onToggleFurnished() {
    this._setPostData({ furnished: !this.data.furnished })
  },

  onToggleUtilities() {
    this._setPostData({ utilitiesIncluded: !this.data.utilitiesIncluded })
  },

  // ========== 新旧程度 ==========
onChooseCondition() {
  wx.showActionSheet({
    itemList: this.data.conditionOptions || [],
    success: (res) => {
      const idx = res.tapIndex
      const val = (this.data.conditionOptions || [])[idx]
      if (val) this.setData({ condition: val })
    }
  })
},


  // ========== 提交：发布 / 编辑 ==========
  async onSubmit() {
    if (this._submitInFlight || this.data.submitting) return
    if (!this.ensureLoginBeforePost()) return

    const {
      imageFileID,
      title,
      desc,
      category,
      price,
      condition,
      pickupStartDate,
      pickupEndDate
    } = this.data
    const imageFileIDs = uniqFileIDs([imageFileID, ...(Array.isArray(this.data.imageFileIDs) ? this.data.imageFileIDs : [])])
    const thumbFileIDs = uniqFileIDs([this.data.thumbFileID, ...(Array.isArray(this.data.thumbFileIDs) ? this.data.thumbFileIDs : [])])
    const config = getListingTypeConfig(this.data.activeListingType)
    const pickupWindow = normalizePickupWindow(pickupStartDate, pickupEndDate, this.data.activeListingType)
    const expireTime = endOfDayTime(pickupWindow.pickupEndDate)
    const hasImage = imageFileIDs.length > 0

    if (this.data.imageUploading) {
      return wx.showToast({ title: "图片还在上传中", icon: "none" })
    }
    if (!title.trim()) return wx.showToast({ title: "请输入标题", icon: "none" })
    if (!category) return wx.showToast({ title: "请选择分类", icon: "none" })

    this._submitInFlight = true
    this._setPostData({ submitting: true })
    let keepSubmitLocked = false

    try {
      const profile = await this._getMyUserInfo()
      if (!profile) return
      const profileUpdates = this.data.isEdit
        ? { profileWechatID: normalizeLocationText(profile.wechatID) }
        : this._applyProfileToForm(profile)
      if (this.data.isEdit) this._setPostData(profileUpdates)
      if (!normalizeLocationText(profile.wechatID)) {
        this._promptEditProfile("请先填写微信号", `${config.submitCreate}前需要在个人资料里填写微信号，方便联系。`)
        return
      }

      const region = normalizeLocationText(profileUpdates.region || this.data.region)
      const locationSource = profileUpdates.location || this.data.location || {}
      const locationName = normalizeLocationText(
        profileUpdates.locationInput ||
        this.data.locationInput ||
        locationSource.displayName ||
        locationSource.name ||
        locationSource.address
      )
      const location = buildLocationMeta(locationName, {
        ...locationSource,
        region
      })
      if (!region) {
        this._promptEditProfile("请先选择地区", `${config.submitCreate}前需要填写地区树位置，用于筛选和展示。`)
        return
      }
      if (!hasLatLng(location)) {
        this._promptEditProfile("请先手动选点", `${config.submitCreate}前需要在个人资料里选择位置，用于计算距离。`)
        return
      }
      if (!expireTime) return wx.showToast({ title: `请选择${config.pickupEndLabel}`, icon: "none" })

      const clientRequestId = this._activeSubmitRequestId || createSubmitRequestId()
      this._activeSubmitRequestId = clientRequestId

      const payload = {
        listingType: this.data.activeListingType || "goods",
        title: String(title).trim(),
        price: Number(price || 0),
        category,
        region,
        location,
        condition: condition || config.defaultCondition,
        desc: desc || "",
        imageFileID: imageFileIDs[0] || "",
        imageFileIDs,
        thumbFileID: thumbFileIDs[0] || "",
        thumbFileIDs,
        hasImage,
        pickupStartDate: pickupWindow.pickupStartDate,
        pickupEndDate: pickupWindow.pickupEndDate,
        availableStartDate: this.data.activeListingType === "sublet" ? pickupWindow.pickupStartDate : "",
        leaseEndDate: this.data.activeListingType === "sublet" ? pickupWindow.pickupEndDate : "",
        deposit: this.data.activeListingType === "sublet" ? this.data.deposit : "",
        roomType: this.data.activeListingType === "sublet" ? category : "",
        housingType: this.data.activeListingType === "sublet" ? this.data.housingType : "",
        furnished: this.data.activeListingType === "sublet" ? !!this.data.furnished : false,
        utilitiesIncluded: this.data.activeListingType === "sublet" ? !!this.data.utilitiesIncluded : false,
        genderPreference: this.data.activeListingType === "sublet" ? this.data.genderPreference : "",
        roommateCount: this.data.activeListingType === "sublet" ? this.data.roommateCount : "",
        pickupRangeText: pickupWindow.pickupRangeText,
        expireTime,
        expiresAtText: pickupWindow.pickupEndDate,
        status: "online",
        clientRequestId
      }

      if (this.data.isEdit && this.data.editId) {
        const updRes = await wx.cloud.callFunction({
          name: "marketApi",
          data: { action: "update", id: this.data.editId, patch: payload }
        })

        getMarketApiResult(updRes)

        markMarketGoodsChanged()
        keepSubmitLocked = true
        wx.showToast({ title: "已保存", icon: "success" })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 900)
        return
      }

      const checkRes = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "create", payload }
      })

      getMarketApiResult(checkRes)

      markMarketGoodsChanged()
      keepSubmitLocked = true
      wx.showToast({ title: this.data.isEdit ? "已保存" : "已提交", icon: "success" })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 900)
    } catch (e) {
      console.error(e)
      showDataError("发布失败", e, "发布信息保存到数据库失败，请稍后重试。")
    } finally {
      if (!keepSubmitLocked) {
        this._submitInFlight = false
        this._setPostData({ submitting: false })
      }
    }
  }
})
