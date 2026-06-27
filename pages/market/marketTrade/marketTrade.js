// pages/market/marketTrade/marketTrade.js
const { showDataError } = require("../../../utils/error")
const {
  ALL_AREA_LABEL,
  DEFAULT_REGION_TREE,
  normalizeRegionTree,
  findState,
  findArea
} = require("../../../utils/regionTree")

const MARKET_REFRESH_KEY = "market_goods_changed_at"
const MARKET_MAIN_IMAGE_QUALITY = 52
const MARKET_THUMB_IMAGE_QUALITY = 42
const MARKET_MAX_IMAGE_COUNT = 6
const GOODS_CATEGORY_OPTIONS = ["家具", "厨具", "电器", "服包鞋饰", "电子产品", "运动装备", "食品", "其他"]
const SUBLET_CATEGORY_OPTIONS = ["Studio", "1B1B", "2B1B", "2B2B", "3B2B", "其他"]
const LISTING_TYPE_OPTIONS = [
  { key: "goods", label: "二手" },
  { key: "sublet", label: "转租" }
]
const CITY_OPTIONS = [
  { key: "ny_nj", label: "纽约/新泽西", stateKey: "NY_NJ" },
  { key: "other_city", label: "其他城市", stateKey: "OTHER" }
]
const REGION_TREE = normalizeRegionTree(DEFAULT_REGION_TREE)

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function formatMarketPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : "0"
}

function normalizeListingType(value) {
  const text = normalizeText(value).toLowerCase()
  if (["sublet", "rent", "lease", "转租", "房源"].includes(text)) return "sublet"
  return "goods"
}

function getCategoryOptions(listingType) {
  return normalizeListingType(listingType) === "sublet" ? SUBLET_CATEGORY_OPTIONS : GOODS_CATEGORY_OPTIONS
}

function getDefaultCategory(listingType) {
  return normalizeListingType(listingType) === "sublet" ? "Studio" : "其他"
}

function getCityOption(cityKey = "ny_nj") {
  const key = normalizeText(cityKey).toLowerCase()
  if (["ny", "nj", "new york", "nyc", "纽约", "new jersey", "jersey", "新泽西", "ny/nj", "纽约/新泽西"].includes(key)) return CITY_OPTIONS[0]
  return CITY_OPTIONS.find(item => item.key === key) || CITY_OPTIONS[0]
}

function normalizeAreaLabel(area = {}, stateKey = "") {
  const key = normalizeText(area.key).toLowerCase()
  if (stateKey && key === `${normalizeText(stateKey).toLowerCase()}_all`) return ALL_AREA_LABEL
  return normalizeText(area.label)
}

function getAreaOptions(cityKey = "ny_nj") {
  const city = getCityOption(cityKey)
  const state = findState(REGION_TREE, city.stateKey)
  if (!state) {
    return [{ key: `${city.stateKey.toLowerCase()}_all`, label: ALL_AREA_LABEL, stateKey: city.stateKey }]
  }
  return (state.areas || []).map(area => ({
    key: normalizeText(area.key),
    label: normalizeAreaLabel(area, state.key),
    stateKey: state.key
  })).filter(item => item.key && item.label)
}

function getAreaOption(cityKey = "ny_nj", areaKeyOrLabel = "") {
  const city = getCityOption(cityKey)
  const state = findState(REGION_TREE, city.stateKey)
  const raw = normalizeText(areaKeyOrLabel)
  if (state && raw) {
    const matched = findArea(state, raw)
    if (matched) {
      return {
        key: normalizeText(matched.key),
        label: normalizeAreaLabel(matched, state.key),
        stateKey: state.key
      }
    }
  }
  return getAreaOptions(city.key)[0]
}

function formatDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function addDays(date, days) {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

function parseFileIDs(text) {
  return normalizeText(text)
    .split(/[\n,，\s]+/)
    .map(normalizeText)
    .filter(value => value.startsWith("cloud://"))
}

function normalizeFileID(fileID) {
  const value = normalizeText(fileID)
  return value.startsWith("cloud://") ? value : ""
}

function uniqFileIDs(fileIDs = []) {
  return Array.from(new Set((fileIDs || []).map(normalizeFileID).filter(Boolean)))
}

function firstValidFileID(fileIDs = []) {
  return fileIDs.map(normalizeFileID).find(Boolean) || ""
}

function previewImagesFromDraft(draft = {}) {
  const images = Array.isArray(draft.images) ? draft.images.filter(Boolean) : []
  if (!images.length && draft.image) images.push(draft.image)
  return Array.from(new Set(images))
}

function orderedImageFileIDsFromDraft(draft = {}) {
  const list = uniqFileIDs([
    draft.imageFileID,
    ...(Array.isArray(draft.imageFileIDs) ? draft.imageFileIDs : []),
    ...parseFileIDs(draft.imageFileIDsText)
  ])
  return list
}

function orderedThumbFileIDsFromDraft(draft = {}) {
  const list = [
    normalizeFileID(draft.thumbFileID),
    ...(Array.isArray(draft.thumbFileIDs) ? draft.thumbFileIDs.map(normalizeFileID) : []),
    ...parseFileIDs(draft.thumbFileIDsText)
  ].filter(Boolean)
  return Array.from(new Set(list))
}

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
        if (typeof onProgress === "function") onProgress(Math.max(0, Math.min(100, Number(res.progress) || 0)))
      })
    }
  })
}

function buildRegionDisplay(cityLabel, areaLabel, buildingName = "") {
  return [cityLabel, areaLabel, buildingName].map(normalizeText).filter(Boolean).join(" / ")
}

function defaultAdminDraft(overrides = {}) {
  const today = new Date()
  const listingType = normalizeListingType(overrides.listingType)
  const city = getCityOption(overrides.cityKey || overrides.city || "ny_nj")
  const area = getAreaOption(city.key, overrides.regionKey || overrides.regionArea || overrides.area)
  return {
    listingType,
    title: "",
    price: "0",
    category: getDefaultCategory(listingType),
    condition: listingType === "sublet" ? "转租" : "99新",
    desc: "",
    sellerName: "",
    sellerWechat: "",
    sellerPhone: "",
    cityKey: city.key,
    cityLabel: city.label,
    regionState: city.stateKey,
    regionKey: area.key,
    regionArea: area.label,
    buildingName: "",
    detailAddress: "",
    pickupStartDate: formatDateOnly(today),
    pickupEndDate: formatDateOnly(addDays(today, 14)),
    deposit: "",
    housingType: "",
    furnished: false,
    utilitiesIncluded: false,
    genderPreference: "不限",
    roommateCount: "",
    image: "",
    images: [],
    imageFileID: "",
    imageFileIDs: [],
    thumbFileID: "",
    thumbFileIDs: [],
    imageFileIDsText: "",
    thumbFileIDsText: "",
    imageUploading: false,
    imageUploadProgress: 0,
    imageUploadText: "",
    externalId: "",
    location: {},
    ...overrides
  }
}

function pick(row = {}, keys = []) {
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  return ""
}

function normalizeImportedDraft(row = {}) {
  const listingType = normalizeListingType(pick(row, ["listingType", "type", "类型", "发布类型"]))
  const cityRaw = pick(row, ["cityKey", "city", "城市"])
  const city = getCityOption(cityRaw || "ny_nj")
  const area = getAreaOption(city.key, pick(row, ["regionKey", "regionArea", "area", "区域", "小区域"]))
  const imageFileIDs = Array.isArray(row.imageFileIDs)
    ? row.imageFileIDs.map(normalizeFileID).filter(Boolean)
    : parseFileIDs(pick(row, ["imageFileIDs", "images", "图片"]))
  const thumbFileIDs = Array.isArray(row.thumbFileIDs)
    ? row.thumbFileIDs.map(normalizeFileID).filter(Boolean)
    : parseFileIDs(pick(row, ["thumbFileIDs", "thumbs", "缩略图"]))
  return defaultAdminDraft({
    listingType,
    title: normalizeText(pick(row, ["title", "标题", "商品名称", "房源标题", "name"])),
    price: normalizeText(pick(row, ["price", "价格", "月租"])) || "0",
    category: normalizeText(pick(row, ["category", "分类", "房型", "roomType"])) || getDefaultCategory(listingType),
    condition: normalizeText(pick(row, ["condition", "新旧程度", "状态"])) || (listingType === "sublet" ? "转租" : "99新"),
    desc: String(pick(row, ["desc", "description", "描述", "详情"]) || ""),
    sellerName: normalizeText(pick(row, ["sellerName", "displayName", "contactName", "显示名字", "联系人", "名字"])),
    sellerWechat: normalizeText(pick(row, ["sellerWechat", "wechat", "wechatID", "微信", "微信号"])),
    sellerPhone: normalizeText(pick(row, ["sellerPhone", "phone", "电话", "手机号"])),
    cityKey: city.key,
    cityLabel: city.label,
    regionState: city.stateKey,
    regionKey: area.key,
    regionArea: area.label,
    buildingName: normalizeText(pick(row, ["buildingName", "building", "大楼", "公寓", "大楼名称"])),
    detailAddress: normalizeText(pick(row, ["detailAddress", "address", "详细地址", "精确地址"])),
    pickupStartDate: normalizeText(pick(row, ["pickupStartDate", "availableStartDate", "开始日期", "入住时间"])) || defaultAdminDraft({ listingType }).pickupStartDate,
    pickupEndDate: normalizeText(pick(row, ["pickupEndDate", "leaseEndDate", "结束日期", "租期结束"])) || defaultAdminDraft({ listingType }).pickupEndDate,
    deposit: normalizeText(pick(row, ["deposit", "押金"])),
    housingType: normalizeText(pick(row, ["housingType", "房源类型"])),
    furnished: pick(row, ["furnished", "家具"]) === true || ["true", "1", "是", "带家具"].includes(normalizeText(pick(row, ["furnished", "家具"]))),
    utilitiesIncluded: pick(row, ["utilitiesIncluded", "水电网"]) === true || ["true", "1", "是", "包含", "包水电网"].includes(normalizeText(pick(row, ["utilitiesIncluded", "水电网"]))),
    genderPreference: normalizeText(pick(row, ["genderPreference", "室友要求"])) || "不限",
    roommateCount: normalizeText(pick(row, ["roommateCount", "室友数"])),
    imageFileID: imageFileIDs[0] || "",
    imageFileIDs,
    thumbFileID: thumbFileIDs[0] || "",
    thumbFileIDs,
    image: Array.isArray(row.images) && row.images.length ? row.images[0] : (row.image || ""),
    images: Array.isArray(row.images) ? row.images.filter(Boolean) : [],
    imageFileIDsText: imageFileIDs.join("\n"),
    thumbFileIDsText: thumbFileIDs.join("\n"),
    location: row.location && typeof row.location === "object" ? row.location : {},
    externalId: normalizeText(pick(row, ["externalId", "importId", "导入ID"]))
  })
}

function parseDelimitedText(text) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const delimiter = lines[0].includes("\t") ? "\t" : ","
  const headers = lines[0].split(delimiter).map(normalizeText)
  return lines.slice(1).map(line => {
    const values = line.split(delimiter)
    const row = {}
    headers.forEach((header, index) => {
      row[header] = normalizeText(values[index])
    })
    return row
  })
}

function parseAdminImportText(text) {
  const raw = String(text || "").trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : [])
    if (list.length) return list.map(normalizeImportedDraft)
  } catch (e) {}
  return parseDelimitedText(raw).map(normalizeImportedDraft)
}

function validateDraft(draft = {}) {
  if (!normalizeText(draft.title)) return "请填写标题"
  if (!Number.isFinite(Number(draft.price)) || Number(draft.price) < 0) return "价格格式不正确"
  if (!normalizeText(draft.category)) return "请选择分类"
  if (!normalizeText(draft.sellerName)) return "请填写显示名字"
  if (!normalizeText(draft.sellerWechat)) return "请填写微信号"
  if (!normalizeText(draft.cityKey) || !normalizeText(draft.regionKey) || !normalizeText(draft.regionArea)) return "请选择城市和小区域"
  return ""
}

function attachDraftKeys(list = []) {
  return (Array.isArray(list) ? list : []).map((item, index) => ({
    ...item,
    draftKey: item.draftKey || `${Date.now()}_${index}_${Math.random().toString(16).slice(2, 8)}`
  }))
}

function draftToPayload(draft = {}) {
  const city = getCityOption(draft.cityKey)
  const area = getAreaOption(city.key, draft.regionKey || draft.regionArea)
  const listingType = normalizeListingType(draft.listingType)
  const buildingName = normalizeText(draft.buildingName)
  const regionDisplay = buildRegionDisplay(city.label, area.label, buildingName)
  const detailAddress = normalizeText(draft.detailAddress)
  const imageFileIDs = orderedImageFileIDsFromDraft(draft)
  const thumbFileIDs = orderedThumbFileIDsFromDraft(draft)
  const draftLocation = draft.location && typeof draft.location === "object" ? draft.location : {}
  const payload = {
    listingType,
    title: normalizeText(draft.title),
    price: Number(draft.price) || 0,
    category: normalizeText(draft.category) || getDefaultCategory(listingType),
    cityKey: city.key,
    cityLabel: city.label,
    region: regionDisplay,
    regionState: city.stateKey,
    regionArea: area.label,
    regionKey: area.key,
    buildingName,
    regionDisplay,
    location: {
      ...draftLocation,
      displayName: normalizeText(draftLocation.displayName || draftLocation.name || detailAddress || regionDisplay),
      name: normalizeText(draftLocation.name || detailAddress),
      address: normalizeText(draftLocation.address || detailAddress),
      cityKey: city.key,
      cityLabel: city.label,
      region: regionDisplay,
      regionState: city.stateKey,
      regionArea: area.label,
      areaLabel: area.label,
      regionKey: area.key,
      buildingName,
      source: normalizeText(draftLocation.source || "adminBulkManual"),
      provider: normalizeText(draftLocation.provider || "adminBulkManual"),
      updatedAtMs: Date.now()
    },
    condition: normalizeText(draft.condition) || (listingType === "sublet" ? "转租" : "99新"),
    desc: String(draft.desc || ""),
    pickupStartDate: normalizeText(draft.pickupStartDate),
    pickupEndDate: normalizeText(draft.pickupEndDate),
    imageFileID: imageFileIDs[0] || "",
    imageFileIDs,
    thumbFileID: thumbFileIDs[0] || "",
    thumbFileIDs,
    hasImage: imageFileIDs.length > 0,
    sellerName: normalizeText(draft.sellerName),
    sellerWechat: normalizeText(draft.sellerWechat),
    sellerPhone: normalizeText(draft.sellerPhone),
    externalId: normalizeText(draft.externalId)
  }

  if (listingType === "sublet") {
    payload.availableStartDate = payload.pickupStartDate
    payload.leaseEndDate = payload.pickupEndDate
    payload.deposit = normalizeText(draft.deposit)
    payload.roomType = payload.category
    payload.housingType = normalizeText(draft.housingType)
    payload.furnished = draft.furnished === true
    payload.utilitiesIncluded = draft.utilitiesIncluded === true
    payload.genderPreference = normalizeText(draft.genderPreference) || "不限"
    payload.roommateCount = normalizeText(draft.roommateCount)
  }

  return payload
}

function draftToTemplatePayload(draft = {}) {
  const payload = draftToPayload({
    ...draft,
    images: [],
    image: "",
    imageFileID: "",
    imageFileIDs: [],
    thumbFileID: "",
    thumbFileIDs: [],
    imageFileIDsText: "",
    thumbFileIDsText: "",
    desc: ""
  })
  delete payload.imageFileID
  delete payload.imageFileIDs
  delete payload.thumbFileID
  delete payload.thumbFileIDs
  delete payload.hasImage
  delete payload.desc
  return payload
}

function templateToDraft(template = {}) {
  const data = template.data || template
  return defaultAdminDraft({
    ...data,
    price: data.price === 0 || data.price ? String(data.price) : "0",
    deposit: data.deposit === 0 || data.deposit ? String(data.deposit) : "",
    roommateCount: data.roommateCount === 0 || data.roommateCount ? String(data.roommateCount) : "",
    desc: "",
    image: "",
    images: [],
    imageFileID: "",
    imageFileIDs: [],
    thumbFileID: "",
    thumbFileIDs: [],
    imageFileIDsText: "",
    thumbFileIDsText: "",
    imageUploading: false,
    imageUploadProgress: 0,
    imageUploadText: "",
    externalId: ""
  })
}

function buildTradeDisplayPatch(type, list = []) {
  return {
    pageTitle: type === "bought" ? "我买到的" : "我卖出的",
    summaryTitle: type === "sold" ? "卖出记录" : "买入记录",
    contactRoleText: type === "sold" ? "买家微信" : "卖家微信",
    listCountText: `${list.length} 条记录`,
    listEmpty: list.length === 0
  }
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    throw new Error((result && (result.error || result.message)) || "market_api_failed")
  }
  return result
}

function buildTradeItem(x = {}, type = "sold") {
  const listingType = normalizeListingType(x.listingType)
  const imageKey = x.thumbFileID || x.imageFileID || ""
  const priceText = formatMarketPrice(x.price)
  const title = normalizeText(x.title) || (listingType === "sublet" ? "未命名房源" : "未命名商品")
  const metaText = listingType === "sublet"
    ? (x.leaseText || x.availableStartDate || x.roomType || x.category || "转租")
    : (x.condition || x.pickupEndDate || "闲置")
  return {
    id: x._id,
    listingType,
    title,
    price: x.price || "",
    priceText,
    priceDisplay: listingType === "sublet" ? `${priceText}/月` : priceText,
    metaText,
    imageFileID: x.imageFileID || "",
    thumbFileID: x.thumbFileID || "",
    hasImage: !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length)),
    imageSrc: x.imageSrc || x.thumbUrl || imageKey || (listingType === "sublet" ? "/images/sublease.png" : "/images/market.png"),
    thumbUrl: x.thumbUrl || "",
    otherOpenid: x.otherOpenid || (type === "sold" ? (x.buyerOpenid || "") : (x._openid || "")),
    contactWechat: x.contactWechat || ""
  }
}

function markMarketGoodsChanged() {
  try {
    wx.setStorageSync(MARKET_REFRESH_KEY, Date.now())
  } catch (e) {}
}

Page({
  data: {
    statusBarHeight: 0,
    type: "sold",
    pageTitle: "我卖出的",
    summaryTitle: "卖出记录",
    contactRoleText: "买家微信",
    listCountText: "0 条记录",
    listEmpty: true,
    myOpenid: "",
    list: [],

    adminChecked: false,
    isAdmin: false,
    adminPanelVisible: false,
    adminLoading: false,
    adminSummaryText: "",
    adminImportText: "",
    adminDrafts: [],
    adminSelectedIndex: -1,
    adminForm: defaultAdminDraft(),
    adminResults: [],
    adminFailures: [],
    adminTemplateName: "",
    adminTemplates: [],
    adminTemplateIndex: -1,

    listingTypeOptions: LISTING_TYPE_OPTIONS,
    adminListingTypeIndex: 0,
    cityOptions: CITY_OPTIONS,
    adminCityIndex: 0,
    adminAreaOptions: getAreaOptions("ny_nj"),
    adminAreaIndex: 0,
    adminCategoryOptions: GOODS_CATEGORY_OPTIONS,
    adminCategoryIndex: GOODS_CATEGORY_OPTIONS.indexOf("其他"),
    adminImageCountText: "0/6",
    adminCanAddImage: true,
    adminRegionDisplay: "纽约/新泽西 / 哥大步行楼",
    adminDetailAddressDisplay: "地图选点",
    adminDetailAddressMutedClass: "muted",
    adminShowSubletFields: false
  },

  onLoad(options) {
    const sys = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const type = options?.type === "bought" ? "bought" : "sold"

    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      type,
      ...buildTradeDisplayPatch(type, [])
    })

    this.init()
  },

  onPullDownRefresh() {
    this.init().finally(() => wx.stopPullDownRefresh())
  },

  onBack() {
    wx.navigateBack({ delta: 1 })
  },

  noop() {},

  async init() {
    await Promise.all([
      this.fetchList(),
      this.checkAdminStatus()
    ])
  },

  async checkAdminStatus() {
    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "adminStatus" }
      })
      const result = getMarketApiResult(res)
      this.setData({
        adminChecked: true,
        isAdmin: !!result.isAdmin,
        myOpenid: result.openid || this.data.myOpenid
      })
      if (result.isAdmin) this.loadAdminTemplates()
    } catch (e) {
      this.setData({ adminChecked: true, isAdmin: false })
    }
  },

  async fetchList() {
    try {
      const PAGE = 50
      const MAX_TOTAL = 1000

      let rows = []
      let skip = 0
      let myOpenid = this.data.myOpenid || ""

      while (true) {
        const res = await wx.cloud.callFunction({
          name: "marketApi",
          data: { action: "tradeList", type: this.data.type, skip, limit: PAGE }
        })
        const result = getMarketApiResult(res)
        if (result.openid) myOpenid = result.openid

        const batch = result.items || result.data || []
        rows = rows.concat(batch)

        if (!result.hasMore || batch.length < PAGE) break
        skip = result.nextSkip || (skip + batch.length)
        if (rows.length >= MAX_TOTAL) break
      }

      const list = rows.map(x => buildTradeItem(x, this.data.type))

      this.setData({
        myOpenid,
        list,
        ...buildTradeDisplayPatch(this.data.type, list)
      })
    } catch (e) {
      console.error("fetchList error", e)
      showDataError("交易加载失败", e, "交易列表从数据库加载失败，请稍后重试。")
    }
  },

  onOpenDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  onCopyWechat(e) {
    const wxid = e.currentTarget.dataset.wx || ""
    if (!wxid) {
      wx.showToast({ title: "对方未填写微信号", icon: "none" })
      return
    }
    wx.setClipboardData({
      data: wxid,
      success: () => wx.showToast({ title: "已复制微信号", icon: "success" })
    })
  },

  onToggleAdminPanel() {
    if (!this.data.isAdmin) return
    const next = !this.data.adminPanelVisible
    this.setData({ adminPanelVisible: next })
    if (next && !this.data.adminDrafts.length) this._setAdminForm(defaultAdminDraft())
  },

  _buildAdminFormPatch(form = {}) {
    const listingType = normalizeListingType(form.listingType)
    const categoryOptions = getCategoryOptions(listingType)
    const city = getCityOption(form.cityKey)
    const areaOptions = getAreaOptions(city.key)
    const area = getAreaOption(city.key, form.regionKey || form.regionArea)
    const images = previewImagesFromDraft(form)
    const imageFileIDs = orderedImageFileIDsFromDraft(form)
    const thumbFileIDs = orderedThumbFileIDsFromDraft(form)
    const buildingName = normalizeText(form.buildingName)
    const regionDisplay = buildRegionDisplay(city.label, area.label, buildingName)
    const detailAddress = normalizeText(form.detailAddress || form.location?.address || form.location?.name || form.location?.displayName)
    return {
      adminForm: {
        ...defaultAdminDraft({ listingType, cityKey: city.key, regionKey: area.key }),
        ...form,
        listingType,
        cityKey: city.key,
        cityLabel: city.label,
        regionState: city.stateKey,
        regionKey: area.key,
        regionArea: area.label,
        buildingName,
        detailAddress,
        category: categoryOptions.includes(form.category) ? form.category : getDefaultCategory(listingType),
        image: images[0] || "",
        images,
        imageFileID: imageFileIDs[0] || "",
        imageFileIDs,
        thumbFileID: firstValidFileID(thumbFileIDs),
        thumbFileIDs,
        imageFileIDsText: imageFileIDs.join("\n"),
        thumbFileIDsText: thumbFileIDs.join("\n")
      },
      adminListingTypeIndex: Math.max(0, LISTING_TYPE_OPTIONS.findIndex(item => item.key === listingType)),
      adminCityIndex: Math.max(0, CITY_OPTIONS.findIndex(item => item.key === city.key)),
      adminAreaOptions: areaOptions,
      adminAreaIndex: Math.max(0, areaOptions.findIndex(item => item.key === area.key)),
      adminCategoryOptions: categoryOptions,
      adminCategoryIndex: Math.max(0, categoryOptions.indexOf(categoryOptions.includes(form.category) ? form.category : getDefaultCategory(listingType))),
      adminImageCountText: `${Math.max(images.length, imageFileIDs.length)}/${MARKET_MAX_IMAGE_COUNT}`,
      adminCanAddImage: Math.max(images.length, imageFileIDs.length) < MARKET_MAX_IMAGE_COUNT,
      adminRegionDisplay: regionDisplay,
      adminDetailAddressDisplay: detailAddress || "地图选点",
      adminDetailAddressMutedClass: detailAddress ? "" : "muted",
      adminShowSubletFields: listingType === "sublet"
    }
  },

  _setAdminForm(form = {}) {
    this.setData(this._buildAdminFormPatch(form))
  },

  onAdminFormInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    if (["buildingName", "detailAddress"].includes(field)) {
      this._setAdminForm({ ...this.data.adminForm, [field]: e.detail.value })
      return
    }
    this.setData({ [`adminForm.${field}`]: e.detail.value })
  },

  onAdminSwitchChange(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [`adminForm.${field}`]: !!e.detail.value })
  },

  onAdminSwitchTap(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [`adminForm.${field}`]: !this.data.adminForm[field] })
  },

  onAdminListingTypeChange(e) {
    const option = LISTING_TYPE_OPTIONS[Number(e.detail.value)] || LISTING_TYPE_OPTIONS[0]
    const next = {
      ...this.data.adminForm,
      listingType: option.key,
      category: getDefaultCategory(option.key),
      condition: option.key === "sublet" ? "转租" : "99新"
    }
    this._setAdminForm(next)
  },

  onAdminCategoryChange(e) {
    const options = this.data.adminCategoryOptions || getCategoryOptions(this.data.adminForm.listingType)
    const category = options[Number(e.detail.value)] || options[0]
    this.setData({
      "adminForm.category": category,
      adminCategoryIndex: Math.max(0, options.indexOf(category))
    })
  },

  onAdminCityChange(e) {
    const city = CITY_OPTIONS[Number(e.detail.value)] || CITY_OPTIONS[0]
    const area = getAreaOptions(city.key)[0]
    this._setAdminForm({
      ...this.data.adminForm,
      cityKey: city.key,
      cityLabel: city.label,
      regionState: city.stateKey,
      regionKey: area.key,
      regionArea: area.label
    })
  },

  onAdminAreaChange(e) {
    const area = (this.data.adminAreaOptions || [])[Number(e.detail.value)] || this.data.adminAreaOptions[0]
    if (!area) return
    this.setData({
      "adminForm.regionKey": area.key,
      "adminForm.regionArea": area.label,
      adminAreaIndex: Math.max(0, (this.data.adminAreaOptions || []).findIndex(item => item.key === area.key))
    })
  },

  onAdminDateChange(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [`adminForm.${field}`]: e.detail.value })
  },

  _setAdminImageUploadProgress(progress, text) {
    const nextProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)))
    this.setData({
      "adminForm.imageUploadProgress": nextProgress,
      "adminForm.imageUploadText": text || "上传中"
    })
  },

  async onAdminChooseImage() {
    if (this.data.adminForm.imageUploading) {
      wx.showToast({ title: "图片上传中", icon: "none" })
      return
    }
    try {
      const form = this.data.adminForm || {}
      const baseImages = previewImagesFromDraft(form)
      const baseImageFileIDs = orderedImageFileIDsFromDraft(form)
      const baseThumbFileIDs = orderedThumbFileIDsFromDraft(form)
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

      this._setAdminForm({
        ...form,
        image: baseImages.concat(tempFiles)[0] || "",
        images: baseImages.concat(tempFiles),
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
          this._setAdminImageUploadProgress(stepBase + stepSize * 0.06, `压缩${labelSuffix}`)
          const [mainPath, thumbPath] = await Promise.all([
            compressForUpload(localPath, MARKET_MAIN_IMAGE_QUALITY),
            compressForUpload(localPath, MARKET_THUMB_IMAGE_QUALITY)
          ])

          let mainProgress = 0
          let thumbProgress = thumbPath ? 0 : 100
          const updateUploadProgress = () => {
            const weighted = 16 + mainProgress * 0.74 + thumbProgress * 0.10
            this._setAdminImageUploadProgress(Math.min(99, stepBase + stepSize * (weighted / 100)), `上传${labelSuffix}`)
          }

          const [fileID, thumbFID] = await Promise.all([
            uploadOne(mainPath, "market", progress => {
              mainProgress = progress
              updateUploadProgress()
            }),
            thumbPath
              ? uploadOne(thumbPath, "market_thumb", progress => {
                thumbProgress = progress
                updateUploadProgress()
              })
              : Promise.resolve("")
          ])

          if (!fileID) throw new Error("empty_file_id")
          uploaded.push({ localPath, fileID, thumbFID: thumbFID || "" })
        } catch (err) {
          failedCount += 1
          console.error("[marketTrade] admin image upload failed:", err)
        }
      }

      const nextImages = baseImages.concat(uploaded.map(item => item.localPath))
      const nextImageFileIDs = uniqFileIDs(baseImageFileIDs.concat(uploaded.map(item => item.fileID)))
      const nextThumbFileIDs = Array.from(new Set(baseThumbFileIDs.concat(uploaded.map(item => item.thumbFID || "").filter(Boolean))))
      this._setAdminForm({
        ...this.data.adminForm,
        image: nextImages[0] || "",
        images: nextImages,
        imageFileID: nextImageFileIDs[0] || "",
        imageFileIDs: nextImageFileIDs,
        thumbFileID: firstValidFileID(nextThumbFileIDs),
        thumbFileIDs: nextThumbFileIDs,
        imageUploading: false,
        imageUploadProgress: uploaded.length ? 100 : 0,
        imageUploadText: failedCount ? "部分完成" : "已完成"
      })

      if (!uploaded.length) wx.showToast({ title: "上传失败", icon: "none" })
      else if (failedCount) wx.showToast({ title: "部分图片失败", icon: "none" })
      else wx.showToast({ title: "上传成功", icon: "success" })
    } catch (e) {
      if (String(e && e.errMsg || "").toLowerCase().includes("cancel")) return
      console.error(e)
      wx.showToast({ title: "选择/上传失败", icon: "none" })
      this._setAdminForm({
        ...this.data.adminForm,
        imageUploading: false
      })
    }
  },

  onAdminPreviewImage(e) {
    const images = previewImagesFromDraft(this.data.adminForm)
    if (!images.length) return
    const index = Number(e.currentTarget.dataset.index || 0)
    wx.previewImage({
      urls: images,
      current: images[index] || images[0]
    })
  },

  onAdminRemoveImage(e) {
    if (this.data.adminForm.imageUploading) {
      wx.showToast({ title: "图片上传中", icon: "none" })
      return
    }
    const index = Number(e.currentTarget.dataset.index)
    const images = previewImagesFromDraft(this.data.adminForm)
    if (!Number.isInteger(index) || index < 0 || index >= images.length) return
    const imageFileIDs = orderedImageFileIDsFromDraft(this.data.adminForm)
    const thumbFileIDs = orderedThumbFileIDsFromDraft(this.data.adminForm)
    images.splice(index, 1)
    if (index < imageFileIDs.length) imageFileIDs.splice(index, 1)
    if (index < thumbFileIDs.length) thumbFileIDs.splice(index, 1)
    this._setAdminForm({
      ...this.data.adminForm,
      image: images[0] || "",
      images,
      imageFileID: imageFileIDs[0] || "",
      imageFileIDs,
      thumbFileID: firstValidFileID(thumbFileIDs),
      thumbFileIDs
    })
  },

  onAdminChooseLocation() {
    if (typeof wx.chooseLocation !== "function") {
      wx.showToast({ title: "当前版本不支持选点", icon: "none" })
      return
    }
    wx.chooseLocation({
      success: res => {
        const lat = Number(res.latitude)
        const lng = Number(res.longitude)
        const name = normalizeText(res.name)
        const address = normalizeText(res.address)
        const displayName = name || address || "已选择位置"
        const location = {
          displayName,
          name,
          address,
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
          source: "adminChooseLocation",
          provider: "wx.chooseLocation",
          updatedAtMs: Date.now()
        }
        this._setAdminForm({
          ...this.data.adminForm,
          detailAddress: displayName,
          location
        })
      },
      fail: err => {
        const msg = String(err?.errMsg || "")
        if (msg.includes("cancel")) return
        console.error("admin choose location failed:", err)
        wx.showToast({ title: "选点失败", icon: "none" })
      }
    })
  },

  onAdminTemplateNameInput(e) {
    this.setData({ adminTemplateName: e.detail.value })
  },

  async loadAdminTemplates() {
    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "adminListTemplates", limit: 50 }
      })
      const result = getMarketApiResult(res)
      const templates = result.templates || result.data || []
      this.setData({
        adminTemplates: templates,
        adminTemplateIndex: templates.length ? 0 : -1
      })
    } catch (e) {
      console.error("load admin templates failed:", e)
    }
  },

  async onAdminSaveTemplate() {
    const form = this.data.adminForm || {}
    const contactError = (!normalizeText(form.sellerName) || !normalizeText(form.sellerWechat))
      ? "模板需要显示名字和微信号"
      : ""
    if (contactError) {
      wx.showToast({ title: contactError, icon: "none" })
      return
    }
    const name = normalizeText(this.data.adminTemplateName) ||
      normalizeText([form.sellerName, form.buildingName || form.regionArea].filter(Boolean).join(" - ")) ||
      "代发模板"
    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: {
          action: "adminSaveTemplate",
          template: {
            name,
            data: draftToTemplatePayload(form)
          }
        }
      })
      getMarketApiResult(res)
      wx.showToast({ title: "模板已保存", icon: "success" })
      this.setData({ adminTemplateName: name })
      this.loadAdminTemplates()
    } catch (e) {
      console.error("save admin template failed:", e)
      wx.showToast({ title: "模板保存失败", icon: "none" })
    }
  },

  onAdminTemplateChange(e) {
    const index = Number(e.detail.value)
    const template = (this.data.adminTemplates || [])[index]
    if (!template) return
    this.setData({
      adminTemplateIndex: index,
      adminTemplateName: template.name || ""
    })
    this._setAdminForm(templateToDraft(template))
    wx.showToast({ title: "已套用模板", icon: "success" })
  },

  async onAdminDeleteTemplate() {
    const template = (this.data.adminTemplates || [])[this.data.adminTemplateIndex]
    if (!template || !template._id) {
      wx.showToast({ title: "暂无模板", icon: "none" })
      return
    }
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: "删除模板",
        content: `删除模板「${template.name || "未命名"}」？`,
        confirmText: "删除",
        confirmColor: "#E54D42",
        success: res => resolve(!!res.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return
    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "adminDeleteTemplate", id: template._id }
      })
      getMarketApiResult(res)
      wx.showToast({ title: "模板已删除", icon: "success" })
      this.loadAdminTemplates()
    } catch (e) {
      console.error("delete admin template failed:", e)
      wx.showToast({ title: "删除失败", icon: "none" })
    }
  },

  onAdminImportInput(e) {
    this.setData({ adminImportText: e.detail.value })
  },

  onParseAdminImport() {
    const drafts = parseAdminImportText(this.data.adminImportText)
    if (!drafts.length) {
      wx.showToast({ title: "没有识别到数据", icon: "none" })
      return
    }
    this.setData({
      adminDrafts: attachDraftKeys(drafts),
      adminSelectedIndex: 0,
      adminSummaryText: `已导入 ${drafts.length} 条草稿`
    })
    this._setAdminForm(drafts[0])
  },

  onAdminAddDraft() {
    this.setData({ adminSelectedIndex: -1 })
    this._setAdminForm(defaultAdminDraft())
  },

  _saveCurrentDraft(options = {}) {
    const draft = normalizeImportedDraft(this.data.adminForm)
    const error = validateDraft(draft)
    if (error) {
      if (!options.silent) wx.showToast({ title: error, icon: "none" })
      return false
    }
    const list = (this.data.adminDrafts || []).slice()
    const index = Number(this.data.adminSelectedIndex)
    if (index >= 0 && index < list.length) {
      list[index] = draft
    } else {
      list.push(draft)
    }
    const selectedIndex = index >= 0 && index < list.length ? index : list.length - 1
    this.setData({
      adminDrafts: attachDraftKeys(list),
      adminSelectedIndex: selectedIndex,
      adminSummaryText: `草稿 ${list.length} 条`
    })
    this._setAdminForm(list[selectedIndex])
    if (!options.silent) wx.showToast({ title: "已保存草稿", icon: "success" })
    return true
  },

  onAdminSaveDraft() {
    this._saveCurrentDraft()
  },

  onAdminEditDraft(e) {
    const index = Number(e.currentTarget.dataset.index)
    const draft = (this.data.adminDrafts || [])[index]
    if (!draft) return
    this.setData({ adminSelectedIndex: index })
    this._setAdminForm(draft)
  },

  onAdminRemoveDraft(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = attachDraftKeys((this.data.adminDrafts || []).filter((_, i) => i !== index))
    this.setData({
      adminDrafts: list,
      adminSelectedIndex: -1,
      adminSummaryText: `草稿 ${list.length} 条`
    })
    if (list.length) {
      this.setData({ adminSelectedIndex: 0 })
      this._setAdminForm(list[0])
    } else {
      this._setAdminForm(defaultAdminDraft())
    }
  },

  async onAdminPublishDrafts() {
    if (this.data.adminLoading) return
    if (normalizeText(this.data.adminForm.title) || Number(this.data.adminSelectedIndex) >= 0) {
      if (!this._saveCurrentDraft({ silent: true })) {
        wx.showToast({ title: validateDraft(this.data.adminForm) || "请先保存草稿", icon: "none" })
        return
      }
    }
    let drafts = (this.data.adminDrafts || []).slice()
    if (!drafts.length && normalizeText(this.data.adminForm.title)) {
      if (!this._saveCurrentDraft({ silent: true })) {
        wx.showToast({ title: validateDraft(this.data.adminForm) || "请先保存草稿", icon: "none" })
        return
      }
      drafts = (this.data.adminDrafts || []).slice()
    }
    if (!drafts.length) {
      wx.showToast({ title: "请先添加草稿", icon: "none" })
      return
    }

    for (let i = 0; i < drafts.length; i += 1) {
      const error = validateDraft(drafts[i])
      if (error) {
        wx.showToast({ title: `第${i + 1}条：${error}`, icon: "none" })
        return
      }
    }

    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: "批量发布",
        content: `确认发布 ${drafts.length} 条二手/转租？`,
        confirmText: "发布",
        success: res => resolve(!!res.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ adminLoading: true, adminResults: [], adminFailures: [], adminSummaryText: "发布中..." })
    try {
      const items = drafts.map(draftToPayload)
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: {
          action: "adminBulkCreate",
          batchId: `trade_${Date.now()}`,
          items
        }
      })
      const result = getMarketApiResult(res)
      markMarketGoodsChanged()
      this.setData({
        adminResults: result.results || [],
        adminFailures: result.failures || [],
        adminSummaryText: `成功 ${result.success || 0} 条，失败 ${result.failed || 0} 条`
      })
      wx.showToast({ title: result.failed ? "部分失败" : "发布完成", icon: result.failed ? "none" : "success" })
      this.fetchList()
    } catch (e) {
      console.error("admin bulk publish failed", e)
      wx.showToast({ title: "批量发布失败", icon: "none" })
      this.setData({ adminSummaryText: "发布失败" })
    } finally {
      this.setData({ adminLoading: false })
    }
  },

  onOpenPublished(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  onEditPublished(e) {
    const id = e.currentTarget.dataset.id
    const type = e.currentTarget.dataset.type || "goods"
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketPost/marketPost?id=${id}&mode=edit&type=${type}` })
  }
})
